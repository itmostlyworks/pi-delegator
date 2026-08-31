const MAX_COMMAND_BYTES = 1_024;
const SAFE_EXECUTABLES = new Set([
  "agent-browser",
  "cargo",
  "curl",
  "git",
  "go",
  "make",
  "node",
  "pytest",
  "rg",
  "tsc",
]);
const PACKAGE_RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const SAFE_PACKAGE_ACTIONS = new Set([
  "build",
  "check",
  "format",
  "install",
  "lint",
  "test",
  "typecheck",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Produces a deliberately low-information label for a Bash tool call.
 * The full command and all argument values remain outside the progress text.
 */
export function classifyBashTool(args: unknown): string {
  if (!isRecord(args) || typeof args.command !== "string") return "bash";
  const command = args.command.trim();
  if (command.length === 0 || Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) return "bash";

  // Complex shell syntax makes the effective command unclear. Sensitive markers
  // force the least-informative label even though none of their values would be rendered.
  if (
    /[\0\r\n;&|<>`$]/u.test(command)
    || /(?:^|\s)(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/u.test(command)
    || /\b[a-z][a-z0-9+.-]*:\/\/\S*\?/iu.test(command)
    || /:\/\/[^\s/@:]+:[^\s/@]+@/u.test(command)
    || /(?:authorization|bearer|cookie|credential|password|passwd|secret|token|api[_-]?key)/iu.test(command)
    || /(?:^|\s)(?:-H|--header|-u|--user|-b|--cookie|-d|--data(?:-[a-z-]+)?|-F|--form)(?:\s|=|$)/iu.test(command)
    || /(?:^|\s)-H\S/iu.test(command)
  ) return "bash";

  const tokens = command.split(/\s+/u);
  const executable = tokens[0]!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(executable)) return "bash";

  if (SAFE_EXECUTABLES.has(executable)) return `bash(${executable})`;
  if (!PACKAGE_RUNNERS.has(executable)) return "bash";
  if (tokens.length === 1) return `bash(${executable})`;
  const action = tokens[1]!;
  if (SAFE_PACKAGE_ACTIONS.has(action)) return `bash(${executable} ${action})`;
  return "bash";
}
