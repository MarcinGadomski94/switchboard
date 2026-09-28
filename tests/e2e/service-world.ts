import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { fakeServiceCtlEnv } from '../../tools/fake-servicectl/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';

/**
 * The real app for the "Start at login" specs (M9.1, D13: no demo seed): a temp
 * data folder and workspace, fake-claude / fake gh, and the per-user service
 * redirected to a temp home with tools/fake-servicectl as launchctl / systemctl
 * / schtasks (`docs/service.md` → *Test redirects*), so nothing is registered on
 * this machine (D12).
 */
export interface ServiceWorld {
  readonly server: ServerProcess;
  readonly root: string;
  /** The redirected home the service files go to. */
  readonly home: string;
  /** The fake service manager's calls, one argv per line. */
  ctlCalls(): Promise<string[][]>;
  /** Stops the server (resolves with its exit code) and removes the temp folders. */
  stop(): Promise<number | null>;
}

/** Starts the app; `env` is added last (e.g. a PATH without node). */
export async function startServiceWorld(env: Record<string, string> = {}): Promise<ServiceWorld> {
  const root = await makeTempDir('start-at-login');
  const home = path.join(root, 'home');
  const log = path.join(root, 'servicectl.log');
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  let server: ServerProcess;
  try {
    // D14: the workspace is a saved folder (the default) in the server's database.
    await seedFolderInDataDir(path.join(root, 'data'), workspace);
    server = await startServer({
      SWITCHBOARD_DATA_DIR: path.join(root, 'data'),
      SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
      SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
      SWITCHBOARD_SERVICE_HOME: home,
      SWITCHBOARD_SERVICE_CTL: fakeServiceCtlEnv(),
      FAKE_SERVICECTL_LOG: log,
      ...env,
    });
  } catch (error) {
    await removeTempDir(root);
    throw error;
  }
  return {
    server,
    root,
    home,
    async ctlCalls() {
      try {
        return (await readFile(log, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
      } catch {
        return [];
      }
    },
    async stop() {
      const code = await server.stop();
      await removeTempDir(root);
      return code;
    },
  };
}
