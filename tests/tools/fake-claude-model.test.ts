import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgv } from '../../tools/fake-claude/args.ts';
import type { JsonObject } from '../../tools/fake-claude/json.ts';
import { effortWarning } from '../../tools/fake-claude/model.ts';
import { BASELINE, type FakeEnv, type FakeRun, makeFakeEnv, spawnFake, userLine } from '../helpers/fake-claude.ts';

/**
 * fake-claude's model and effort (D31, docs/fake-claude.md → *Model and effort*):
 * `initialize` lists the recorded models (effort levels on some; none with
 * `FAKE_CLAUDE_MODELS=none`), `set_model` and `apply_flag_settings {effortLevel}`
 * answer as the probed CLI does (bare success, `Model '<x>' not found`), the env
 * switches refuse them with a given text, `get_settings` and later `system/init`
 * lines echo the choice, and `--model` / `--effort` are accepted and logged.
 */

const SID = '5e0c9a52-0000-4000-8000-00000000d31a';

let env: FakeEnv;
let runs: FakeRun[] = [];

function start(extraEnv: Record<string, string> = {}, extraArgs: readonly string[] = []): FakeRun {
  const run = spawnFake([...BASELINE, '--session-id', SID, ...extraArgs], { cwd: env.cwd, env: { CLAUDE_CONFIG_DIR: env.configDir, FAKE_CLAUDE_LOG: env.logFile, ...extraEnv } });
  runs.push(run);
  return run;
}

function obj(value: unknown): JsonObject {
  return value as JsonObject;
}

function control(requestId: string, request: JsonObject): JsonObject {
  return { type: 'control_request', request_id: requestId, request };
}

async function reply(fake: FakeRun, requestId: string): Promise<JsonObject> {
  const line = await fake.waitFor((l) => l['type'] === 'control_response' && obj(l['response'])['request_id'] === requestId);
  return obj(line['response']);
}

async function applied(fake: FakeRun, requestId: string): Promise<JsonObject> {
  fake.send(control(requestId, { subtype: 'get_settings' }));
  return obj(obj((await reply(fake, requestId))['response'])['applied']);
}

beforeEach(async () => {
  env = await makeFakeEnv('fake-model');
  runs = [];
});

afterEach(async () => {
  for (const run of runs) {
    if (run.child.exitCode === null && run.child.signalCode === null) {
      run.kill('SIGKILL');
      await run.exited;
    }
  }
  await env.cleanup();
});

describe('fake-claude · models, set_model, effort (D31)', () => {
  it('initialize lists the recorded models (efforts on some, none on Haiku); FAKE_CLAUDE_MODELS=none leaves the list out', async () => {
    const fake = start();
    fake.send(control('i1', { subtype: 'initialize', hooks: null }));
    const models = obj((await reply(fake, 'i1'))['response'])['models'] as JsonObject[];
    expect(models.map((m) => m['value'])).toContain('opus');
    expect(models.find((m) => m['value'] === 'opus')?.['supportedEffortLevels']).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(models.find((m) => m['value'] === 'haiku')?.['supportedEffortLevels']).toBeUndefined();
    const none = start({ FAKE_CLAUDE_MODELS: 'none' });
    none.send(control('i2', { subtype: 'initialize', hooks: null }));
    const response = obj((await reply(none, 'i2'))['response']);
    expect(response['models']).toBeUndefined();
    expect(response['remote_control_available']).toBe(true);
  });

  it('set_model: a bare success for a listed model or default; Model not found for another; get_settings and system/init echo it', async () => {
    const fake = start();
    expect(await applied(fake, 'g0')).toEqual({ model: 'claude-haiku-4-5-20251001', effort: null, advisor: null, ultracode: false });
    fake.send(control('m1', { subtype: 'set_model', model: 'opus' }));
    expect(await reply(fake, 'm1')).toEqual({ subtype: 'success', request_id: 'm1' });
    expect((await applied(fake, 'g1'))['model']).toBe('claude-opus-5-5');
    fake.send(control('m2', { subtype: 'set_model', model: 'gpt-4' }));
    expect(await reply(fake, 'm2')).toEqual({ subtype: 'error', request_id: 'm2', error: "Model 'gpt-4' not found", error_code: 'catalog_unknown' });
    expect((await applied(fake, 'g2'))['model']).toBe('claude-opus-5-5');
    // The next turn's system/init reports the chosen model.
    fake.send(userLine('Reply with just OK.'));
    const init = await fake.waitFor((l) => l['type'] === 'system' && l['subtype'] === 'init');
    expect(init['model']).toBe('claude-opus-5-5');
    fake.send(control('m3', { subtype: 'set_model', model: 'default' }));
    expect(await reply(fake, 'm3')).toEqual({ subtype: 'success', request_id: 'm3' });
    expect((await applied(fake, 'g3'))['model']).toBe('claude-haiku-4-5-20251001');
  });

  it('apply_flag_settings {effortLevel}: a bare success for a level or null (unchecked, as the CLI); a settings that is no object is an error', async () => {
    const fake = start();
    fake.send(control('e1', { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } }));
    expect(await reply(fake, 'e1')).toEqual({ subtype: 'success', request_id: 'e1' });
    expect((await applied(fake, 'g1'))['effort']).toBe('high');
    fake.send(control('e2', { subtype: 'apply_flag_settings', settings: { effortLevel: null } }));
    expect(await reply(fake, 'e2')).toEqual({ subtype: 'success', request_id: 'e2' });
    expect((await applied(fake, 'g2'))['effort']).toBeNull();
    fake.send(control('e3', { subtype: 'apply_flag_settings', settings: 'high' }));
    expect(await reply(fake, 'e3')).toEqual({ subtype: 'error', request_id: 'e3', error: 'apply_flag_settings requires `settings` to be an object, got string' });
    // There is no set_effort in CLI 2.1.283 (probed): the fake refuses it the same way.
    fake.send(control('e4', { subtype: 'set_effort', effort: 'high' }));
    expect(await reply(fake, 'e4')).toEqual({ subtype: 'error', request_id: 'e4', error: 'Unsupported control request subtype: set_effort' });
  });

  it('FAKE_CLAUDE_SET_MODEL_ERROR / FAKE_CLAUDE_EFFORT_ERROR refuse them with that text, verbatim; nothing changes', async () => {
    const fake = start({ FAKE_CLAUDE_SET_MODEL_ERROR: 'Model switch blocked by a PreModelSwitch hook', FAKE_CLAUDE_EFFORT_ERROR: 'Effort changes are turned off' });
    fake.send(control('m1', { subtype: 'set_model', model: 'opus' }));
    expect(await reply(fake, 'm1')).toEqual({ subtype: 'error', request_id: 'm1', error: 'Model switch blocked by a PreModelSwitch hook' });
    fake.send(control('e1', { subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } }));
    expect(await reply(fake, 'e1')).toEqual({ subtype: 'error', request_id: 'e1', error: 'Effort changes are turned off' });
    expect(await applied(fake, 'g1')).toMatchObject({ model: 'claude-haiku-4-5-20251001', effort: null });
  });

  it('--model / --effort at spawn: taken (and logged with the argv); an unknown --effort only warns, like the CLI', async () => {
    const fake = start({}, ['--model', 'claude-sonnet-4-6', '--effort', 'max']);
    expect(await applied(fake, 'g1')).toMatchObject({ model: 'claude-sonnet-4-6', effort: 'max' });
    const [argv] = (await readFile(env.logFile, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; argv?: string[] });
    expect(argv?.kind).toBe('argv');
    expect(argv?.argv).toEqual([...BASELINE, '--session-id', SID, '--model', 'claude-sonnet-4-6', '--effort', 'max']);

    const warned = start({}, ['--effort', 'turbo']);
    expect((await applied(warned, 'g2'))['effort']).toBeNull();
    expect(warned.stderr()).toContain(effortWarning('turbo'));
    expect(parseArgv(['-p', '--effort=high']).kind === 'run' && (parseArgv(['-p', '--effort=high']) as { args: { effort: string } }).args.effort).toBe('high');
  });
});
