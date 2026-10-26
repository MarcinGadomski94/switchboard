import type { MemoryDraftAllAnswer, MemoryDraftAnswer } from '../../core/memory.ts';
import { type KindOf, isChat } from '../../core/chats.ts';
import { memoryApi } from './api.ts';

/**
 * D107 follow-up 2026-10-15 · "Draft memory from this session" (the session's and the member's ⋯
 * menus) and "Draft memory for all members" (the Memory page and the Team page header): the
 * session's own agent is sent a message asking it to propose its durable facts with
 * `memory_propose`. Nothing is applied: the proposals wait in the Memory page's review queue.
 */

export const DRAFT_MEMORY_LABEL = 'Draft memory from this session';
export const DRAFT_ALL_LABEL = 'Draft memory for all members';

/** The session ⋯ menu offers it: this machine's open sessions with a folder (never a chat). */
export function offersMemoryDraft(session: KindOf & { readonly closedAt?: string | null; readonly machine?: unknown }): boolean {
  return !isChat(session) && session.closedAt == null && !session.machine;
}

/** The toast after one ask. */
export function draftAnswerText(answer: MemoryDraftAnswer, name: string): string {
  if (answer.asked) return `Asked ${name} to draft project memory from its own session. Its proposals wait for your review on the Memory page.`;
  if (answer.reason === 'asked-recently') return `${name} was asked to draft memory in the last 24 hours: its proposals wait on the Memory page.`;
  if (answer.reason === 'no-folder') return `${name} has no project folder: project memory belongs to sessions with one.`;
  if (answer.reason === 'closed') return `${name} is archived: restore it first.`;
  return `${name} was not asked: ${answer.reason ?? 'unknown reason'}.`;
}

/** The toast after "Draft memory for all members". */
export function draftAllText(answer: MemoryDraftAllAnswer): string {
  const asked = answer.asked.length === 0 ? 'No member was asked' : `Asked ${answer.asked.map((member) => member.name).join(', ')} to draft project memory`;
  const skipped = answer.skipped.length > 0 ? `; skipped ${answer.skipped.map((member) => `${member.name} (${member.reason})`).join(', ')}` : '';
  return `${asked}${skipped}. Proposals wait for your review on the Memory page.`;
}

/** Asks one session (this machine's) or one member (wherever it runs). */
export function draftMemory(target: { readonly sessionId: string } | { readonly memberId: string }): Promise<MemoryDraftAnswer> {
  return memoryApi(null).draft(target);
}

/** Asks every member of `teamId` (every team without one). */
export function draftMemoryForMembers(teamId?: string): Promise<MemoryDraftAllAnswer> {
  return memoryApi(null).draftAll(teamId);
}
