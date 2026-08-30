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

function stringTokenEnd(text: string, start: number): number | undefined {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === "\"") return index + 1;
  }
  return undefined;
}

function tokenValue(text: string, start: number, end: number): string | undefined {
  try {
    const value: unknown = JSON.parse(text.slice(start, end));
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function afterPropertyColon(text: string, start: number): number | undefined {
  let index = start;
  while (/\s/u.test(text[index] ?? "")) index += 1;
  return text[index] === ":" ? index + 1 : undefined;
}

function directPropertyValueStart(text: string, objectStart: number, property: string): number | undefined {
  let depth = 0;
  for (let index = objectStart; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return undefined;
      continue;
    }
    if (character !== "\"") continue;

    const end = stringTokenEnd(text, index);
    if (end === undefined) return undefined;
    if (depth === 1 && tokenValue(text, index, end) === property) {
      const valueStart = afterPropertyColon(text, end);
      if (valueStart !== undefined) {
        let nonWhitespace = valueStart;
        while (/\s/u.test(text[nonWhitespace] ?? "")) nonWhitespace += 1;
        return nonWhitespace;
      }
    }
    index = end - 1;
  }
  return undefined;
}

function directStringProperty(text: string, objectStart: number, property: string): string | undefined {
  const valueStart = directPropertyValueStart(text, objectStart, property);
  if (valueStart === undefined || text[valueStart] !== "\"") return undefined;
  const end = stringTokenEnd(text, valueStart);
  return end === undefined ? undefined : tokenValue(text, valueStart, end);
}

function isDiscardableOversizedLine(prefix: Buffer): boolean {
  const text = prefix.toString("utf8");
  const objectStart = text.search(/\S/u);
  if (objectStart < 0 || text[objectStart] !== "{") return false;

  const type = directStringProperty(text, objectStart, "type");
  if (type === undefined || type === "agent_settled") return false;
  if (type !== "message_end") return true;

  // Tool results can contain large text or base64 images. They do not carry
  // assistant completion/error authority, so retaining them would only waste
  // bounded parser memory. Assistant messages remain strict because they may
  // contain the terminal answer.
  const messageStart = directPropertyValueStart(text, objectStart, "message");
  return messageStart !== undefined && text[messageStart] === "{"
    && directStringProperty(text, messageStart, "role") === "toolResult";
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
  #discardingOversizedLine = false;

  constructor(options: ProtocolParserOptions = {}) {
    this.#maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_JSONL_BYTES;
    this.#onAssistantMessage = options.onAssistantMessage;
    this.#onToolStart = options.onToolStart;
  }

  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      if (this.#discardingOversizedLine) {
        if (newline === -1) return;
        this.#discardingOversizedLine = false;
        start = newline + 1;
        continue;
      }
      if (newline === -1) {
        this.#append(chunk.subarray(start));
        return;
      }

      this.#append(chunk.subarray(start, newline));
      if (this.#discardingOversizedLine) this.#discardingOversizedLine = false;
      else this.#processPendingLine();
      start = newline + 1;
    }
  }

  finish(): void {
    if (this.#discardingOversizedLine) return;
    if (this.#pending.length > 0) this.#processPendingLine();
  }

  #append(segment: Buffer): void {
    if (segment.length === 0) return;
    const available = this.#maxPendingBytes - this.#pending.length;
    if (segment.length <= available) {
      this.#pending = this.#pending.length === 0 ? Buffer.from(segment) : Buffer.concat([this.#pending, segment]);
      return;
    }

    const boundedPrefix = segment.subarray(0, available);
    const candidate = this.#pending.length === 0
      ? Buffer.from(boundedPrefix)
      : Buffer.concat([this.#pending, boundedPrefix]);
    if (!isDiscardableOversizedLine(candidate)) {
      throw new ProtocolLineTooLargeError(this.#maxPendingBytes);
    }
    this.#pending = Buffer.alloc(0);
    this.#discardingOversizedLine = true;
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
