import { readFileSync } from "node:fs";

export const DELEGATE_AGENT_NAMES = ["scout", "reviewer", "oracle", "tester", "worker"] as const;
export const DELEGATE_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type DelegateAgentName = (typeof DELEGATE_AGENT_NAMES)[number];
export type DelegateThinkingLevel = (typeof DELEGATE_THINKING_LEVELS)[number];

export interface DelegateProfile {
  readonly name: DelegateAgentName;
  readonly description: string;
  readonly tools: readonly string[];
  readonly thinking: DelegateThinkingLevel;
  readonly timeoutMs: number;
  readonly systemPrompt: string;
}

function loadPrompt(name: DelegateAgentName): string {
  const prompt = readFileSync(new URL(`../agents/${name}.md`, import.meta.url), "utf8");
  if (prompt.trim().length === 0) throw new Error(`Delegate profile ${name} has an empty role prompt`);
  return prompt;
}

function profile(
  name: DelegateAgentName,
  description: string,
  tools: readonly string[],
  thinking: DelegateThinkingLevel,
  timeoutMs: number,
): DelegateProfile {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Delegate profile ${name} has an invalid deadline`);
  }
  if (tools.length === 0 || new Set(tools).size !== tools.length) {
    throw new Error(`Delegate profile ${name} has an invalid tool allowlist`);
  }
  return Object.freeze({
    name,
    description,
    tools: Object.freeze([...tools]),
    thinking,
    timeoutMs,
    systemPrompt: loadPrompt(name),
  });
}

export const SCOUT_PROFILE = profile(
  "scout",
  "Fast local codebase reconnaissance",
  ["read", "grep", "find", "ls"],
  "low",
  180_000,
);

export const REVIEWER_PROFILE = profile(
  "reviewer",
  "Fresh-context correctness and maintainability review",
  ["read", "grep", "find", "ls", "bash"],
  "high",
  600_000,
);

export const ORACLE_PROFILE = profile(
  "oracle",
  "Challenge assumptions and advise on material decisions",
  ["read", "grep", "find", "ls"],
  "high",
  600_000,
);

export const TESTER_PROFILE = profile(
  "tester",
  "Exercise a feature's real behavior and report evidence",
  ["read", "grep", "find", "ls", "bash"],
  "high",
  1_200_000,
);

export const WORKER_PROFILE = profile(
  "worker",
  "Implement one clearly bounded task",
  ["read", "grep", "find", "ls", "bash", "edit", "write"],
  "high",
  1_200_000,
);

export function getDelegateProfile(name: DelegateAgentName): DelegateProfile {
  switch (name) {
    case "scout":
      return SCOUT_PROFILE;
    case "reviewer":
      return REVIEWER_PROFILE;
    case "oracle":
      return ORACLE_PROFILE;
    case "tester":
      return TESTER_PROFILE;
    case "worker":
      return WORKER_PROFILE;
    default:
      throw new Error(`Unknown delegate agent: ${String(name)}`);
  }
}
