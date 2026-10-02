import type { CliAdapter, SpawnRequest } from '../adapter.ts';
import type { AgentProcess } from '../agent-process.ts';
import { CodexBridge } from './bridge.ts';

/** D62: Codex CLI behind the provider seam: `codex app-server` through {@link CodexBridge}. */
export const codexAdapter: CliAdapter = {
  id: 'codex',
  spawn(request: SpawnRequest): AgentProcess {
    const { session } = request;
    return new CodexBridge({
      command: request.command,
      cwd: request.cwd,
      env: request.env,
      nativeId: request.nativeId,
      model: session.model,
      effort: session.effort,
      permissionMode: request.permissionMode,
      title: session.title ?? session.name,
      standingInstruction: request.standingInstruction,
      onLine: request.onLine,
      ...(request.onNativeId ? { onNativeId: request.onNativeId } : {}),
      ...(request.onNotice ? { onNotice: request.onNotice } : {}),
      ...(request.onUsage ? { onUsage: request.onUsage } : {}),
      ...(request.clientVersion ? { clientVersion: request.clientVersion } : {}),
    });
  },
};
