/**
 * The terminal tail (SPEC → Session: "event log + terminal" under the timeline,
 * and the right panel's terminal): a console-like view of what the session's
 * `claude` process did, built from its stored events (`docs/derivations.md` →
 * *Terminal tail*). Switchboard has no TTY, so these lines are rendered from the
 * stream-json events, never invented. Pure, so it is unit tested without a browser.
 */
import type { Agent, SessionEvent } from '../../../core/api.ts';
import type { EventPayload } from '../../../core/event-payload.ts';

/** How many lines the tail keeps (the newest). */
export const TERMINAL_LINES = 8;

/** Color of a line (prototype `lineColor`), styled in `timeline.css`. */
export type TerminalTone = 'cmd' | 'ok' | 'warn' | 'err' | 'plain';

/** One terminal line. */
export interface TerminalLine {
  /** Stable key: `<event id>:<n>`. */
  readonly key: string;
  readonly text: string;
  readonly tone: TerminalTone;
}

/**
 * The prototype's `lineColor`, applied after dropping a leading `[agent] ` tag:
 * `$` command (dim), `✓` ok (green), `⏸` / `⚠` waiting or warning (amber),
 * `✕` failure (red), anything else plain.
 */
export function lineTone(text: string): TerminalTone {
  const t = text.replace(/^\[[\w-]+\] /, '');
  if (t.startsWith('$')) return 'cmd';
  if (t.startsWith('✓')) return 'ok';
  if (t.startsWith('⏸') || t.startsWith('⚠')) return 'warn';
  if (t.startsWith('✕')) return 'err';
  return 'plain';
}

function firstLine(text: string): string {
  return (text.trim().split('\n', 1)[0] ?? '').trim();
}

function lastLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.at(-1) ?? '';
}

/** The lines one event contributes, without the agent tag. */
export function eventLines(event: SessionEvent): string[] {
  const payload = event.payload as EventPayload | null;
  if (!payload || typeof payload !== 'object' || typeof (payload as { type?: unknown }).type !== 'string') return [];
  switch (payload.type) {
    case 'tool': {
      if (payload.name === 'Bash') {
        const command = typeof payload.input['command'] === 'string' ? firstLine(payload.input['command']) : '';
        const lines = [command ? `$ ${command}` : `$ ${event.label}`];
        if (payload.result !== undefined) {
          if (payload.isError) lines.push(`✕ ${firstLine(payload.result) || 'failed'}`);
          else {
            const out = lastLine(payload.result);
            if (out) lines.push(out);
          }
        }
        return lines;
      }
      if (payload.requestState === 'open') return [`⏸ ${event.label}`];
      if (payload.result === undefined) return [`● ${event.label}`];
      return [`${payload.isError ? '✕' : '✓'} ${event.label}`];
    }
    case 'request':
      if (payload.state === 'open') return [`⏸ ${event.label}`];
      if (payload.state === 'responded') return [`${payload.behavior === 'deny' ? '✕' : '✓'} ${event.label}`];
      // D24: the phone answered it first (Remote Control).
      if (payload.answeredOn) return [`✓ ${event.label} · answered on ${payload.answeredOn}`];
      return [`⚠ ${event.label} · ${payload.state}`];
    case 'remote':
      // D24: Remote Control on / off / a failed remote_control request (the CLI's text is in the label).
      return [`${payload.action === 'failed' ? '✕' : '✓'} ${event.label}`];
    case 'denied':
      return [`✕ ${event.label}`];
    case 'result':
      return [`${payload.isError ? '✕' : '✓'} ${event.label}`];
    case 'lifecycle':
      return [event.kind === 'error' ? `✕ ${event.label}` : event.label];
    case 'mode-mismatch':
      return [`⚠ ${event.label}`];
    default:
      // user / assistant / agent-prompt text belongs to the chat; unknown shapes are not rendered.
      return [];
  }
}

/**
 * The newest {@link TERMINAL_LINES} lines of the session's terminal tail, oldest
 * first. A subagent's lines carry its name as `[name] ` (the prototype's
 * `[web]` / `[mobile]`); the main agent's lines carry none.
 */
export function terminalTail(events: readonly SessionEvent[], agents: readonly Agent[], limit = TERMINAL_LINES): TerminalLine[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const ordered = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id - b.id);
  const out: TerminalLine[] = [];
  for (const event of ordered) {
    const agent = event.agentId === null ? undefined : byId.get(event.agentId);
    const tag = agent && agent.kind !== 'main' ? `[${agent.name}] ` : '';
    eventLines(event).forEach((line, n) => {
      const text = `${tag}${line}`;
      out.push({ key: `${event.id}:${n}`, text, tone: lineTone(text) });
    });
  }
  return out.slice(-limit);
}
