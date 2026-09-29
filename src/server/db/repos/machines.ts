import type { CreateInput, Patch, RepoContext } from '../context.ts';
import { Table, type TableSpec, defined } from '../table.ts';

/**
 * A paired Switchboard (D48, migration 0016, `docs/peers.md`). The outbound token
 * is what this service presents to the peer; of the token the peer presents here
 * only a hash is kept. Neither is ever logged or sent to the UI.
 */
export interface MachineRecord {
  /** The peer's own machine id: the namespace of its remote ids. */
  readonly id: string;
  readonly name: string;
  /** The peer listener's `host:port`, `null` while unknown. */
  readonly address: string | null;
  readonly outboundToken: string;
  readonly inboundTokenHash: string;
  readonly pairedAt: string;
  readonly lastSeenAt: string | null;
}

/** Input of {@link MachineRepository.upsert}. */
export type MachineCreate = CreateInput<MachineRecord, 'id' | 'name' | 'outboundToken' | 'inboundTokenHash', 'pairedAt'>;

/** Input of {@link MachineRepository.update}. */
export type MachinePatch = Patch<MachineRecord, 'id' | 'pairedAt'>;

const SPEC: TableSpec<MachineRecord> = {
  table: 'machines',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    name: ['name', 'text'],
    address: ['address', 'text'],
    outboundToken: ['outbound_token', 'text'],
    inboundTokenHash: ['inbound_token_hash', 'text'],
    pairedAt: ['paired_at', 'text'],
    lastSeenAt: ['last_seen_at', 'text'],
  },
};

/** The paired machines (D48). */
export class MachineRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<MachineRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  /** Every paired machine, oldest pairing first. */
  async list(): Promise<MachineRecord[]> {
    return this.#table.select('', [], 'paired_at, id');
  }

  async get(id: string): Promise<MachineRecord | null> {
    return this.#table.get(id);
  }

  /** The machine whose inbound token hashes to `hash`, or `null`. */
  async getByInboundHash(hash: string): Promise<MachineRecord | null> {
    return this.#table.first('inbound_token_hash = ?', [hash]);
  }

  /**
   * Stores a pairing: a new machine, or new tokens (and name / address) for a
   * machine paired before (pairing again replaces the old tokens, which stop working).
   */
  async upsert(input: MachineCreate): Promise<MachineRecord> {
    const existing = this.#table.get(input.id);
    if (existing) {
      const { id: _id, ...patch } = defined(input);
      return (this.#table.update(input.id, { ...patch, pairedAt: this.#ctx.now(), lastSeenAt: null })) ?? existing;
    }
    return this.#table.insert({ ...defined(input), pairedAt: this.#ctx.now() });
  }

  async update(id: string, patch: MachinePatch): Promise<MachineRecord | null> {
    return this.#table.update(id, patch);
  }

  /** Forgets the machine (its tokens stop working at once). */
  async delete(id: string): Promise<boolean> {
    return this.#table.delete(id);
  }
}
