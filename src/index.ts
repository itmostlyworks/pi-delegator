import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { compactDisplayText, formatProgress, renderProgress, terminalSafe, type ProgressSummary } from "./display.ts";
import {
  getDelegateProfile,
  profileLabel,
  type DelegateProfile,
  type DelegateProfileRegistry,
  type DelegateThinkingLevel,
} from "./agents.ts";
import {
  getProjectDelegateConfigPath,
  loadDelegateConfig,
  MAX_MODEL_BYTES,
  normalizeModelSelector,
} from "./config.ts";
import type { UsageSummary } from "./protocol.ts";
import { BackgroundRuns } from "./background.ts";
import { DelegateStatus } from "./status.ts";
import {
  runDelegate,
  type CleanupDetails,
  type DelegateFailure,
  type DelegateProgress,
  type DelegateSuccess,
} from "./runner.ts";

export { MAX_MODEL_BYTES } from "./config.ts";
export const MAX_TASK_BYTES = 32 * 1024;
const MAX_COLLAPSED_RESULT_LINES = 10;
const MAX_COLLAPSED_RESULT_CODEPOINTS = 1_000;

function createDelegateParameters(profiles: DelegateProfileRegistry, background: boolean) {
  const names = Object.keys(profiles);
  const descriptions = names
    .map((name) => `${name}: ${profiles[name]!.description}`)
    .join("; ");
  const fields = {
      agent: StringEnum(names, {
        description: descriptions.length === 0
          ? "No delegate profiles are currently enabled"
          : `Effective delegate profile to invoke. ${descriptions}`,
      }),
      task: Type.String({
        description: "Focused task for the delegate",
        minLength: 1,
        maxLength: MAX_TASK_BYTES,
      }),
      model: Type.Optional(
        Type.String({
          description: "Pi model selector; defaults to the selected profile, then the parent session model",
          minLength: 1,
          maxLength: MAX_MODEL_BYTES,
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Existing working directory; defaults to the parent Pi cwd",
          minLength: 1,
        }),
      ),
  };
  const foreground = Type.Object(fields, { additionalProperties: false });
  return background
    ? Type.Object({
        ...fields,
        agent: Type.Optional(fields.agent),
        task: Type.Optional(fields.task),
        action: Type.Optional(StringEnum(["run", "start", "wait"])),
        runId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      }, { additionalProperties: false })
    : foreground;
}

type BackgroundOutcome =
  | { readonly result: Awaited<ReturnType<typeof runDelegate>>; readonly profile: DelegateProfile; readonly model: string | undefined }
  | { readonly error: string; readonly profile: DelegateProfile; readonly model: string | undefined };

interface BackgroundMetadata {
  readonly toolCallId: string;
  readonly profile: DelegateProfile;
  readonly model: string | undefined;
  readonly startedAt: number;
  readonly progress: ProgressSummary;
  activity: string;
  usage: UsageSummary;
}

interface StartCardState {
  observing?: boolean;
  summary?: { status: "Completed" | "Failed"; durationMs: number };
}

export interface DelegateDetails {
  readonly agent: DelegateProfile["name"];
  readonly displayName?: string;
  readonly thinking: DelegateThinkingLevel;
  readonly model?: string;
  readonly durationMs: number;
  readonly usage: UsageSummary;
  readonly truncated: boolean;
  readonly originalBytes?: number;
  readonly expandedProgress?: string;
  readonly malformedLineCount: number;
  readonly exitCode: number | null;
  readonly cleanup: CleanupDetails;
  readonly runId?: string;
  readonly backgroundStatus?: "started" | "waiting" | "completed" | "failed";
  readonly taskPreview?: string;
}

interface BackgroundFailureDetails {
  readonly runId: string;
  readonly agent: string;
  readonly displayName?: string;
  readonly diagnostic: string;
}

function runBadge(runId: string): string {
  return /^run-[1-9][0-9]*$/u.test(runId) ? `#${runId.slice(4)}` : compactDisplayText(runId, 64);
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
    ...(profile.displayName === undefined ? {} : { displayName: profile.displayName }),
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
    ...(profile.displayName === undefined ? {} : { displayName: profile.displayName }),
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

function compactModelSelector(model: string): string {
  const separator = model.indexOf("/");
  return separator === -1 ? model : model.slice(separator + 1);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${Math.round(durationMs / 100) / 10}s`;
}

function resultText(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content
    .filter((item): item is { readonly type: "text"; readonly text: string } =>
      item.type === "text" && typeof item.text === "string"
    )
    .map((item) => item.text)
    .join("\n");
}

function formatRenderedOutput(output: string, expanded: boolean, theme: Theme): string {
  if (!output) return "";
  const lines = terminalSafe(output).split(/\r\n?|\n/u);
  if (expanded) return lines.map((line) => theme.fg("toolOutput", line)).join("\n");

  const displayed = lines.slice(0, MAX_COLLAPSED_RESULT_LINES);
  const previewCodepoints = Array.from(displayed.join("\n"));
  const previewTruncated = previewCodepoints.length > MAX_COLLAPSED_RESULT_CODEPOINTS;
  const preview = previewTruncated
    ? `${previewCodepoints.slice(0, MAX_COLLAPSED_RESULT_CODEPOINTS).join("")}…`
    : previewCodepoints.join("");
  let rendered = preview.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n");
  const remaining = lines.length - displayed.length;
  if (previewTruncated) {
    rendered += theme.fg("muted", "\n… (preview truncated; expand to view)");
  } else if (remaining > 0) {
    rendered += theme.fg("muted", `\n… (${remaining} more lines; expand to view)`);
  }
  return rendered;
}

function formatRenderedResult(
  content: readonly { readonly type: string; readonly text?: string }[],
  details: DelegateDetails,
  expanded: boolean,
  isPartial: boolean,
  theme: Theme,
): string {
  const model = details.model === undefined
    ? "default model"
    : expanded
      ? details.model
      : compactModelSelector(details.model);
  let header =
    theme.fg("toolTitle", theme.bold(compactDisplayText(profileLabel(details.agent, details.displayName), 64)));
  header += theme.fg("muted", ` · ${compactDisplayText(model, 256)} · ${compactDisplayText(details.thinking, 32)} · ${formatDuration(details.durationMs)}${isPartial ? " · Running" : details.backgroundStatus === "failed" ? " · Failed" : details.backgroundStatus === "completed" ? " · Completed" : ""}`);
  let renderedText = resultText(content);
  if (details.backgroundStatus === "failed" && details.runId !== undefined) {
    const prefix = `${profileLabel(details.agent, details.displayName)} · ${runBadge(details.runId)} · `;
    if (renderedText.startsWith(prefix)) renderedText = renderedText.slice(prefix.length);
  }
  const output = formatRenderedOutput(
    expanded && isPartial && details.expandedProgress !== undefined
      ? details.expandedProgress
      : renderedText,
    expanded || isPartial,
    theme,
  );
  return header + (output ? `\n${output}` : "");
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

function registerDelegateTool(
  pi: ExtensionAPI,
  profiles: DelegateProfileRegistry,
  recordFailedUsage: (toolCallId: string, usage: Usage, details?: DelegateDetails) => void,
  background: boolean,
  runs: BackgroundRuns<BackgroundOutcome, BackgroundMetadata>,
  status: DelegateStatus,
): void {
  const DelegateParameters = createDelegateParameters(profiles, background);
  const profileSummary = Object.values(profiles)
    .map((profile) => `${profile.name} (${profile.description})`)
    .join(", ");

  pi.registerTool<typeof DelegateParameters, DelegateDetails | undefined>({
    name: "delegate",
    label: "Delegate",
    description: profileSummary.length === 0
      ? "No delegate profiles are currently enabled."
      : `Run one bounded task in a fresh Pi subprocess using an effective profile: ${profileSummary}. The model may be overridden per call.${background ? ' Optional action "start" returns a session-owned runId immediately; action "wait" with runId collects it once. Omitted action (or "run") stays foreground. Cancelling wait leaves the run owned by this session.' : ""}`,
    promptSnippet: "Delegate one bounded reconnaissance, review, advisory, behavioral verification, or implementation task to a fresh context",
    promptGuidelines: [
      "Use delegate when a focused reconnaissance, review, advisory, behavioral verification, or implementation task benefits from a fresh bounded context.",
    ],
    parameters: DelegateParameters,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = "action" in params ? params.action ?? "run" : "run";
      if (action !== "run" && !background) throw new Error("Background delegation is disabled; enable background in pi-delegator.json");
      if (action === "wait") {
        if (!("runId" in params) || typeof params.runId !== "string" || !params.runId.trim()) {
          throw new Error("Delegate wait requires runId");
        }
        if (params.agent !== undefined || params.task !== undefined || params.model !== undefined || params.cwd !== undefined) {
          throw new Error("Delegate wait accepts only action and runId");
        }
        const runId = params.runId;
        const outcome = await runs.wait(params.runId, signal, onUpdate === undefined ? undefined : (metadata) => {
          if (metadata === undefined) return;
          try {
            onUpdate({
              content: [{ type: "text", text: metadata.activity }],
              details: {
                ...progressDetails(metadata.profile, metadata.model, metadata.profile.thinking, Math.max(0, Date.now() - metadata.startedAt), metadata.usage),
                expandedProgress: renderProgress(metadata.progress, true),
                runId,
                backgroundStatus: "waiting",
              },
            });
          } catch { /* Display observers must never affect lifecycle. */ }
        });
        if ("error" in outcome) throw new Error(`${profileLabel(outcome.profile.name, outcome.profile.displayName)} · ${runBadge(params.runId)} · Failed: ${outcome.error}`);
        const { result, profile, model } = outcome;
        if (!result.ok) {
          recordFailedUsage(toolCallId, result.nativeUsage, {
            ...progressDetails(profile, model, profile.thinking, result.durationMs, {
              input: result.nativeUsage.input,
              output: result.nativeUsage.output,
              cacheRead: result.nativeUsage.cacheRead,
              cacheWrite: result.nativeUsage.cacheWrite,
              cost: result.nativeUsage.cost.total,
              contextTokens: 0,
              turns: 0,
            }),
            cleanup: result.cleanup,
            malformedLineCount: result.malformedLineCount,
            exitCode: result.exitCode,
            runId: params.runId,
            backgroundStatus: "failed",
          });
          throw new Error(`${profileLabel(profile.name, profile.displayName)} · ${runBadge(params.runId)} · ${formatFailure(result)}`);
        }
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: { ...successDetails(result, profile, model, profile.thinking), runId: params.runId, backgroundStatus: "completed" as const },
          usage: result.nativeUsage,
        };
      }
      if (action !== "run" && action !== "start") throw new Error("Unknown delegate action");
      if ("runId" in params && params.runId !== undefined) throw new Error("runId is only valid for delegate wait");
      if (typeof params.agent !== "string" || typeof params.task !== "string") {
        throw new Error("Delegate run/start requires agent and task");
      }
      const task = params.task;
      const taskBytes = Buffer.byteLength(task, "utf8");
      if (params.task.trim().length === 0) throw new Error("Delegate task must not be blank");
      if (taskBytes > MAX_TASK_BYTES) {
        throw new Error(`Delegate task exceeds the ${MAX_TASK_BYTES}-byte UTF-8 limit`);
      }
      const requestedModel =
        params.model === undefined
          ? undefined
          : normalizeModelSelector(params.model, "Delegate model");
      const profile = getDelegateProfile(params.agent, profiles);
      const cwd = await resolveWorkingDirectory(params.cwd, ctx.cwd);
      const model =
        requestedModel ??
        profile.model ??
        (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
      const thinking = profile.thinking;
      if (action === "start") {
        if (signal?.aborted) throw new Error("Delegate start cancelled");
        const metadata: BackgroundMetadata = {
          toolCallId, profile, model, startedAt: Date.now(),
          progress: { totalCalls: 0, recentTools: [] },
          activity: "No tool starts yet",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        };
        const runId = runs.start(async (ownedSignal): Promise<BackgroundOutcome> => {
          const finishStatus = ownedSignal.aborted ? () => {} : status.begin(profile.name, ctx);
          try {
            const result = await runDelegate({
              profile, task, cwd,
              ...(model === undefined ? {} : { model }),
              signal: ownedSignal,
              onProgress: (progress) => {
                metadata.activity = formatProgress(progress, metadata.progress, cwd);
                metadata.usage = progress.usage;
              },
            });
            return { result, profile, model };
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error), profile, model };
          } finally {
            finishStatus();
          }
        }, metadata);
        return {
          content: [{ type: "text" as const, text: `Started background delegate ${runId}. Collect with delegate({action: "wait", runId: "${runId}"}).` }],
          details: {
            ...progressDetails(profile, model, thinking, 0, {
              input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0,
            }),
            runId,
            backgroundStatus: "started" as const,
            taskPreview: (() => {
              const codepoints = Array.from(terminalSafe(task));
              return codepoints.slice(0, 240).join("") + (codepoints.length > 240 ? "…" : "");
            })(),
          },
        };
      }
      const startedAt = Date.now();
      const progressSummary: ProgressSummary = { totalCalls: 0, recentTools: [] };
      let latestText = "No tool starts yet";
      let latestUsage: UsageSummary = {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0,
      };
      const publishUpdate = () => {
        const now = Date.now();
        try {
          onUpdate?.({
            content: [{ type: "text", text: latestText }],
            details: {
              ...progressDetails(profile, model, thinking, now - startedAt, latestUsage),
              expandedProgress: renderProgress(progressSummary, true),
            },
          });
        } catch {
          // Display observers must never affect the delegate lifecycle.
        }
      };
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let result: Awaited<ReturnType<typeof runDelegate>>;
      const finishStatus = signal?.aborted ? () => {} : status.begin(profile.name, ctx);
      try {
        if (onUpdate !== undefined) {
          publishUpdate();
          heartbeat = setInterval(publishUpdate, 1_000);
          heartbeat.unref();
        }
        result = await runDelegate({
          profile,
          task: params.task,
          cwd,
          ...(model === undefined ? {} : { model }),
          ...(signal === undefined ? {} : { signal }),
          ...(onUpdate === undefined
            ? {}
            : {
                onProgress: (progress: DelegateProgress) => {
                  latestText = formatProgress(progress, progressSummary, cwd);
                  // Coalesce events until the next tick to keep rendering on a steady cadence.
                  latestUsage = progress.usage;
                },
              }),
        });
      } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        finishStatus();
      }

      if (!result.ok) {
        recordFailedUsage(toolCallId, result.nativeUsage);
        throw new Error(formatFailure(result));
      }
      return {
        content: [{ type: "text", text: result.text }],
        details: successDetails(result, profile, model, thinking),
        usage: result.nativeUsage,
      };
    },

    renderCall(args, theme, context) {
      if ("runId" in args) {
        return new Text(theme.fg("toolTitle", theme.bold("Delegate · Wait")) + theme.fg("muted", ` · ${compactDisplayText(String(args.runId), 64)}`) + "\n", 0, 0);
      }
      const task = typeof args.task === "string"
        ? context.expanded ? terminalSafe(args.task) : compactDisplayText(args.task, 240)
        : "…";
      const name = typeof args.agent === "string" ? args.agent : undefined;
      const profile = name !== undefined && Object.hasOwn(profiles, name) ? profiles[name] : undefined;
      const title = name === undefined
        ? "Delegate"
        : `Delegate · ${compactDisplayText(profileLabel(name, profile?.displayName), 64)}`;
      return new Text(theme.fg("toolTitle", theme.bold(title + ("action" in args && args.action === "start" ? " · Start" : ""))) + "\n" + theme.fg("toolOutput", task) + "\n", 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = result.details as DelegateDetails | undefined;
      if (details?.backgroundStatus === "started" && details.runId !== undefined) {
        // Renderer state belongs to this card, not an unbounded session-side map.
        // Keep only a compact terminal summary after collection, never the answer.
        const state = context.state as StartCardState | undefined;
        const runId = details.runId;
        // Historical calls must not bind to a different call's session-local run ID.
        const candidate = runs.snapshot(runId);
        const snapshot = candidate?.metadata?.toolCallId === context.toolCallId ? candidate : undefined;
        const saveSummary = (value: BackgroundOutcome | undefined) => {
          if (!state || !value) return;
          state.summary = {
            status: "error" in value || !value.result.ok ? "Failed" : "Completed",
            durationMs: "error" in value ? Math.max(0, Date.now() - (snapshot?.metadata?.startedAt ?? Date.now())) : value.result.durationMs,
          };
        };
        if (snapshot?.settled) saveSummary(snapshot.value);
        if (state && snapshot && !snapshot.settled && !state.observing && typeof context.invalidate === "function") {
          state.observing = true;
          runs.observe(runId, (next) => {
            if (next.settled) saveSummary(next.value);
            if (next.settled || runs.snapshot(runId) === undefined) delete state.observing;
            context.invalidate();
          });
        }
        const label = compactDisplayText(profileLabel(details.agent, details.displayName), 64);
        const summary = state?.summary;
        const metadata = snapshot?.metadata;
        const running = snapshot !== undefined && !snapshot.settled;
        const status = summary?.status ?? (snapshot?.settled ? (snapshot.value && ("error" in snapshot.value || !snapshot.value.result.ok) ? "Failed" : "Completed") : running ? "Started" : "Started (inactive)");
        const duration = summary?.durationMs ?? (metadata ? Math.max(0, Date.now() - metadata.startedAt) : details.durationMs);
        const model = details.model === undefined ? "default model" : expanded ? details.model : compactModelSelector(details.model);
        let text = theme.fg("toolTitle", theme.bold(label))
          + theme.fg("muted", ` · ${compactDisplayText(model, 256)} · ${compactDisplayText(details.thinking, 32)}`);
        text += theme.fg("muted", ` · ${status}${summary || snapshot?.settled ? ` · ${formatDuration(duration)}` : ""}`);
        return new Text(text, 0, 0);
      }
      const text = details === undefined
        ? formatRenderedOutput(resultText(result.content), expanded, theme)
        : formatRenderedResult(result.content, details, expanded, isPartial, theme);
      return new Text(text, 0, 0);
    },
  });
}

export default function piDelegator(pi: ExtensionAPI): void {
  const userConfig = loadDelegateConfig();
  let runs: BackgroundRuns<BackgroundOutcome, BackgroundMetadata> | undefined;
  let status: DelegateStatus | undefined;
  const failedUsageByToolCallId = new Map<string, { usage: Usage; details?: DelegateDetails }>();

  pi.registerMessageRenderer<BackgroundFailureDetails>("pi-delegator-failure", (message, { expanded }, theme) => {
    const details = message.details;
    if (!details) return new Text(formatRenderedOutput(resultText(typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content), expanded, theme), 0, 0);
    const title = `${compactDisplayText(profileLabel(details.agent, details.displayName), 64)} · ${compactDisplayText(details.runId, 64)} · Failed`;
    return new Text(theme.fg("error", theme.bold(title)) + "\n" + formatRenderedOutput(details.diagnostic, expanded, theme), 0, 0);
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "delegate") return;
    const failure = failedUsageByToolCallId.get(event.toolCallId);
    if (failure === undefined) return;
    failedUsageByToolCallId.delete(event.toolCallId);
    return {
      usage: { ...failure.usage, cost: { ...failure.usage.cost } },
      ...(failure.details === undefined ? {} : { details: failure.details }),
    };
  });

  const closeRuns = async () => {
    const closingStatus = status;
    await runs?.close();
    closingStatus?.dispose();
    failedUsageByToolCallId.clear();
  };
  pi.on("session_shutdown", closeRuns);
  const cancelRuns = async () => { await runs?.cancelAll(); };
  pi.on("session_before_switch", cancelRuns);
  pi.on("session_before_fork", cancelRuns);
  pi.on("session_before_tree", cancelRuns);

  pi.on("session_start", async (_event, ctx) => {
    status?.dispose();
    if (runs !== undefined) await runs.close();
    status = new DelegateStatus(ctx);
    const config = ctx.isProjectTrusted()
      ? loadDelegateConfig(getProjectDelegateConfigPath(ctx.cwd), userConfig)
      : userConfig;
    runs = new BackgroundRuns(
      (outcome) => "error" in outcome || !outcome.result.ok,
      (runId, outcome) => {
        const diagnostic = "error" in outcome
          ? compactDisplayText(outcome.error, 1_000)
          : outcome.result.ok ? "" : `[${outcome.result.code}] ${compactDisplayText(outcome.result.message + (outcome.result.cleanup.diagnostic ? ` Cleanup: ${outcome.result.cleanup.diagnostic}` : ""), 1_000)}`;
        pi.sendMessage({
          customType: "pi-delegator-failure",
          content: `${compactDisplayText(profileLabel(outcome.profile.name, outcome.profile.displayName), 64)} · ${runId} · Failed\nUncollected background delegate ${runId}: ${diagnostic}.`,
          display: true,
          details: {
            runId,
            agent: outcome.profile.name,
            ...(outcome.profile.displayName === undefined ? {} : { displayName: outcome.profile.displayName }),
            diagnostic,
          } satisfies BackgroundFailureDetails,
        }, { triggerTurn: false });
      },
      (outcome) => "error" in outcome || (!outcome.result.ok && (
        outcome.result.code !== "cancelled" || Boolean(outcome.result.cleanup.diagnostic)
      )),
    );
    registerDelegateTool(pi, config.profiles, (toolCallId, usage, details) => {
      failedUsageByToolCallId.set(toolCallId, { usage, ...(details === undefined ? {} : { details }) });
    }, config.background, runs, status);
  });
}
