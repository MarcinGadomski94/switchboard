import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { BackupError, type BackupService } from '../backup/service.ts';

/**
 * D168 · backup and restore (`docs/backup.md`, contract → *Backup (D168)*). Local only: refused to
 * paired phones (`devices/local-only.ts`) and never on the peer API.
 *
 * - `GET /api/backup` → `BackupStatus` (the automatic backups, the backup folder's files, the last
 *   run, the last restore's report, whether Switchboard restarts by itself).
 * - `POST /api/backup { passphrase }` → the finished run (`BackupLastRun`) · 409 `busy` · 422.
 * - `PUT /api/backup/auto { enabled?, folder?, keep?, passphrase? }` → `BackupStatus` · 422 · 503.
 * - `GET /api/backup/files/{name}` → the file (a download).
 * - `POST /api/backup/inspect { file, passphrase, map? }` → `BackupInspection` · 401 `wrong-passphrase` · 404 · 422 `damaged`.
 * - `POST /api/backup/restore { file, passphrase, map, identity, replace?, allowMissing? }` → `{ restart }`
 *   (`restarting`: Switchboard restarts and applies it; `manual`: restart it by hand) · 401 · 409 `not-fresh` /
 *   `missing-folders` (`detail`: the folders) / `newer-backup` / `busy` · 422.
 * - `DELETE /api/backup/restore` → 204: drops a prepared restore not applied yet.
 */
export async function registerBackupRoutes(app: FastifyInstance, service: BackupService | undefined): Promise<void> {
  if (!service) return;
  const send = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof BackupError) return reply.code(error.status).header('cache-control', 'no-store').send({ error: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) });
    throw error;
  };
  app.get('/api/backup', async () => service.status());
  app.post('/api/backup', async (request, reply) => {
    try {
      return await service.backupNow(request.body);
    } catch (error) {
      return send(reply, error);
    }
  });
  app.put('/api/backup/auto', async (request, reply) => {
    try {
      return await service.setAuto(request.body);
    } catch (error) {
      return send(reply, error);
    }
  });
  app.get<{ Params: { name: string } }>('/api/backup/files/:name', async (request, reply) => {
    const file = await service.fileOf(request.params.name);
    if (!file) return reply.code(404).send({ error: 'not-found', message: 'There is no such backup file.' });
    const info = await stat(file);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(info.size))
      .header('content-disposition', `attachment; filename="${path.basename(file)}"`)
      .header('cache-control', 'no-store')
      .send(createReadStream(file));
  });
  app.post('/api/backup/inspect', async (request, reply) => {
    try {
      return await service.inspect(request.body);
    } catch (error) {
      return send(reply, error);
    }
  });
  app.post('/api/backup/restore', async (request, reply) => {
    try {
      return await service.restore(request.body);
    } catch (error) {
      return send(reply, error);
    }
  });
  app.delete('/api/backup/restore', async (_request, reply) => {
    await service.cancelRestore();
    return reply.code(204).send();
  });
}
