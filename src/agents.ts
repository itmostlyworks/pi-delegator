import { readFileSync } from "node:fs";

export type DelegateAgentName = "scout";
export type DelegateThinkingLevel = "low";

export interface DelegateProfile {
  readonly name: DelegateAgentName;
  readonly description: string;
  readonly tools: readonly string[];
  readonly thinking: DelegateThinkingLevel;
  readonly timeoutMs: number;
  readonly systemPrompt: string;
}

const scoutPrompt = readFileSync(new URL("../agents/scout.md", import.meta.url), "utf8");

export const SCOUT_PROFILE: DelegateProfile = Object.freeze({
  name: "scout",
  description: "Fast local codebase reconnaissance",
  tools: Object.freeze(["read", "grep", "find", "ls"]),
  thinking: "low",
  timeoutMs: 180_000,
  systemPrompt: scoutPrompt,
});

export function getDelegateProfile(name: DelegateAgentName): DelegateProfile {
  if (name === "scout") return SCOUT_PROFILE;
  throw new Error(`Unknown delegate agent: ${String(name)}`);
}
