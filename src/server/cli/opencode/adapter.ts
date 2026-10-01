import type { CliAdapter, SpawnRequest } from '../adapter.ts';
import type { AgentProcess } from '../agent-process.ts';
import { OpenCodeBridge } from './bridge.ts';

/** D62: OpenCode behind the provider seam: `opencode serve` on a loopback port through {@link OpenCodeBridge}. */
export const opencodeAdapter: CliAdapter = {
  id: 'opencode',
  spawn(request: SpawnRequest): AgentProcess {
    const { session } = request;
    return new OpenCodeBridge({
      command: request.command,
      cwd: request.cwd,
      env: request.env,
      nativeId: request.nativeId,
      model: session.model,
      effort: session.effort,
      permissionMode: request.permissionMode,
      title: session.title ?? session.name,
      onLine: request.onLine,
      ...(request.onNativeId ? { onNativeId: request.onNativeId } : {}),
      ...(request.onNotice ? { onNotice: request.onNotice } : {}),
      ...(request.onUsage ? { onUsage: request.onUsage } : {}),
      ...(request.clientVersion ? { clientVersion: request.clientVersion } : {}),
    });
  },
};
