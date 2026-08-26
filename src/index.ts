import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getDelegateProfile } from "./agents.ts";
import {
  MAX_FINAL_TEXT_BYTES,
  runDelegate,
  type CleanupDetails,
  type DelegateFailure,
  type DelegateSuccess,
} from "./runner.ts";

export const MAX_TASK_BYTES = 32 * 1024;

const DelegateParameters = Type.Object(
  {
    agent: StringEnum(["scout"] as const, {
      description: "Built-in delegate profile to invoke",
    }),
    task: Type.String({
      description: "Focused task for the delegate",
      minLength: 1,
      maxLength: MAX_TASK_BYTES,
    }),
    cwd: Type.Optional(
      Type.String({
        description: "Existing working directory; defaults to the parent Pi cwd",
        minLength: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

export interface DelegateDetails {
  readonly agent: "scout";
  readonly thinking: "low";
  readonly model?: string;
  readonly durationMs: number;
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
  return `Scout delegate failed [${failure.code}] after ${failure.durationMs} ms: ${failure.message}${stderrDiagnostic}${cleanupDiagnostic}`;
}

function successDetails(result: DelegateSuccess, model: string | undefined): DelegateDetails {
  return {
    agent: "scout",
    thinking: "low",
    ...(model === undefined ? {} : { model }),
    durationMs: result.durationMs,
    truncated: result.truncated,
    ...(result.originalBytes === undefined ? {} : { originalBytes: result.originalBytes }),
    malformedLineCount: result.malformedLineCount,
    exitCode: result.exitCode,
    cleanup: result.cleanup,
  };
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
  pi.registerTool<typeof DelegateParameters, DelegateDetails>({
    name: "delegate",
    label: "Delegate",
    description: "Run one bounded Scout task in a fresh, isolated Pi subprocess.",
    promptSnippet: "Delegate focused read-only codebase reconnaissance to a fresh Scout context",
    promptGuidelines: [
      "Use delegate for focused read-only codebase reconnaissance that would otherwise consume substantial parent context.",
    ],
    parameters: DelegateParameters,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const taskBytes = Buffer.byteLength(params.task, "utf8");
      if (params.task.trim().length === 0) throw new Error("Delegate task must not be blank");
      if (taskBytes > MAX_TASK_BYTES) {
        throw new Error(`Delegate task exceeds the ${MAX_TASK_BYTES}-byte UTF-8 limit`);
      }

      const profile = getDelegateProfile(params.agent);
      const cwd = await resolveWorkingDirectory(params.cwd, ctx.cwd);
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const result = await runDelegate({
        profile,
        task: params.task,
        cwd,
        ...(model === undefined ? {} : { model }),
        ...(signal === undefined ? {} : { signal }),
        ...(onUpdate === undefined
          ? {}
          : {
              onAssistantText: (text: string) => {
                onUpdate({
                  content: [{ type: "text", text }],
                  details: {
                    agent: "scout",
                    thinking: "low",
                    ...(model === undefined ? {} : { model }),
                    durationMs: 0,
                    truncated: Buffer.byteLength(text, "utf8") > MAX_FINAL_TEXT_BYTES,
                    malformedLineCount: 0,
                    exitCode: null,
                    cleanup: {
                      forced: false,
                      termSent: false,
                      killSent: false,
                      processExited: false,
                      pipesClosed: false,
                    },
                  },
                });
              },
            }),
      });

      if (!result.ok) throw new Error(formatFailure(result));
      return {
        content: [{ type: "text", text: result.text }],
        details: successDetails(result, model),
      };
    },
  });
}
