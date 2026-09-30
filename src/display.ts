import { relative, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { classifyBashTool } from "./bash-classification.ts";
import type { DelegateProgress } from "./runner.ts";

/** Remove terminal commands and invisible controls; preserve ordinary output line breaks. */
export function terminalSafe(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, "");
}

export function compactDisplayText(text: string, limit: number): string {
  const normalized = terminalSafe(text).replace(/\s+/gu, " ").trim();
  const points = Array.from(normalized);
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : normalized;
}

export interface ProgressSummary {
  totalCalls: number;
  readonly recentTools: string[];
  latestAssistantText?: string;
}

export function toolStartLabel(toolName: string, args: unknown, cwd: string): string {
  if (toolName === "bash") return classifyBashTool(args);
  const name = compactDisplayText(toolName, 12);
  if (!["read", "grep", "find", "ls", "edit", "write"].includes(toolName)) return name;
  const record = typeof args === "object" && args !== null && !Array.isArray(args)
    ? args as Record<string, unknown> : {};
  const path = typeof record.path === "string" && record.path.trim() ? record.path : undefined;
  const target = path === undefined ? undefined : compactDisplayText(relative(cwd, resolve(cwd, path)) || ".", 160);
  const offset = toolName === "read" && Number.isSafeInteger(record.offset) && (record.offset as number) > 0
    ? `:${record.offset}` : "";
  return target ? `${name} ${target}${offset}` : name;
}

export function formatProgress(progress: DelegateProgress, summary: ProgressSummary, cwd: string): string {
  if (progress.type === "tool_start") {
    summary.totalCalls += 1;
    summary.recentTools.push(toolStartLabel(progress.toolName, progress.args, cwd));
    if (summary.recentTools.length > 4) summary.recentTools.shift();
  } else if (progress.text !== undefined) {
    const text = compactDisplayText(progress.text, 240);
    if (text) summary.latestAssistantText = text;
  }
  const heading = summary.totalCalls === 0
    ? "No tool starts yet"
    : `Recent tool starts · ${summary.totalCalls} total${summary.totalCalls > 4 ? ` · ${summary.totalCalls - 4} earlier` : ""}`;
  const rows = summary.recentTools.map((label, index) => `${index === summary.recentTools.length - 1 ? "→" : "·"} ${label}`);
  if (summary.latestAssistantText !== undefined) rows.push("", `Latest commentary: ${summary.latestAssistantText}`);
  return [heading, ...rows].join("\n");
}
