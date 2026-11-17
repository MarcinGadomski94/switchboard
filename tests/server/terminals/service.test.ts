import { describe, expect, it } from 'vitest';
import type { TerminalServerFrame } from '../../../src/core/terminals.ts';
import { type PtyProcess, type PtySpawner, TerminalError, TerminalService } from '../../../src/server/terminals/service.ts';

/** A pseudo-terminal double: records writes and kills; `emit` plays the program's output. */
function fakePty(): { spawner: PtySpawner; spawned: Array<{ file: string; env: Record<string, string>; killed: boolean; emit(data: string): void }> } {
  const spawned: Array<{ file: string; env: Record<string, string>; killed: boolean; emit(data: string): void }> = [];
  const spawner: PtySpawner = (file, _args, options) => {
    const listeners: Array<(data: string) => void> = [];
    const entry = { file, env: options.env, killed: false, emit: (data: string) => listeners.forEach((listener) => listener(data)) };
    spawned.push(entry);
    const pty: PtyProcess = {
      pid: 1000 + spawned.length,
      onData: (listener) => {
        listeners.push(listener);
        return { dispose: () => undefined };
      },
      onExit: () => ({ dispose: () => undefined }),
      write: () => undefined,
      resize: () => undefined,
      kill: () => {
        entry.killed = true;
      },
    };
    return pty;
  };
  return { spawner, spawned };
}

const PROGRAM = { file: 'sh', args: [], title: 'sh', shell: 'sh' as const };

describe('D170 TerminalService', () => {
  it('closes a terminal nobody has shown for the idle limit; one shown somewhere never idles out', async () => {
    const { spawner, spawned } = fakePty();
    let now = 0;
    const service = new TerminalService({ spawn: spawner, now: () => now, idleMs: async () => 60_000, env: {} });
    const lonely = await service.create({ program: PROGRAM, cwd: '/', owner: null, cols: 80, rows: 24 });
    const watched = await service.create({ program: PROGRAM, cwd: '/', owner: null, cols: 80, rows: 24 });
    const frames: TerminalServerFrame[] = [];
    service.attach('*', watched.id, { send: (frame) => frames.push(frame), close: () => undefined });
    now = 59_000;
    await service.sweep();
    expect(service.list('*')).toHaveLength(2);
    now = 61_000;
    await service.sweep();
    expect(service.list('*').map((terminal) => terminal.id)).toEqual([watched.id]);
    expect(spawned[0]?.killed).toBe(true);
    expect(spawned[1]?.killed).toBe(false);
    expect(lonely.id).not.toBe(watched.id);
  });

  it('idle limit 0 keeps every terminal', async () => {
    const { spawner } = fakePty();
    let now = 0;
    const service = new TerminalService({ spawn: spawner, now: () => now, idleMs: 0, env: {} });
    await service.create({ program: PROGRAM, cwd: '/', owner: null, cols: 80, rows: 24 });
    now = 10 * 24 * 3600_000;
    await service.sweep();
    expect(service.list('*')).toHaveLength(1);
  });

  it('refuses a terminal over the cap (409), across profiles; Close makes room', async () => {
    const { spawner } = fakePty();
    const service = new TerminalService({ spawn: spawner, maxOpen: 2, env: {} });
    const first = await service.create({ program: PROGRAM, cwd: '/', owner: 'a', cols: 80, rows: 24 });
    await service.create({ program: PROGRAM, cwd: '/', owner: 'b', cols: 80, rows: 24 });
    await expect(service.create({ program: PROGRAM, cwd: '/', owner: 'a', cols: 80, rows: 24 })).rejects.toMatchObject({ status: 409, code: 'too-many' });
    service.close('a', first.id);
    await expect(service.create({ program: PROGRAM, cwd: '/', owner: 'a', cols: 80, rows: 24 })).resolves.toMatchObject({ shell: 'sh' });
  });

  it('keeps only the last scrollback characters and replays them on attach', async () => {
    const { spawner, spawned } = fakePty();
    const service = new TerminalService({ spawn: spawner, scrollbackChars: 5, env: {} });
    const info = await service.create({ program: PROGRAM, cwd: '/', owner: null, cols: 80, rows: 24 });
    spawned[0]?.emit('abc');
    spawned[0]?.emit('defgh');
    const frames: TerminalServerFrame[] = [];
    service.attach('*', info.id, { send: (frame) => frames.push(frame), close: () => undefined });
    expect(frames[0]).toMatchObject({ t: 'hello', scrollback: 'defgh' });
  });

  it('starts the program without Switchboard’s own variables; ends everything when Switchboard stops', async () => {
    const { spawner, spawned } = fakePty();
    const service = new TerminalService({ spawn: spawner, env: { PATH: '/bin', SWITCHBOARD_DATA_DIR: '/data', SWITCHBOARD_SESSION: 's1', GITHUB_TOKEN: 'mine' } });
    const info = await service.create({ program: PROGRAM, cwd: '/', owner: null, cols: 80, rows: 24 });
    expect(spawned[0]?.env).toMatchObject({ PATH: '/bin', GITHUB_TOKEN: 'mine', TERM: 'xterm-256color' });
    expect(Object.keys(spawned[0]?.env ?? {}).filter((key) => key.startsWith('SWITCHBOARD_'))).toEqual([]);
    const frames: TerminalServerFrame[] = [];
    let closed = false;
    service.attach('*', info.id, {
      send: (frame) => frames.push(frame),
      close: () => {
        closed = true;
      },
    });
    service.closeAll();
    expect(frames.at(-1)).toEqual({ t: 'closed', reason: 'stopping' });
    expect(closed).toBe(true);
    expect(spawned[0]?.killed).toBe(true);
    await expect(service.create({ program: PROGRAM, cwd: '/', owner: null, cols: 80, rows: 24 })).rejects.toBeInstanceOf(TerminalError);
  });
});
