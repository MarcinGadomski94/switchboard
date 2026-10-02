/**
 * Switchboard's hook script (D48 P4, `docs/peers.md` → *Hooked terminal
 * sessions*), run by the `claude` CLI from the entries Switchboard installs in the
 * user's settings: `node sb-hook.ts --switchboard-hook <kind> <port> <tokenFile>`.
 * No dependencies; Node ≥ 24 runs it directly.
 *
 * It reads the hook input (JSON on stdin) and POSTs it to the local Switchboard,
 * `http://127.0.0.1:<port>/hook/v1/<kind>`, with the hook token from `tokenFile`
 * (readable only by the user). It never forwards the CLI's environment, only the
 * input, the CLI's pid and entrypoint. Every failure (Switchboard down, a bad
 * answer, a missing token) ends with exit 0 and no output: the terminal behaves
 * as without the hook.
 *
 * - `event`: fire and forget (installed `async`; 2 s at most).
 * - `permission` (PermissionRequest): waits for the answer; `200` → its body (the
 *   hook's `hookSpecificOutput`) on stdout, exit 0; anything else → no output (the
 *   terminal's own dialog decides, as it always can).
 * - `waiter` (SessionStart / Stop, `asyncRewake`): waits for a message for this
 *   session; `200 { message }` → the message on stderr, **exit 2** (the CLI wakes
 *   the session with it); `204` (the host's explicit "no longer needed": superseded,
 *   session ended / unhooked) → exit 0. Anything else (connection refused or reset,
 *   Switchboard restarting, `503`, an error, an empty answer) is NOT a stop: it waits
 *   again, backing off 1 s → 30 s, for as long as the CLI keeps the hook alive (its
 *   entry carries a 7-day `timeout`). The host marks a message delivered before it
 *   answers, so a retried long-poll never takes one twice.
 */
import { readFile } from 'node:fs/promises';
import http from 'node:http';

const MARKER = '--switchboard-hook';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function post(port: number, route: string, token: string, body: string, timeoutMs: number | null): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (timeoutMs !== null) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    }
    req.end(body);
  });
}

/** The waiter's retry backoff: 1 s, doubling, 30 s at most. */
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** A held connection that lasted this long was healthy: the backoff starts over. */
const HEALTHY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `false` once the CLI process that runs this hook is gone (its hook is then no longer needed). */
function claudeAlive(pid: number | null): boolean {
  if (pid === null) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The waiter: long-polls until a message (exit 2) or the host's explicit stop (exit 0); retries everything else. */
async function runWaiter(port: number, tokenFile: string, body: string, claudePid: number | null): Promise<number> {
  let delay = BACKOFF_MIN_MS;
  for (;;) {
    if (!claudeAlive(claudePid)) return 0;
    const startedAt = Date.now();
    let answer: { status: number; text: string } | null = null;
    try {
      const token = (await readFile(tokenFile, 'utf8')).trim();
      answer = await post(port, '/hook/v1/waiter', token, body, null);
    } catch {
      // Switchboard down or restarting, the connection reset, the token not readable now: try again.
    }
    if (answer?.status === 204) return 0;
    if (answer?.status === 200) {
      let message: unknown;
      try {
        message = (JSON.parse(answer.text) as { message?: unknown }).message;
      } catch {
        message = undefined;
      }
      if (typeof message === 'string' && message !== '') {
        process.stderr.write(message);
        return 2;
      }
    }
    delay = Date.now() - startedAt >= HEALTHY_MS ? BACKOFF_MIN_MS : delay;
    await sleep(delay);
    delay = Math.min(delay * 2, BACKOFF_MAX_MS);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const at = args.indexOf(MARKER);
  if (at < 0) return 0;
  const [kind, portText, tokenFile] = args.slice(at + 1);
  const port = Number(portText);
  if (!kind || !tokenFile || !Number.isInteger(port) || port < 1 || port > 65535) return 0;
  if (kind !== 'event' && kind !== 'permission' && kind !== 'waiter') return 0;
  const input = (await readStdin()).trim();
  let event: unknown;
  try {
    event = JSON.parse(input || '{}');
  } catch {
    return 0;
  }
  const body = JSON.stringify({
    event,
    claudePid: Number(process.env['CLAUDE_PID']) || null,
    entrypoint: process.env['CLAUDE_CODE_ENTRYPOINT'] ?? null,
  });
  if (kind === 'waiter') return runWaiter(port, tokenFile, body, Number(process.env['CLAUDE_PID']) || null);
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const answer = await post(port, `/hook/v1/${kind}`, token, body, kind === 'event' ? 2_000 : null);
  if (answer.status !== 200) return 0;
  if (kind === 'permission') {
    process.stdout.write(answer.text);
    return 0;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
