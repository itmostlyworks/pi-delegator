import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  DELEGATE_AGENT_NAMES,
  DELEGATE_THINKING_LEVELS,
  getDelegateProfile,
  type DelegateProfile,
  type DelegateThinkingLevel,
} from "./agents.ts";
import {
  loadDelegateDefaults,
  MAX_MODEL_BYTES,
  normalizeModelSelector,
} from "./config.ts";
import type { UsageSummary } from "./protocol.ts";
import {
  runDelegate,
  type CleanupDetails,
  type DelegateFailure,
  type DelegateProgress,
  type DelegateSuccess,
} from "./runner.ts";

export { MAX_MODEL_BYTES } from "./config.ts";
export const MAX_TASK_BYTES = 32 * 1024;
const MAX_PROGRESS_CODEPOINTS = 160;

const DelegateParameters = Type.Object(
  {
    agent: StringEnum(DELEGATE_AGENT_NAMES, {
      description: "Built-in delegate profile to invoke",
    }),
    task: Type.String({
      description: "Focused task for the delegate",
      minLength: 1,
      maxLength: MAX_TASK_BYTES,
    }),
    model: Type.Optional(
      Type.String({
        description: "Pi model selector; defaults to the user's profile default, then the parent session model",
        minLength: 1,
        maxLength: MAX_MODEL_BYTES,
      }),
    ),
    thinking: Type.Optional(
      StringEnum(DELEGATE_THINKING_LEVELS, {
        description: "Pi thinking level; defaults to the user's profile default, then the built-in profile level",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description: "Existing working directory; defaults to the parent Pi cwd",
        minLength: 1,
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        description: "Optional deadline in milliseconds; can only shorten the selected profile deadline",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

export interface DelegateDetails {
  readonly agent: DelegateProfile["name"];
  readonly thinking: DelegateThinkingLevel;
  readonly model?: string;
  readonly durationMs: number;
  readonly usage: UsageSummary;
  readonly truncated: boolean;
  readonly originalBytes?: number;
  readonly malformedLineCount: number;
  readonly exitCode: number | null;
  readonly cleanup: CleanupDetails;
}

function formatFailure(failure: DelegateFailure): string {
  const stderr = failure.stderr.trim();
  const stderrDiagnostic = stderr ? `\nStderr tail:\n${stderr}` : "";
  const cleanupDiagnostic = failure.cleanup.diagnostic
    ? `\nCleanup diagnostic: ${failure.cleanup.diagnostic}`
    : "";
  return `Delegate failed [${failure.code}] after ${failure.durationMs} ms: ${failure.message}${stderrDiagnostic}${cleanupDiagnostic}`;
}

function successDetails(
  result: DelegateSuccess,
  profile: DelegateProfile,
  model: string | undefined,
  thinking: DelegateThinkingLevel,
): DelegateDetails {
  return {
    agent: profile.name,
    thinking,
    ...(model === undefined ? {} : { model }),
    durationMs: result.durationMs,
    usage: result.usage,
    truncated: result.truncated,
    ...(result.originalBytes === undefined ? {} : { originalBytes: result.originalBytes }),
    malformedLineCount: result.malformedLineCount,
    exitCode: result.exitCode,
    cleanup: result.cleanup,
  };
}

function progressDetails(
  profile: DelegateProfile,
  model: string | undefined,
  thinking: DelegateThinkingLevel,
  durationMs: number,
  usage: UsageSummary,
): DelegateDetails {
  return {
    agent: profile.name,
    thinking,
    ...(model === undefined ? {} : { model }),
    durationMs,
    usage,
    truncated: false,
    malformedLineCount: 0,
    exitCode: null,
    cleanup: {
      forced: false,
      termSent: false,
      killSent: false,
      processExited: false,
      pipesClosed: false,
    },
  };
}

function compactText(text: string): string {
  const oneLine = text.replace(/\s+/gu, " ").trim();
  const codepoints = Array.from(oneLine);
  if (codepoints.length <= MAX_PROGRESS_CODEPOINTS) return oneLine;
  return `${codepoints.slice(0, MAX_PROGRESS_CODEPOINTS).join("")}…`;
}

function profileLabel(profile: DelegateProfile): string {
  return `${profile.name.charAt(0).toUpperCase()}${profile.name.slice(1)}`;
}

function formatProgress(profile: DelegateProfile, progress: DelegateProgress): string {
  const label = profileLabel(profile);
  if (progress.type === "tool_start") {
    const toolName = Array.from(progress.toolName).slice(0, 80).join("");
    return `${label} started ${toolName}`;
  }
  const preview = progress.text === undefined ? "" : compactText(progress.text);
  return preview ? `${label}: ${preview}` : `${label} completed an assistant message`;
}

async function resolveWorkingDirectory(requested: string | undefined, parentCwd: string): Promise<string> {
  const cwd = resolve(requested ?? parentCwd);
  let info;
  try {
    info = await stat(cwd);
  } catch {
    throw new Error(`Delegate cwd does not exist: ${cwd}`);
  }
  if (!info.isDirectory()) throw new Error(`Delegate cwd is not a directory: ${cwd}`);
  return cwd;
}

export default function piDelegator(pi: ExtensionAPI): void {
  const configuredDefaults = loadDelegateDefaults();

  pi.registerTool<typeof DelegateParameters, DelegateDetails>({
    name: "delegate",
    label: "Delegate",
    description: "Run one bounded task with a fixed-role Scout, Reviewer, Oracle, or Worker profile in a fresh Pi subprocess; model and thinking may be overridden.",
    promptSnippet: "Delegate one bounded reconnaissance, review, advisory, or implementation task to a fresh context",
    promptGuidelines: [
      "Use delegate when a focused reconnaissance, review, advisory, or implementation task benefits from a fresh bounded context.",
    ],
    parameters: DelegateParameters,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const taskBytes = Buffer.byteLength(params.task, "utf8");
      if (params.task.trim().length === 0) throw new Error("Delegate task must not be blank");
      if (taskBytes > MAX_TASK_BYTES) {
        throw new Error(`Delegate task exceeds the ${MAX_TASK_BYTES}-byte UTF-8 limit`);
      }
      if (
        params.timeoutMs !== undefined &&
        (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs <= 0)
      ) {
        throw new Error("Delegate timeoutMs must be a positive integer");
      }
      const requestedModel =
        params.model === undefined
          ? undefined
          : normalizeModelSelector(params.model, "Delegate model");
      if (
        params.thinking !== undefined &&
        !DELEGATE_THINKING_LEVELS.includes(params.thinking)
      ) {
        throw new Error(`Unknown delegate thinking level: ${String(params.thinking)}`);
      }

      const profile = getDelegateProfile(params.agent);
      const profileDefaults = configuredDefaults[profile.name];
      const cwd = await resolveWorkingDirectory(params.cwd, ctx.cwd);
      const model =
        requestedModel ??
        profileDefaults?.model ??
        (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
      const thinking = params.thinking ?? profileDefaults?.thinking ?? profile.thinking;
      const startedAt = Date.now();
      const result = await runDelegate({
        profile,
        task: params.task,
        cwd,
        ...(model === undefined ? {} : { model }),
        thinking,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        ...(signal === undefined ? {} : { signal }),
        ...(onUpdate === undefined
          ? {}
          : {
              onProgress: (progress: DelegateProgress) => {
                onUpdate({
                  content: [{ type: "text", text: formatProgress(profile, progress) }],
                  details: progressDetails(
                    profile,
                    model,
                    thinking,
                    Date.now() - startedAt,
                    progress.usage,
                  ),
                });
              },
            }),
      });

      if (!result.ok) throw new Error(formatFailure(result));
      return {
        content: [{ type: "text", text: result.text }],
        details: successDetails(result, profile, model, thinking),
      };
    },
  });
}
