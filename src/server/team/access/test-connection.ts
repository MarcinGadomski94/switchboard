import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { type AccessKeyTest, type AccessTestResult, type MaskedSecret, fillTemplate, maskSecrets } from '../../../core/team-access.ts';

/**
 * D100-T2 · **Test connection** of an access (`docs/team.md` → *Access requests*):
 *
 * - an MCP server is started (stdio: `spawn` with `shell: false`, the values in its
 *   environment; http: the URL with its headers) and asked for its tools, within a
 *   time limit; it is stopped right after;
 * - an API key: one `HEAD` (then `GET` when HEAD is refused) to the test URL the
 *   request declared, which is on the declared host (checked when the request was
 *   read and again here); redirects are not followed. No test URL: nothing is sent.
 *
 * Every text that comes back is masked: a server that echoes a value never shows it.
 */

/** A stdio MCP client transport over `spawn(…, { shell: false })` (the SDK's own uses cross-spawn). */
class SpawnStdioTransport implements Transport {
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #cwd: string | undefined;
  readonly #buffer = new ReadBuffer();
  #child: ChildProcessWithoutNullStreams | null = null;
  stderr = '';
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string) {
    this.#command = command;
    this.#args = args;
    this.#env = env;
    this.#cwd = cwd;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#command, [...this.#args], { shell: false, env: this.#env, ...(this.#cwd ? { cwd: this.#cwd } : {}), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.#child = child;
      child.once('error', (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.once('spawn', () => resolve());
      child.once('close', () => {
        this.#child = null;
        this.onclose?.();
      });
      child.stdin.on('error', (error) => this.onerror?.(error));
      child.stdout.on('data', (chunk: Buffer) => {
        this.#buffer.append(chunk);
        for (;;) {
          let message: JSONRPCMessage | null;
          try {
            message = this.#buffer.readMessage();
          } catch (error) {
            this.onerror?.(error as Error);
            continue;
          }
          if (!message) break;
          this.onmessage?.(message);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (this.stderr.length < 4_000) this.stderr += chunk.toString('utf8');
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      if (!this.#child) throw new Error('not connected');
      if (this.#child.stdin.write(serializeMessage(message))) resolve();
      else this.#child.stdin.once('drain', resolve);
    });
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    child.stdin.end();
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    child.kill('SIGTERM');
    await exited;
    clearTimeout(timer);
  }
}

async function listTools(transport: Transport, timeoutMs: number): Promise<string[]> {
  const client = new Client({ name: 'switchboard-access-test', version: '1.0.0' });
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  });
  try {
    await Promise.race([client.connect(transport), limit]);
    const listed = await Promise.race([client.listTools(), limit]);
    return listed.tools.map((tool) => tool.name);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

/** Starts a stdio MCP server with `env` and lists its tools (masked outcome). */
export async function testStdioServer(input: { readonly command: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv; readonly cwd?: string; readonly secrets: readonly MaskedSecret[]; readonly timeoutMs?: number }): Promise<AccessTestResult> {
  const transport = new SpawnStdioTransport(input.command, input.args, input.env, input.cwd);
  try {
    const tools = await listTools(transport, input.timeoutMs ?? 20_000);
    return { ok: true, detail: `Connected: ${tools.length} tool${tools.length === 1 ? '' : 's'}`, tools };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const stderr = transport.stderr.trim().split('\n').slice(-2).join(' ');
    return { ok: false, detail: maskSecrets(`Could not connect: ${reason}${stderr ? ` (${stderr})` : ''}`, input.secrets).slice(0, 500), tools: [] };
  } finally {
    await transport.close().catch(() => undefined);
  }
}

/** Connects to an http MCP server (Streamable HTTP) with `headers` and lists its tools. */
export async function testHttpServer(input: { readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly secrets: readonly MaskedSecret[]; readonly timeoutMs?: number }): Promise<AccessTestResult> {
  const transport = new StreamableHTTPClientTransport(new URL(input.url), { requestInit: { headers: { ...input.headers } } });
  try {
    const tools = await listTools(transport, input.timeoutMs ?? 20_000);
    return { ok: true, detail: `Connected: ${tools.length} tool${tools.length === 1 ? '' : 's'}`, tools };
  } catch (error) {
    return { ok: false, detail: maskSecrets(`Could not connect: ${error instanceof Error ? error.message : String(error)}`, input.secrets).slice(0, 500), tools: [] };
  } finally {
    await transport.close().catch(() => undefined);
  }
}

/**
 * An API key's test: `HEAD` (then `GET` on 405 / 501) to the declared test URL with
 * its header, redirects not followed, 10 s limit. `ok` for any status below 400.
 */
export async function testKey(input: { readonly host: string; readonly test: AccessKeyTest | null; readonly values: Readonly<Record<string, string>>; readonly secrets: readonly MaskedSecret[]; readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number }): Promise<AccessTestResult> {
  if (!input.test) return { ok: false, detail: 'No test URL was declared: nothing to test. The member checks it by using it.', tools: [] };
  const url = new URL(input.test.url);
  if (url.host.toLowerCase() !== input.host) return { ok: false, detail: `The test URL is not on ${input.host}: not sent.`, tools: [] };
  const headers: Record<string, string> = {};
  if (input.test.header) headers[input.test.header.name] = fillTemplate(input.test.header.value, input.values);
  const go = (method: 'HEAD' | 'GET'): Promise<Response> => (input.fetchImpl ?? fetch)(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(input.timeoutMs ?? 10_000) });
  try {
    let response = await go('HEAD');
    if (response.status === 405 || response.status === 501) response = await go('GET');
    await response.body?.cancel().catch(() => undefined);
    const ok = response.status < 400;
    return { ok, detail: `HTTP ${response.status}${ok ? '' : `: ${response.statusText || 'refused'}`} from ${url.host}`, tools: [] };
  } catch (error) {
    return { ok: false, detail: maskSecrets(`Could not reach ${url.host}: ${error instanceof Error ? error.message : String(error)}`, input.secrets).slice(0, 500), tools: [] };
  }
}
