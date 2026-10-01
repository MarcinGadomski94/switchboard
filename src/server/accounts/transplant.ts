import { chmod, copyFile, cp, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { findCodexRollout } from '../cli/handover.ts';
import { findTranscriptFile } from '../supervisor/attach.ts';

/** What copying a conversation to another profile's folder came to. */
export type TransplantResult = { readonly ok: true; readonly file: string } | { readonly ok: false; readonly reason: string };

/**
 * D63 (`docs/accounts.md` → *Switching*): copies (never moves) a Claude Code
 * conversation from one profile's config folder to another's, so `--resume` with
 * the new `CLAUDE_CONFIG_DIR` finds it: `projects/<cwd slug>/<id>.jsonl` and, when
 * it exists, the `projects/<cwd slug>/<id>/` folder (subagents, tool results). The
 * original stays where it is (the earlier profile can resume it). Only the
 * conversation files are touched: never credentials, settings or other sessions.
 */
export async function copyClaudeConversation(fromDir: string, toDir: string, sessionId: string): Promise<TransplantResult> {
  const source = await findTranscriptFile(fromDir, sessionId);
  if (!source) return { ok: false, reason: `no transcript of ${sessionId} under ${path.join(fromDir, 'projects')}` };
  const slug = path.basename(path.dirname(source));
  const target = path.join(toDir, 'projects', slug);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const file = path.join(target, `${sessionId}.jsonl`);
  await copyFile(source, file);
  await chmod(file, 0o600).catch(() => undefined);
  const extras = path.join(path.dirname(source), sessionId);
  if (await isDirectory(extras)) await cp(extras, path.join(target, sessionId), { recursive: true, force: true });
  return { ok: true, file };
}

/**
 * D63: copies a Codex thread's rollout file into another `CODEX_HOME`, at the same
 * `sessions/YYYY/MM/DD/` place, so `thread/resume` there finds it (ASSUMED
 * D63-codex-resume: resume reads the rollout by thread id from its own home;
 * unverified, with the D62 handover as the fallback).
 */
export async function copyCodexRollout(fromHome: string, toHome: string, threadId: string): Promise<TransplantResult> {
  const source = await findCodexRollout({ CODEX_HOME: fromHome }, threadId);
  if (!source) return { ok: false, reason: `no rollout of thread ${threadId} under ${path.join(fromHome, 'sessions')}` };
  const relative = path.relative(path.join(fromHome, 'sessions'), source);
  const file = path.join(toHome, 'sessions', relative);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await copyFile(source, file);
  await chmod(file, 0o600).catch(() => undefined);
  return { ok: true, file };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
