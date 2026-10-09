import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMcpExtension,
  getPackageDir,
  type BashOperations,
  type ExtensionAPI,
  type McpTransportFactory,
} from "@earendil-works/pi-coding-agent";
import {
  McpConnectionClosedError,
  type JsonRpcMessage,
  type McpTransport,
  type McpTransportCloseListener,
  type McpTransportErrorListener,
  type McpTransportMessageListener,
  type StdioTransportOptions,
  type StreamableHttpTransportOptions,
} from "@earendil-works/pi-mcp";
import { createDelegateBashOperations } from "./delegate-bash-extension.ts";
import { DELEGATE_CHILD_ENV, DELEGATE_CHILD_ENV_VALUE } from "./delegate-child-contract.ts";
import { DelegateMcpStdioTransport } from "./delegate-mcp-transport.ts";

const MAX_CONFIG_OUTPUT = 1024 * 1024;
let hostMcp: Promise<typeof import("@earendil-works/pi-mcp")> | undefined;

function loadHostMcp(): Promise<typeof import("@earendil-works/pi-mcp")> {
  return hostMcp ??= (async () => {
    // Pi aliases its public API to the host installation when loading extensions.
    // Resolve MCP relative to that API, not this package: native recovery uses
    // instanceof checks, which fail against another installation's constructors.
    const metadataPath = findPackageJSON("@earendil-works/pi-mcp", pathToFileURL(join(getPackageDir(), "package.json")));
    if (!metadataPath) throw new Error("Cannot locate the host Pi MCP library. Use a Node.js Pi 1.1.0+ installation for delegate MCP.");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { exports?: { "."?: { import?: string } } };
    const entry = metadata.exports?.["."]?.import;
    if (typeof entry !== "string" || !entry.startsWith("./")) {
      throw new Error("The host Pi MCP library has no supported public ESM entrypoint. Update your Node.js Pi installation.");
    }
    return await import(pathToFileURL(resolve(dirname(metadataPath), entry)).href) as typeof import("@earendil-works/pi-mcp");
  })();
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

/** Native template semantics, but command execution must remain cancellable. */
async function resolveValue(value: string, description: string, cwd: string, operations: BashOperations, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new McpConnectionClosedError();
  if (value.startsWith("!")) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    try {
      // BashOperations combines stdout/stderr; discard command stderr like Pi's
      // native resolver. The command is intentionally a shell program, not argv.
      const result = await operations.exec(`(\n${value.slice(1)}\n) 2>/dev/null`, cwd, {
        signal, timeout: 10, env: { ...process.env },
        onData(data) {
          bytes += data.length;
          if (bytes > MAX_CONFIG_OUTPUT) overflow = true;
          else chunks.push(Buffer.from(data));
        },
      });
      if (signal.aborted) throw new McpConnectionClosedError();
      const output = Buffer.concat(chunks).toString("utf8").trim();
      if (overflow) throw new Error("command output exceeds 1 MiB");
      if (result.exitCode !== 0) throw new Error(`command exited with ${result.exitCode}`);
      if (!output) throw new Error("command returned empty output");
      return output;
    } catch (error) {
      if (signal.aborted) throw new McpConnectionClosedError();
      throw new Error(`Failed to resolve ${description} from shell command: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const missing = new Set<string>();
  const output = value.replace(/\$(\$|!|\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g, (match, reference: string) => {
    if (reference === "$" || reference === "!") return reference;
    const name = reference.startsWith("{") ? reference.slice(1, -1) : reference;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return match;
    const resolved = process.env[name];
    if (!resolved) missing.add(name);
    return resolved ?? "";
  });
  if (missing.size) throw new Error(`Failed to resolve ${description} from environment variable${missing.size > 1 ? "s" : ""}: ${[...missing].join(", ")}. Set a nonempty value before starting Pi.`);
  return output;
}

/** Own event delegation avoids depending on private Pi transport internals. */
class LazyTransport implements McpTransport {
  private readonly messages = new Set<McpTransportMessageListener>();
  private readonly errors = new Set<McpTransportErrorListener>();
  private readonly closes = new Set<McpTransportCloseListener>();
  private readonly controller = new AbortController();
  private transport?: McpTransport;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private closeEmitted = false;
  private protocolVersion?: string;
  private subscriptions: (() => void)[] = [];

  private readonly create: (signal: AbortSignal) => Promise<McpTransport>;
  constructor(create: (signal: AbortSignal) => Promise<McpTransport>) { this.create = create; }
  onMessage(listener: McpTransportMessageListener): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onError(listener: McpTransportErrorListener): () => void { this.errors.add(listener); return () => this.errors.delete(listener); }
  onClose(listener: McpTransportCloseListener): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
  private notify<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of listeners) { try { listener(value); } catch { /* observers cannot prevent cleanup */ } }
  }
  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.notify(this.closes, undefined);
  }
  get stderr(): string { return (this.transport as McpTransport & { stderr?: string } | undefined)?.stderr ?? ""; }
  setProtocolVersion(version: string): void { this.protocolVersion = version; this.transport?.setProtocolVersion?.(version); }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new McpConnectionClosedError());
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const transport = await this.create(this.controller.signal);
      // No await between the closed check and start: close cannot authorize a
      // late launch while configuration resolution is outstanding.
      if (this.closed) { await transport.close(); throw new McpConnectionClosedError(); }
      this.transport = transport;
      this.subscriptions = [
        transport.onMessage((message) => { if (!this.closed) this.notify(this.messages, message); }),
        transport.onError((error) => { if (!this.closed) this.notify(this.errors, error); }),
        transport.onClose(() => this.emitClose()),
      ];
      if (this.protocolVersion !== undefined) transport.setProtocolVersion?.(this.protocolVersion);
      await transport.start();
      if (this.closed) throw new McpConnectionClosedError();
    })();
    return this.starting;
  }
  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed || !this.transport) throw new McpConnectionClosedError();
    await this.transport.send(message);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Aborting a config command uses BashOperations' terminal failDelegate
    // path; the outer runner cleans the whole session before returning.
    this.controller.abort();
    this.closing = (async () => {
      try {
        // Do not await startup/config resolution. Both real transports own
        // bounded close paths, and unresolved config cannot launch afterward.
        await this.transport?.close();
      } finally {
        for (const unsubscribe of this.subscriptions) unsubscribe();
        this.subscriptions = [];
        this.emitClose();
      }
    })();
    return this.closing;
  }
}

interface FactoryDependencies {
  operations?: BashOperations;
  stdio?: (options: StdioTransportOptions) => McpTransport;
  http?: (options: StreamableHttpTransportOptions) => McpTransport;
}

export function createDelegateMcpTransportFactory(dependencies: FactoryDependencies = {}): McpTransportFactory {
  const operations = dependencies.operations ?? createDelegateBashOperations();
  return (entry, cwd, authProvider) => new LazyTransport(async (signal) => {
    const { config, name } = entry;
    const description = `MCP server "${name}"`;
    const values = async (input: Record<string, string> | undefined, kind: string): Promise<Record<string, string>> => {
      const output: Record<string, string> = {};
      for (const [key, value] of Object.entries(input ?? {})) {
        output[key] = await resolveValue(value, `${description} ${kind} "${key}"`, cwd, operations, signal);
      }
      return output;
    };
    if ("url" in config) {
      // Pi resolves this field inside its OAuth provider, outside our async
      // config resolver. Do not allow its synchronous shell path to bypass
      // command containment; ordinary secrets and env templates still work.
      if (config.oauth?.clientSecret?.startsWith("!")) {
        throw new Error(`${description} oauth.clientSecret cannot use a shell command in a delegate. Set the secret in an environment variable and use \${VARIABLE} instead.`);
      }
      const headers = await values(config.headers, "header");
      if (signal.aborted) throw new McpConnectionClosedError();
      const options: StreamableHttpTransportOptions = {
        url: config.url,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(authProvider ? { authProvider } : {}),
      };
      if (dependencies.http) return dependencies.http(options);
      const { StreamableHttpTransport } = await loadHostMcp();
      if (signal.aborted) throw new McpConnectionClosedError();
      return new StreamableHttpTransport(options);
    }
    const env = await values(config.env, "env");
    if (signal.aborted) throw new McpConnectionClosedError();
    const options: StdioTransportOptions = {
      command: expandHome(config.command), ...(config.args ? { args: config.args.map(expandHome) } : {}),
      cwd: resolve(cwd, expandHome(config.cwd ?? ".")), env, stderr: "pipe",
    };
    return dependencies.stdio?.(options) ?? new DelegateMcpStdioTransport(options);
  });
}

export default function delegateMcpExtension(pi: ExtensionAPI): void {
  if (process.env[DELEGATE_CHILD_ENV] !== DELEGATE_CHILD_ENV_VALUE) return;
  createMcpExtension({ createTransport: createDelegateMcpTransportFactory() })(pi);
}
