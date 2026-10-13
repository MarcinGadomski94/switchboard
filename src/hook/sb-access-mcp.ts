/**
 * D100-T2 (`docs/team.md` → *Access requests*): the stdio launcher of a team
 * member's access MCP server. The member's CLI starts it as an MCP server
 * (`node sb-access-mcp.ts --switchboard-access <port> <sessionId> <accessId>`, the
 * session's agent token in `SWITCHBOARD_TODO_TOKEN`); it asks the local Switchboard
 * (`GET /agent/v1/team/access/{accessId}/launch`, loopback, that session's token)
 * for the server's command, arguments and environment (the values read from the OS
 * keychain at that moment) and runs it with `shell: false`, its stdin / stdout
 * handed straight through to the CLI. So **no value is in any config file or on
 * any argv**: the CLI's MCP config names only this launcher.
 *
 * Switchboard answers only for the member's own session, only while Team is on
 * and only while the access is set up on this machine (and not revoked or
 * expired); anything else ends the launcher with a message on stderr.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { ACCESS_MCP_MARKER } from '../core/team-access.ts';
import { AGENT_SESSION_HEADER, AGENT_TOKEN_ENV } from '../core/todos.ts';

/** What Switchboard answers. */
export interface AccessLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

function fetchLaunch(port: number, sessionId: string, accessId: string, token: string): Promise<{ readonly status: number; readonly body: unknown }> {
  return new Promise((resolve, reject) => {
    const route = `/agent/v1/team/access/${encodeURIComponent(accessId)}/launch`;
    const req = http.request(
      { host: '127.0.0.1', port, path: route, method: 'GET', headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, [AGENT_SESSION_HEADER]: sessionId }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: unknown = null;
          try {
            body = raw ? (JSON.parse(raw) as unknown) : null;
          } catch {
            body = raw;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error('Switchboard did not answer within 15 s')));
    req.on('error', reject);
    req.end();
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const at = argv.indexOf(ACCESS_MCP_MARKER);
  const port = Number(argv[at + 1]);
  const sessionId = argv[at + 2] ?? '';
  const accessId = argv[at + 3] ?? '';
  const token = process.env[AGENT_TOKEN_ENV] ?? '';
  if (!Number.isInteger(port) || port <= 0 || port > 65_535 || sessionId === '' || accessId === '') {
    process.stderr.write(`usage: node sb-access-mcp.ts ${ACCESS_MCP_MARKER} <port> <sessionId> <accessId> (with ${AGENT_TOKEN_ENV} set)\n`);
    return 2;
  }
  const answer = await fetchLaunch(port, sessionId, accessId, token);
  if (answer.status !== 200) {
    const message = (answer.body as { message?: unknown } | null)?.message;
    process.stderr.write(`switchboard access: ${typeof message === 'string' ? message : `HTTP ${answer.status}`}\n`);
    return 1;
  }
  const launch = answer.body as AccessLaunch;
  const { [AGENT_TOKEN_ENV]: _token, ...inherited } = process.env;
  const child = spawn(launch.command, [...launch.args], { shell: false, stdio: 'inherit', env: { ...inherited, ...launch.env }, windowsHide: true });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  return new Promise<number>((resolve) => {
    child.once('error', (error) => {
      process.stderr.write(`switchboard access: could not start ${launch.command}: ${error.message}\n`);
      resolve(1);
    });
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

if (process.argv.includes(ACCESS_MCP_MARKER)) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`switchboard access: ${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
