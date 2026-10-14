import { randomBytes } from 'node:crypto';
import {
  MEMORY_CAP_DEFAULT,
  MEMORY_PROPOSE_PER_HOUR,
  MEMORY_SETTING,
  type MemoryEntry,
  type MemoryInput,
  type MemoryScope,
  type MemorySettings,
  type MemoryState,
  type MemoryStatus,
  folderName,
  memoryBlock,
  memoryOrder,
  memoryProposalsTitle,
  nearDuplicateTitle,
  readMemoryCap,
  readMemoryInput,
} from '../../core/memory.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { StoreError } from '../db/table.ts';
import type { HubBus } from '../hub/bus.ts';
import { inboxCount } from '../inbox/wire.ts';
import { MemoryDb } from './db.ts';
import { type MemorySessionRef, registerMemoryHooks } from './hooks.ts';

/** Why the service refused a call: maps to the route's HTTP answer (`{ error, message, errors? }`). */
export class MemoryError extends Error {
  override name = 'MemoryError';
  readonly status: number;
  readonly code: string;
  readonly field: string | null;
  constructor(status: number, code: string, message: string, field: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }

  body(): Record<string, unknown> {
    return this.field !== null ? { error: this.code, message: this.message, errors: [{ field: this.field, message: this.message }] } : { error: this.code, message: this.message };
  }
}

/** The kind of the Inbox item that announces a folder's open proposals. */
export const MEMORY_PROPOSALS_ITEM = 'memory-proposals';
/** Its Review action (a link to the Memory page: the web goes to `payload.route`, the item stays open). */
export const OPEN_MEMORY = 'open-memory';

/** What the service needs of the supervisor (D91's reload, reused as it is). */
export interface MemorySupervisor {
  instructionSettingChanged(): Promise<void>;
  reloadInstruction(sessionId: string): Promise<unknown>;
}

export interface MemoryServiceOptions {
  readonly dataDir: string;
  readonly store: Store;
  readonly bus: HubBus;
  /** D91: open idle sessions of a folder are restarted with `--resume` when its approved memory changes (busy: after the turn). */
  readonly supervisor: MemorySupervisor;
  readonly now?: () => Date;
  /** The pause before the folder's sessions are reloaded (approvals in a row restart them once). */
  readonly reloadDelayMs?: number;
  readonly onError?: (error: unknown) => void;
}

const CAP_KEY = 'cap';
const HOUR_MS = 60 * 60 * 1000;

/**
 * D107 · Project memory (`docs/memory.md`). Agents propose entries for their session's folder
 * (`memory_propose`); the developer approves (as proposed or edited), rejects, edits, pins and
 * deletes them, and adds entries by hand. **The review gate:** the block a session gets
 * ({@link blockFor}) and `memory_list` read `status = 'approved'` rows only, and an approval stores
 * the approved title and text in the same row it reads from, so what is injected is exactly what
 * the developer approved (their edit included); proposed and rejected rows are never read for it.
 *
 * When a folder's approved memory changes, its open sessions get it the D91 way
 * (`reloadInstruction`: idle → restarted with `--resume`, busy → after its turn). A folder with
 * open proposals has one Inbox item ("3 memory proposals for Acme app · Review"), closed when its
 * queue is empty.
 *
 * **Experimental, off by default** (Settings → Experimental → Project memory): while off it opens
 * nothing (`memory.db` is not created), injects nothing and answers 404 `memory-off`; while on with
 * a broken `memory.db`, 503 `memory-unavailable` and nothing is injected.
 */
export class MemoryService {
  readonly #o: MemoryServiceOptions;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  #enabled = false;
  #db: MemoryDb | null = null;
  #problem: string | null = null;
  #closed = false;
  #offHooks: (() => void) | null = null;
  #switching: Promise<void> = Promise.resolve();
  /** Folders whose sessions wait for a reload, and the timer. */
  readonly #reloadScopes = new Set<string>();
  #reloadTimer: ReturnType<typeof setTimeout> | null = null;
  #reloading: Promise<void> = Promise.resolve();

  constructor(options: MemoryServiceOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? ((error) => console.error('switchboard memory:', error));
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Registers the seams and reads the switch (the app calls it when ready). */
  async start(): Promise<void> {
    if (this.#closed) return;
    this.#offHooks ??= registerMemoryHooks(this.#o.store, {
      blockFor: (session) => this.blockFor(session),
      switchChanged: () => this.switchChanged(),
    });
    await this.switchChanged();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#offHooks?.();
    this.#offHooks = null;
    if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
    this.#reloadTimer = null;
    this.#reloadScopes.clear();
    await this.#switching.catch(() => undefined);
    await this.#reloading.catch(() => undefined);
    this.#db?.close();
    this.#db = null;
  }

  /** The switch was read again. On: `memory.db` opens (created on first use). Off: it closes (it stays on disk). */
  switchChanged(): Promise<void> {
    const next = this.#switching.then(() => this.#applySwitch());
    this.#switching = next.catch((error: unknown) => this.#onError(error));
    return next;
  }

  async #applySwitch(): Promise<void> {
    if (this.#closed) return;
    const on = (await this.#o.store.settings.get(MEMORY_SETTING)) === true;
    if (on === this.#enabled) return;
    this.#enabled = on;
    const scopes = new Set<string>();
    if (!on) {
      for (const entry of this.#db?.list({ statuses: ['approved'] }) ?? []) scopes.add(entry.scope);
      this.#db?.close();
      this.#db = null;
      this.#problem = null;
    } else {
      try {
        this.#db = await MemoryDb.open(this.#o.dataDir);
        this.#problem = null;
      } catch (error) {
        this.#db = null;
        this.#problem = `memory.db could not be opened: ${error instanceof Error ? error.message : String(error)}`;
        this.#onError(error);
      }
      for (const entry of this.#db?.list({ statuses: ['approved'] }) ?? []) scopes.add(entry.scope);
    }
    // The blocks appear / disappear: the open sessions' `instructionOutdated` follows, and their processes get it (D91).
    await this.#o.supervisor.instructionSettingChanged().catch(() => undefined);
    for (const scope of scopes) this.#scheduleReload(scope);
    await this.#syncAllInbox();
    this.#o.bus.publish('memoryChanged', { scope: null });
  }

  /** `GET /api/memory/state` (answered while off too). */
  state(): MemoryState {
    return { enabled: this.#enabled, available: this.#enabled && this.#db !== null, problem: this.#enabled ? this.#problem : null };
  }

  /** Timers running (tests: none while off). */
  activeTimers(): number {
    return this.#reloadTimer ? 1 : 0;
  }

  #need(): MemoryDb {
    if (!this.#enabled) throw new MemoryError(404, 'memory-off', 'Project memory is off: switch it on in Settings → Experimental');
    if (!this.#db) throw new MemoryError(503, 'memory-unavailable', this.#problem ?? 'memory.db is not open');
    return this.#db;
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  // ── scopes ──────────────────────────────────────────────────────────────

  /** A session's folder: its canonical root (the workspace or the repo), `null` for a chat or without one. */
  static scopeOf(session: MemorySessionRef): string | null {
    if (session.kind === 'chat') return null;
    return session.root ?? session.cwd ?? null;
  }

  async #label(scope: string): Promise<string> {
    const saved = (await this.#o.store.folders.list()).find((folder) => folder.canonicalPath === scope || folder.path === scope);
    return saved?.label ?? folderName(scope);
  }

  /** `GET /api/memory/scopes`: the saved folders, then every other folder with entries; each with its counts. */
  async scopes(): Promise<MemoryScope[]> {
    const db = this.#need();
    const counts = new Map(db.counts().map((row) => [row.scope, row]));
    const out: MemoryScope[] = [];
    const seen = new Set<string>();
    for (const folder of await this.#o.store.folders.list()) {
      const scope = folder.canonicalPath;
      if (seen.has(scope)) continue;
      seen.add(scope);
      const count = counts.get(scope);
      out.push({ scope, label: folder.label ?? folderName(scope), saved: true, approved: count?.approved ?? 0, proposed: count?.proposed ?? 0 });
    }
    for (const [scope, count] of counts) {
      if (seen.has(scope) || count.approved + count.proposed === 0) continue;
      out.push({ scope, label: folderName(scope), saved: false, approved: count.approved, proposed: count.proposed });
    }
    return out;
  }

  // ── reads ───────────────────────────────────────────────────────────────

  /** `GET /api/memory/entries`: a folder's entries (all folders without one), approved in block order, then proposed (oldest first), then rejected. */
  entries(filter: { readonly scope?: string; readonly status?: string } = {}): MemoryEntry[] {
    const db = this.#need();
    const statuses: MemoryStatus[] | undefined = filter.status === 'approved' || filter.status === 'proposed' || filter.status === 'rejected' ? [filter.status] : undefined;
    const rows = db.list({ ...(filter.scope ? { scope: filter.scope } : {}), ...(statuses ? { statuses } : {}) });
    return [...memoryOrder(rows.filter((entry) => entry.status === 'approved')), ...rows.filter((entry) => entry.status === 'proposed'), ...rows.filter((entry) => entry.status === 'rejected').reverse()];
  }

  /** `GET|PUT /api/memory/settings`. */
  settings(): MemorySettings {
    const raw = Number(this.#need().meta(CAP_KEY));
    return { cap: Number.isInteger(raw) && raw > 0 ? raw : MEMORY_CAP_DEFAULT };
  }

  async setSettings(body: unknown): Promise<MemorySettings> {
    const db = this.#need();
    const cap = readMemoryCap(body);
    if (cap === null) throw new MemoryError(422, 'invalid', 'cap must be a whole number of characters from 500 to 20000', 'cap');
    db.setMeta(CAP_KEY, String(cap));
    for (const scope of new Set(db.list({ statuses: ['approved'] }).map((entry) => entry.scope))) await this.#approvedChanged(scope);
    this.#o.bus.publish('memoryChanged', { scope: null });
    return this.settings();
  }

  /**
   * The block a session gets next to its standing instruction (`null` while off, broken, for a
   * chat, without a folder or without approved entries). **Approved rows only** (the gate).
   */
  async blockFor(session: MemorySessionRef): Promise<string | null> {
    if (!this.#enabled || !this.#db) return null;
    const scope = MemoryService.scopeOf(session);
    if (scope === null) return null;
    const approved = this.#db.list({ scope, statuses: ['approved'] });
    if (approved.length === 0) return null;
    return memoryBlock(approved, this.settings().cap, await this.#label(scope));
  }

  // ── the agent's calls (`/agent/v1/memory`, the session's agent token) ───

  async #agentScope(sessionId: string): Promise<{ session: SessionRecord; scope: string }> {
    this.#need();
    const session = await this.#o.store.sessions.get(sessionId);
    if (!session) throw new MemoryError(404, 'not-found', 'this session is not known to Switchboard');
    const scope = MemoryService.scopeOf(session);
    if (scope === null) throw new MemoryError(404, 'no-folder', session.kind === 'chat' ? 'a chat has no project folder: project memory belongs to sessions' : 'this session has no folder');
    return { session, scope };
  }

  /** `memory_list`: the folder's approved entries in block order, and the folder's label. */
  async agentList(sessionId: string): Promise<{ scope: string; label: string; entries: MemoryEntry[] }> {
    const { scope } = await this.#agentScope(sessionId);
    return { scope, label: await this.#label(scope), entries: memoryOrder(this.#need().list({ scope, statuses: ['approved'] })) };
  }

  /**
   * `memory_propose`: a **proposed** entry for the caller's folder (never injected until the
   * developer approves it). Refused: more than {@link MEMORY_PROPOSE_PER_HOUR} proposals of this
   * session in the last hour (429 `rate-limited`), a title near-identical to a proposed, approved
   * or rejected entry of the folder (409 `duplicate`).
   */
  async propose(sessionId: string, body: unknown): Promise<MemoryEntry> {
    const { session, scope } = await this.#agentScope(sessionId);
    const input = readMemoryInput(body, ['title', 'text']);
    if (!input.ok) throw new MemoryError(422, 'invalid', input.message, input.field);
    const db = this.#need();
    const since = new Date(this.#now().getTime() - HOUR_MS).toISOString();
    if (db.proposalsSince(sessionId, since) >= MEMORY_PROPOSE_PER_HOUR) {
      throw new MemoryError(429, 'rate-limited', `at most ${MEMORY_PROPOSE_PER_HOUR} proposals per hour from one session: propose only durable facts, and try again later`);
    }
    const title = input.value.title as string;
    const twin = db.list({ scope }).find((entry) => nearDuplicateTitle(entry.title, title) || (entry.proposedTitle !== null && nearDuplicateTitle(entry.proposedTitle, title)));
    if (twin) {
      const state = twin.status === 'approved' ? 'already approved' : twin.status === 'proposed' ? 'already waiting for review' : 'rejected by the developer';
      throw new MemoryError(409, 'duplicate', `a near-identical entry is ${state}: "${twin.title}". Do not propose it again${twin.status === 'approved' ? '; read it with memory_list' : ''}.`, 'title');
    }
    const now = this.#iso();
    const entry = db.insert({
      id: randomBytes(5).toString('hex'),
      scope,
      title,
      text: input.value.text as string,
      tags: input.value.tags ?? [],
      authorKind: 'agent',
      authorSessionId: sessionId,
      authorLabel: session.title ?? session.name,
      status: 'proposed',
      pinned: false,
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
      decidedBy: null,
      proposedTitle: null,
      proposedText: null,
    });
    await this.#syncInbox(scope);
    this.#o.bus.publish('memoryChanged', { scope });
    return entry;
  }

  // ── the developer's calls (`/api/memory`) ──────────────────────────────

  /** `POST /api/memory/entries`: an entry the developer writes (approved at once). */
  async add(body: unknown): Promise<MemoryEntry> {
    const db = this.#need();
    const raw = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const scope = typeof raw['scope'] === 'string' ? raw['scope'].trim() : '';
    if (scope === '') throw new MemoryError(422, 'invalid', 'scope is required: the folder the entry belongs to', 'scope');
    const input = readMemoryInput(body, ['title', 'text']);
    if (!input.ok) throw new MemoryError(422, 'invalid', input.message, input.field);
    const now = this.#iso();
    const entry = db.insert({
      id: randomBytes(5).toString('hex'),
      scope,
      title: input.value.title as string,
      text: input.value.text as string,
      tags: input.value.tags ?? [],
      authorKind: 'developer',
      authorSessionId: null,
      authorLabel: null,
      status: 'approved',
      pinned: input.value.pinned ?? false,
      createdAt: now,
      updatedAt: now,
      decidedAt: now,
      decidedBy: 'developer',
      proposedTitle: null,
      proposedText: null,
    });
    await this.#approvedChanged(scope);
    return entry;
  }

  #get(id: string): MemoryEntry {
    const entry = this.#need().get(id);
    if (!entry) throw new MemoryError(404, 'not-found', `no memory entry ${id}`);
    return entry;
  }

  /** The agent's own words kept when the developer changes them (once: the first edit keeps the original). */
  #originals(entry: MemoryEntry, input: MemoryInput): { proposedTitle: string | null; proposedText: string | null } {
    if (entry.authorKind !== 'agent') return { proposedTitle: entry.proposedTitle, proposedText: entry.proposedText };
    const titleChanged = input.title !== undefined && input.title !== entry.title;
    const textChanged = input.text !== undefined && input.text !== entry.text;
    return {
      proposedTitle: entry.proposedTitle ?? (titleChanged || textChanged ? entry.title : null),
      proposedText: entry.proposedText ?? (titleChanged || textChanged ? entry.text : null),
    };
  }

  /** `PUT /api/memory/entries/{id}`: edit (title, text, tags) or pin an entry; a proposal stays a proposal. */
  async update(id: string, body: unknown): Promise<MemoryEntry> {
    const entry = this.#get(id);
    const input = readMemoryInput(body);
    if (!input.ok) throw new MemoryError(422, 'invalid', input.message, input.field);
    const updated = this.#need().update(id, {
      ...(input.value.title !== undefined ? { title: input.value.title } : {}),
      ...(input.value.text !== undefined ? { text: input.value.text } : {}),
      ...(input.value.tags !== undefined ? { tags: input.value.tags } : {}),
      ...(input.value.pinned !== undefined ? { pinned: input.value.pinned } : {}),
      ...this.#originals(entry, input.value),
      updatedAt: this.#iso(),
    }) as MemoryEntry;
    if (entry.status === 'approved') await this.#approvedChanged(entry.scope);
    else this.#o.bus.publish('memoryChanged', { scope: entry.scope });
    return updated;
  }

  /**
   * `POST /api/memory/entries/{id}/approve` (`{ title?, text?, tags?, pinned? }`): a proposal
   * becomes approved; an edit given here is what is approved (and injected). A rejected entry can
   * be approved too (the developer changed their mind).
   */
  async approve(id: string, body: unknown): Promise<MemoryEntry> {
    const entry = this.#get(id);
    if (entry.status === 'approved') throw new MemoryError(409, 'not-proposed', 'this entry is already approved');
    const input = readMemoryInput(body);
    if (!input.ok) throw new MemoryError(422, 'invalid', input.message, input.field);
    const now = this.#iso();
    const approved = this.#need().update(id, {
      ...(input.value.title !== undefined ? { title: input.value.title } : {}),
      ...(input.value.text !== undefined ? { text: input.value.text } : {}),
      ...(input.value.tags !== undefined ? { tags: input.value.tags } : {}),
      ...(input.value.pinned !== undefined ? { pinned: input.value.pinned } : {}),
      ...this.#originals(entry, input.value),
      status: 'approved',
      decidedAt: now,
      decidedBy: 'developer',
      updatedAt: now,
    }) as MemoryEntry;
    await this.#syncInbox(entry.scope);
    await this.#approvedChanged(entry.scope);
    return approved;
  }

  /** `POST /api/memory/entries/{id}/reject`: a proposal is rejected (kept, never injected; its title blocks a re-proposal). */
  async reject(id: string): Promise<MemoryEntry> {
    const entry = this.#get(id);
    if (entry.status !== 'proposed') throw new MemoryError(409, 'not-proposed', entry.status === 'approved' ? 'this entry is approved: delete it instead' : 'this entry is already rejected');
    const now = this.#iso();
    const rejected = this.#need().update(id, { status: 'rejected', decidedAt: now, decidedBy: 'developer', updatedAt: now }) as MemoryEntry;
    await this.#syncInbox(entry.scope);
    this.#o.bus.publish('memoryChanged', { scope: entry.scope });
    return rejected;
  }

  /** `DELETE /api/memory/entries/{id}`. */
  async delete(id: string): Promise<void> {
    const entry = this.#get(id);
    this.#need().delete(id);
    if (entry.status === 'proposed') await this.#syncInbox(entry.scope);
    if (entry.status === 'approved') await this.#approvedChanged(entry.scope);
    else this.#o.bus.publish('memoryChanged', { scope: entry.scope });
  }

  // ── after a change ──────────────────────────────────────────────────────

  /** The approved set (or the cap) of `scope` changed: the page reloads, open sessions are flagged now and reloaded shortly. */
  async #approvedChanged(scope: string): Promise<void> {
    this.#o.bus.publish('memoryChanged', { scope });
    await this.#o.supervisor.instructionSettingChanged().catch(() => undefined);
    this.#scheduleReload(scope);
  }

  #scheduleReload(scope: string): void {
    if (this.#closed) return;
    this.#reloadScopes.add(scope);
    if (this.#reloadTimer) return;
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = null;
      const scopes = [...this.#reloadScopes];
      this.#reloadScopes.clear();
      this.#reloading = this.#reloading.then(() => this.#reloadScopesNow(scopes)).catch((error: unknown) => this.#onError(error));
    }, this.#o.reloadDelayMs ?? 400);
    (this.#reloadTimer as { unref?: () => void }).unref?.();
  }

  /**
   * D91, reused as it is: every open session of these folders that Switchboard runs gets the
   * current instruction (`reloadInstruction`: idle → `--resume` restart, busy or waiting → after
   * its turn, no process → its next start, already current → nothing). Hooked and detached
   * sessions are skipped (Switchboard does not run their process); a failure stays in that
   * session's chat (D91) and is not retried.
   */
  async #reloadScopesNow(scopes: readonly string[]): Promise<void> {
    if (this.#closed) return;
    const wanted = new Set(scopes);
    for (const session of await this.#o.store.sessions.list({ closed: false })) {
      if (session.hooked || !session.attached) continue;
      const scope = MemoryService.scopeOf(session);
      if (scope === null || !wanted.has(scope)) continue;
      await this.#o.supervisor.reloadInstruction(session.id).catch(() => undefined);
    }
  }

  /** Waits for scheduled reloads (tests). */
  async settled(): Promise<void> {
    while (this.#reloadTimer) await new Promise((resolve) => setTimeout(resolve, 20));
    await this.#reloading.catch(() => undefined);
  }

  // ── the Inbox item per folder with proposals ───────────────────────────

  async #syncAllInbox(): Promise<void> {
    const scopes = new Set<string>(this.#db?.list({ statuses: ['proposed'] }).map((entry) => entry.scope) ?? []);
    for (const item of await this.#o.store.systemItems.list(['open'])) {
      const scope = item.kind === MEMORY_PROPOSALS_ITEM ? scopeOfItem(item.payload) : null;
      if (scope !== null) scopes.add(scope);
    }
    for (const scope of scopes) await this.#syncInbox(scope).catch((error: unknown) => this.#onError(error));
  }

  /**
   * One open "N memory proposals for <folder>" item while the folder has proposals (its title
   * follows the count; Review goes to the Memory page); closed (`resolved`) once the queue is
   * empty, and while Project memory is off.
   */
  async #syncInbox(scope: string): Promise<void> {
    const proposed = this.#enabled && this.#db ? this.#db.list({ scope, statuses: ['proposed'] }) : [];
    const open = (await this.#o.store.systemItems.list(['open'])).filter((item) => item.kind === MEMORY_PROPOSALS_ITEM && scopeOfItem(item.payload) === scope);
    let changed = false;
    if (proposed.length === 0) {
      for (const item of open) {
        try {
          await this.#o.store.systemItems.close(item.id, 'resolved');
          changed = true;
        } catch (error) {
          if (!(error instanceof StoreError && error.code === 'conflict')) throw error;
        }
      }
    } else {
      const label = await this.#label(scope);
      const title = memoryProposalsTitle(proposed.length, label);
      const newest = proposed[proposed.length - 1] as MemoryEntry;
      const detail = `Agents proposed project memory for ${scope}. Review approves, edits or rejects each one; nothing is used until you approve it. Newest: "${newest.title}".`;
      const payload = { scope, route: `/memory?scope=${encodeURIComponent(scope)}` };
      const [first, ...rest] = open;
      if (first) {
        if (first.title !== title || first.detail !== detail) {
          await this.#o.store.systemItems.update(first.id, { title, detail, payload });
          changed = true;
        }
      } else {
        await this.#o.store.systemItems.create({
          kind: MEMORY_PROPOSALS_ITEM,
          source: 'memory',
          status: 'need',
          title,
          detail,
          branches: [],
          actions: [
            { id: OPEN_MEMORY, label: 'Review' },
            { id: 'dismiss', label: 'Dismiss' },
          ],
          sessionId: null,
          payload,
        });
        changed = true;
      }
      for (const extra of rest) await this.#o.store.systemItems.close(extra.id, 'resolved').catch(() => undefined);
    }
    if (changed) this.#o.bus.publish('inboxChanged', { count: await inboxCount(this.#o.store) });
  }
}

function scopeOfItem(payload: unknown): string | null {
  const scope = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>)['scope'] : null;
  return typeof scope === 'string' ? scope : null;
}
