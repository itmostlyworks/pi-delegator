import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  BUNDLED_PROFILES,
  createDelegateProfile,
  DELEGATE_THINKING_LEVELS,
  type DelegateProfile,
  type DelegateProfileRegistry,
  type DelegateThinkingLevel,
} from "./agents.ts";

export const DELEGATE_CONFIG_FILENAME = "pi-delegator.json";
export const MAX_CONFIG_BYTES = 16 * 1024;
export const MAX_MODEL_BYTES = 256;
export const MAX_PROFILE_NAME_BYTES = 64;
export const MAX_DESCRIPTION_BYTES = 512;
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_PROFILE_DEADLINE_MS = 20 * 60 * 1_000;
const PROFILE_FIELDS = [
  "description",
  "model",
  "thinking",
  "prompt",
  "tools",
  "skills",
  "extensions",
  "deadlineMs",
] as const;
const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/u;

function configError(path: string, message: string): Error {
  return new Error(`Invalid pi-delegator config at ${path}: ${message}`);
}

function profileError(path: string, profileName: string, message: string, correction: string): Error {
  return configError(
    path,
    `profile ${JSON.stringify(profileName)} ${message}. Corrective action: ${correction}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeModelSelector(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be blank`);
  if (Buffer.byteLength(value, "utf8") > MAX_MODEL_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_MODEL_BYTES}-byte UTF-8 limit`);
  }
  return normalized;
}

export function getDelegateConfigPath(): string {
  return join(getAgentDir(), DELEGATE_CONFIG_FILENAME);
}

function readBoundedFile(path: string, maximumBytes: number): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    if (!fstatSync(descriptor).isFile()) throw new Error("path must be a regular file");

    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function decodeJson(path: string, bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw configError(
      path,
      `expected valid UTF-8 JSON: ${reason}. Corrective action: use a JSON object containing a "profiles" map`,
    );
  }
}

function requiredString(
  path: string,
  profileName: string,
  field: "description" | "prompt",
  value: unknown,
  maximumBytes?: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw profileError(path, profileName, `${field} must be a non-blank string`, `set ${field} to a non-empty string`);
  }
  if (maximumBytes !== undefined && Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw profileError(path, profileName, `${field} exceeds the ${maximumBytes}-byte UTF-8 limit`, `shorten ${field}`);
  }
  return value.trim();
}

function validateProfileName(path: string, profileName: string): void {
  if (
    !PROFILE_NAME_PATTERN.test(profileName) ||
    Buffer.byteLength(profileName, "utf8") > MAX_PROFILE_NAME_BYTES
  ) {
    throw profileError(
      path,
      profileName,
      `name must match ${PROFILE_NAME_PATTERN} within ${MAX_PROFILE_NAME_BYTES} UTF-8 bytes`,
      "use a lowercase name beginning with a letter and containing only letters, digits, underscores, or hyphens",
    );
  }
}

function validateEmptyCapabilities(
  path: string,
  profileName: string,
  field: "skills" | "extensions",
  value: unknown,
): readonly [] {
  if (!Array.isArray(value) || value.length !== 0) {
    throw profileError(
      path,
      profileName,
      `${field} must be an empty array in this release`,
      `set ${field} to []; explicit capability loading is introduced separately`,
    );
  }
  return Object.freeze([]);
}

function loadPrompt(path: string, profileName: string, configuredPath: unknown): string {
  const promptSetting = requiredString(path, profileName, "prompt", configuredPath);
  const promptPath = isAbsolute(promptSetting)
    ? promptSetting
    : resolve(dirname(path), promptSetting);
  if (extname(promptPath).toLowerCase() !== ".md") {
    throw profileError(path, profileName, `prompt must identify a Markdown file (resolved ${promptPath})`, "point prompt to a non-empty .md file");
  }

  let bytes: Buffer;
  try {
    bytes = readBoundedFile(promptPath, MAX_PROMPT_BYTES);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw profileError(path, profileName, `prompt ${promptPath} could not be read: ${reason}`, "point prompt to a readable regular Markdown file");
  }
  if (bytes.byteLength > MAX_PROMPT_BYTES) {
    throw profileError(path, profileName, `prompt ${promptPath} exceeds the ${MAX_PROMPT_BYTES}-byte limit`, "shorten the prompt file");
  }

  let prompt: string;
  try {
    prompt = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw profileError(path, profileName, `prompt ${promptPath} is not valid UTF-8`, "save the prompt as UTF-8 Markdown");
  }
  if (prompt.trim().length === 0) {
    throw profileError(path, profileName, `prompt ${promptPath} is empty`, "add a non-empty role prompt");
  }
  return prompt;
}

function parseTools(path: string, profileName: string, value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw profileError(path, profileName, "tools must be a non-empty array", "provide a non-empty list of tool names");
  }
  const tools: string[] = [];
  for (const tool of value) {
    if (
      typeof tool !== "string" ||
      !TOOL_NAME_PATTERN.test(tool) ||
      Buffer.byteLength(tool, "utf8") > MAX_PROFILE_NAME_BYTES
    ) {
      throw profileError(path, profileName, `tools contains invalid name ${JSON.stringify(tool)}`, "use bounded tool names containing letters, digits, underscores, or hyphens");
    }
    if (tool === "delegate") {
      throw profileError(path, profileName, "tools may not include delegate because nested delegation is forbidden", "remove delegate from tools");
    }
    if (tools.includes(tool)) {
      throw profileError(path, profileName, `tools contains duplicate ${JSON.stringify(tool)}`, "remove duplicate tool names");
    }
    tools.push(tool);
  }
  return Object.freeze(tools);
}

function parseProfile(path: string, profileName: string, value: unknown): DelegateProfile {
  if (!isRecord(value)) {
    throw profileError(path, profileName, "must be null or a complete object", "use null to disable it or provide every required profile field");
  }
  for (const field of Object.keys(value)) {
    if (!PROFILE_FIELDS.includes(field as (typeof PROFILE_FIELDS)[number])) {
      throw profileError(path, profileName, `has unknown field ${JSON.stringify(field)}`, `remove ${JSON.stringify(field)} and provide only ${PROFILE_FIELDS.join(", ")}`);
    }
  }
  for (const field of PROFILE_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      throw profileError(path, profileName, `is incomplete; missing ${JSON.stringify(field)}`, `provide the complete fields ${PROFILE_FIELDS.join(", ")}`);
    }
  }

  const description = requiredString(path, profileName, "description", value.description, MAX_DESCRIPTION_BYTES);
  let model: string | null;
  if (value.model === null) model = null;
  else {
    try {
      model = normalizeModelSelector(value.model, `profile ${JSON.stringify(profileName)} model`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw profileError(path, profileName, reason, "set model to null or a bounded non-blank Pi provider/model selector");
    }
  }
  if (
    typeof value.thinking !== "string" ||
    !DELEGATE_THINKING_LEVELS.includes(value.thinking as DelegateThinkingLevel)
  ) {
    throw profileError(path, profileName, `thinking must be one of ${DELEGATE_THINKING_LEVELS.join(", ")}`, "choose a supported thinking level");
  }
  if (
    !Number.isSafeInteger(value.deadlineMs) ||
    (value.deadlineMs as number) <= 0 ||
    (value.deadlineMs as number) > MAX_PROFILE_DEADLINE_MS
  ) {
    throw profileError(path, profileName, `deadlineMs must be a positive integer no greater than ${MAX_PROFILE_DEADLINE_MS}`, "choose a bounded deadline within the package ceiling");
  }

  return createDelegateProfile({
    name: profileName,
    description,
    model,
    thinking: value.thinking as DelegateThinkingLevel,
    systemPrompt: loadPrompt(path, profileName, value.prompt),
    tools: parseTools(path, profileName, value.tools),
    skills: validateEmptyCapabilities(path, profileName, "skills", value.skills),
    extensions: validateEmptyCapabilities(path, profileName, "extensions", value.extensions),
    timeoutMs: value.deadlineMs as number,
  });
}

export function loadDelegateProfiles(path = getDelegateConfigPath()): DelegateProfileRegistry {
  let bytes: Buffer;
  try {
    bytes = readBoundedFile(path, MAX_CONFIG_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return BUNDLED_PROFILES;
    const reason = error instanceof Error ? error.message : String(error);
    throw configError(path, `file could not be read: ${reason}. Corrective action: provide a readable regular JSON file or remove it`);
  }
  if (bytes.byteLength > MAX_CONFIG_BYTES) {
    throw configError(path, `file exceeds the ${MAX_CONFIG_BYTES}-byte limit. Corrective action: reduce the profile document size`);
  }

  const parsed = decodeJson(path, bytes);
  if (!isRecord(parsed)) {
    throw configError(path, "top level must be an object. Corrective action: use {\"profiles\":{...}}");
  }
  const rootFields = Object.keys(parsed);
  if (!Object.hasOwn(parsed, "profiles")) {
    throw configError(path, "legacy or incomplete format detected. Corrective action: replace it with {\"profiles\":{\"name\":null or a complete profile definition}}");
  }
  if (rootFields.length !== 1) {
    const unexpected = rootFields.filter((field) => field !== "profiles");
    throw configError(path, `unknown top-level field(s) ${unexpected.map((field) => JSON.stringify(field)).join(", ")}. Corrective action: keep only the "profiles" map`);
  }
  if (!isRecord(parsed.profiles)) {
    throw configError(path, '"profiles" must be an object. Corrective action: map each profile name to null or a complete profile definition');
  }

  const effective: Record<string, DelegateProfile> = { ...BUNDLED_PROFILES };
  for (const [profileName, value] of Object.entries(parsed.profiles)) {
    validateProfileName(path, profileName);
    if (value === null) delete effective[profileName];
    else effective[profileName] = parseProfile(path, profileName, value);
  }
  return Object.freeze(effective);
}
