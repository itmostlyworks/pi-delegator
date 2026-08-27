const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export const MAX_PENDING_JSONL_BYTES = 1024 * 1024;

export interface UsageSummary {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly contextTokens: number;
  readonly turns: number;
}

export interface ProtocolState {
  finalText?: string;
  assistantError?: string;
  stopReason?: string;
  agentSettled: boolean;
  malformedLineCount: number;
  usage: UsageSummary;
}

export class ProtocolLineTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Pi JSONL line exceeded ${maxBytes} bytes`);
    this.name = "ProtocolLineTooLargeError";
    this.maxBytes = maxBytes;
  }
}

interface ProtocolParserOptions {
  maxPendingBytes?: number;
  onAssistantMessage?: (text: string | undefined) => void;
  onToolStart?: (toolName: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function extractAssistantText(message: Record<string, unknown>): string | undefined {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;

  const parts: string[] = [];
  for (const value of message.content) {
    const part = asRecord(value);
    if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function isTerminalStop(stopReason: string | undefined): boolean {
  return stopReason === "stop" || stopReason === "length";
}

function nonnegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function aggregateUsage(current: UsageSummary, message: Record<string, unknown>): UsageSummary {
  const usage = asRecord(message.usage);
  if (!usage) return { ...current, turns: current.turns + 1 };
  const cost = asRecord(usage.cost);
  return {
    input: current.input + nonnegativeNumber(usage.input),
    output: current.output + nonnegativeNumber(usage.output),
    cacheRead: current.cacheRead + nonnegativeNumber(usage.cacheRead),
    cacheWrite: current.cacheWrite + nonnegativeNumber(usage.cacheWrite),
    cost: current.cost + nonnegativeNumber(cost?.total),
    contextTokens:
      typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0
        ? usage.totalTokens
        : current.contextTokens,
    turns: current.turns + 1,
  };
}

export class ProtocolParser {
  readonly state: ProtocolState = {
    agentSettled: false,
    malformedLineCount: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  };

  readonly #maxPendingBytes: number;
  readonly #onAssistantMessage: ((text: string | undefined) => void) | undefined;
  readonly #onToolStart: ((toolName: string) => void) | undefined;
  #pending = Buffer.alloc(0);

  constructor(options: ProtocolParserOptions = {}) {
    this.#maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_JSONL_BYTES;
    this.#onAssistantMessage = options.onAssistantMessage;
    this.#onToolStart = options.onToolStart;
  }

  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      if (newline === -1) {
        this.#append(chunk.subarray(start));
        return;
      }

      this.#append(chunk.subarray(start, newline));
      this.#processPendingLine();
      start = newline + 1;
    }
  }

  finish(): void {
    if (this.#pending.length > 0) this.#processPendingLine();
  }

  #append(segment: Buffer): void {
    if (this.#pending.length + segment.length > this.#maxPendingBytes) {
      throw new ProtocolLineTooLargeError(this.#maxPendingBytes);
    }
    if (segment.length === 0) return;
    this.#pending = this.#pending.length === 0 ? Buffer.from(segment) : Buffer.concat([this.#pending, segment]);
  }

  #processPendingLine(): void {
    let line = this.#pending;
    this.#pending = Buffer.alloc(0);
    if (line.at(-1) === CARRIAGE_RETURN) line = line.subarray(0, -1);
    if (line.length === 0) return;

    let event: unknown;
    try {
      event = JSON.parse(line.toString("utf8"));
    } catch {
      this.state.malformedLineCount += 1;
      return;
    }

    const record = asRecord(event);
    if (!record || typeof record.type !== "string") return;

    if (record.type === "agent_settled") {
      this.state.agentSettled = true;
      return;
    }

    if (record.type === "tool_execution_start") {
      if (typeof record.toolName === "string" && record.toolName.length > 0) this.#onToolStart?.(record.toolName);
      return;
    }

    if (record.type !== "message_end") return;
    const message = asRecord(record.message);
    if (!message || message.role !== "assistant") return;

    this.state.usage = aggregateUsage(this.state.usage, message);
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
    if (stopReason !== undefined) this.state.stopReason = stopReason;

    const text = extractAssistantText(message);
    this.#onAssistantMessage?.(text);

    if (stopReason === "error" || stopReason === "aborted") {
      this.state.assistantError = errorMessage ?? `Assistant stopped with reason: ${stopReason}`;
      return;
    }

    if (text !== undefined && isTerminalStop(stopReason)) this.state.finalText = text;
  }
}
