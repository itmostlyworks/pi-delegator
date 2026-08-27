import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  DELEGATE_AGENT_NAMES,
  DELEGATE_THINKING_LEVELS,
  type DelegateAgentName,
  type DelegateThinkingLevel,
} from "./agents.ts";

export const DELEGATE_CONFIG_FILENAME = "pi-delegator.json";
export const MAX_CONFIG_BYTES = 16 * 1024;
export const MAX_MODEL_BYTES = 256;

export interface DelegateProfileDefaults {
  readonly model?: string;
  readonly thinking?: DelegateThinkingLevel;
}

export type DelegateDefaults = Readonly<
  Partial<Record<DelegateAgentName, Readonly<DelegateProfileDefaults>>>
>;

const EMPTY_DEFAULTS: DelegateDefaults = Object.freeze({});

function configError(path: string, message: string): Error {
  return new Error(`Invalid pi-delegator config at ${path}: ${message}`);
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

function readBoundedConfig(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    if (!fstatSync(descriptor).isFile()) throw new Error("path must be a regular file");

    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
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

export function loadDelegateDefaults(path = getDelegateConfigPath()): DelegateDefaults {
  let bytes: Buffer;
  try {
    bytes = readBoundedConfig(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_DEFAULTS;
    const reason = error instanceof Error ? error.message : String(error);
    throw configError(path, `file could not be read: ${reason}`);
  }

  if (bytes.byteLength > MAX_CONFIG_BYTES) {
    throw configError(path, `file exceeds the ${MAX_CONFIG_BYTES}-byte limit`);
  }

  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw configError(path, `expected valid UTF-8 JSON: ${reason}`);
  }

  if (!isRecord(parsed)) throw configError(path, "top level must be an object");

  const defaults: Partial<Record<DelegateAgentName, Readonly<DelegateProfileDefaults>>> = {};

  for (const [profileName, value] of Object.entries(parsed)) {
    if (!DELEGATE_AGENT_NAMES.includes(profileName as DelegateAgentName)) {
      throw configError(path, `unknown profile ${JSON.stringify(profileName)}`);
    }
    if (!isRecord(value)) {
      throw configError(path, `profile ${JSON.stringify(profileName)} must be an object`);
    }

    for (const field of Object.keys(value)) {
      if (field !== "model" && field !== "thinking") {
        throw configError(
          path,
          `unknown field ${JSON.stringify(field)} for profile ${JSON.stringify(profileName)}`,
        );
      }
    }

    const profileDefaults: { model?: string; thinking?: DelegateThinkingLevel } = {};
    if (Object.hasOwn(value, "model")) {
      try {
        profileDefaults.model = normalizeModelSelector(
          value.model,
          `profile ${JSON.stringify(profileName)} model`,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw configError(path, reason);
      }
    }
    if (Object.hasOwn(value, "thinking")) {
      if (
        typeof value.thinking !== "string" ||
        !DELEGATE_THINKING_LEVELS.includes(value.thinking as DelegateThinkingLevel)
      ) {
        throw configError(
          path,
          `profile ${JSON.stringify(profileName)} thinking must be one of ${DELEGATE_THINKING_LEVELS.join(", ")}`,
        );
      }
      profileDefaults.thinking = value.thinking as DelegateThinkingLevel;
    }

    defaults[profileName as DelegateAgentName] = Object.freeze(profileDefaults);
  }

  return Object.freeze(defaults);
}
