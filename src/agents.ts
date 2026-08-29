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

export type DelegateAgentName = string;
export type DelegateThinkingLevel = (typeof DELEGATE_THINKING_LEVELS)[number];

export interface DelegateProfile {
  readonly name: string;
  readonly description: string;
  readonly model: string | null;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly extensions: readonly string[];
  readonly thinking: DelegateThinkingLevel;
  /** Internal runner name for the configured deadline. */
  readonly timeoutMs: number;
  readonly systemPrompt: string;
}

export type DelegateProfileRegistry = Readonly<Record<string, DelegateProfile>>;

function loadPrompt(name: (typeof DELEGATE_AGENT_NAMES)[number]): string {
  const prompt = readFileSync(new URL(`../agents/${name}.md`, import.meta.url), "utf8");
  if (prompt.trim().length === 0) throw new Error(`Delegate profile ${name} has an empty role prompt`);
  return prompt;
}

export function createDelegateProfile(options: DelegateProfile): DelegateProfile {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Delegate profile ${options.name} has an invalid deadline`);
  }
  if (options.tools.length === 0 || new Set(options.tools).size !== options.tools.length) {
    throw new Error(`Delegate profile ${options.name} has an invalid tool allowlist`);
  }
  return Object.freeze({
    ...options,
    tools: Object.freeze([...options.tools]),
    skills: Object.freeze([...options.skills]),
    extensions: Object.freeze([...options.extensions]),
  });
}

function bundledProfile(
  name: (typeof DELEGATE_AGENT_NAMES)[number],
  description: string,
  tools: readonly string[],
  thinking: DelegateThinkingLevel,
  timeoutMs: number,
): DelegateProfile {
  return createDelegateProfile({
    name,
    description,
    model: null,
    tools,
    skills: [],
    extensions: [],
    thinking,
    timeoutMs,
    systemPrompt: loadPrompt(name),
  });
}

export const SCOUT_PROFILE = bundledProfile(
  "scout",
  "Fast local codebase reconnaissance",
  ["read", "grep", "find", "ls"],
  "low",
  180_000,
);

export const REVIEWER_PROFILE = bundledProfile(
  "reviewer",
  "Fresh-context correctness and maintainability review",
  ["read", "grep", "find", "ls", "bash"],
  "high",
  600_000,
);

export const ORACLE_PROFILE = bundledProfile(
  "oracle",
  "Challenge assumptions and advise on material decisions",
  ["read", "grep", "find", "ls"],
  "high",
  600_000,
);

export const TESTER_PROFILE = bundledProfile(
  "tester",
  "Exercise a feature's real behavior and report evidence",
  ["read", "grep", "find", "ls", "bash"],
  "high",
  1_200_000,
);

export const WORKER_PROFILE = bundledProfile(
  "worker",
  "Implement one clearly bounded task",
  ["read", "grep", "find", "ls", "bash", "edit", "write"],
  "high",
  1_200_000,
);

export const BUNDLED_PROFILES: DelegateProfileRegistry = Object.freeze({
  scout: SCOUT_PROFILE,
  reviewer: REVIEWER_PROFILE,
  oracle: ORACLE_PROFILE,
  tester: TESTER_PROFILE,
  worker: WORKER_PROFILE,
});

export function getDelegateProfile(
  name: string,
  profiles: DelegateProfileRegistry = BUNDLED_PROFILES,
): DelegateProfile {
  if (!Object.hasOwn(profiles, name)) throw new Error(`Unknown delegate agent: ${name}`);
  return profiles[name]!;
}
