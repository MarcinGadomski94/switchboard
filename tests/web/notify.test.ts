import { describe, expect, it } from 'vitest';
import type { InboxItem, Question } from '../../src/core/api.ts';
import {
  CHIME_CLOSE_MS,
  CHIME_RESUME_MS,
  type ChimeContext,
  type ChimeContextFactory,
  type ChimeTimers,
  type OsNotificationFactory,
  type QuestionBatchEvent,
  notifyOs,
  osTitle,
  playChime,
  questionNotice,
  questionSub,
} from '../../src/web/toast/notify.ts';

function question(id: string, text: string): Question {
  return {
    id,
    batchId: 'req-1',
    sessionId: 's1',
    source: 'orchestrator',
    text,
    header: null,
    options: [{ label: 'Yes' }, { label: 'No' }],
    multiSelect: false,
    state: 'open',
    answerIndex: null,
    answeredAt: null,
  };
}

const ONE: QuestionBatchEvent = { sessionId: 's1', batchId: 'req-1', questions: [question('q1', 'Which environment should I target?')] };
const TWO: QuestionBatchEvent = {
  sessionId: 's1',
  batchId: 'req-2',
  questions: [question('q1', 'Which color should the button be?'), question('q2', 'Which size should it be?')],
};

function inboxItem(event: QuestionBatchEvent, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: event.batchId,
    kind: 'questions',
    sessionId: event.sessionId,
    source: 'qa-free-talk',
    status: 'need',
    title: event.questions[0]?.text ?? '',
    label: 'Question',
    detail: '',
    createdAt: '2026-09-28T00:00:00.000Z',
    branches: [{ solution: 'acme-app-front', branch: 'qa/free-talk-e2e' }],
    questions: event.questions,
    ...overrides,
  };
}

describe('questionNotice (toast + OS notification of a question batch)', () => {
  it('uses the prototype copy: `<session>` / `question · now` / `solution ⎇ branch`, the question verbatim, `<session> needs you`', () => {
    expect(questionNotice(ONE, inboxItem(ONE), null)).toEqual({
      toast: {
        id: 'req-1',
        title: 'qa-free-talk',
        sub: 'question · now',
        branch: 'acme-app-front ⎇ qa/free-talk-e2e',
        text: 'Which environment should I target?',
        sessionId: 's1',
      },
      os: { title: 'qa-free-talk needs you', body: 'Which environment should I target?', tag: 'switchboard-batch-req-1' },
    });
  });

  it('counts the questions of a batch and shows the first one', () => {
    const notice = questionNotice(TWO, inboxItem(TWO), null);
    expect(notice.toast.sub).toBe('2 questions · now');
    expect(notice.toast.text).toBe('Which color should the button be?');
    expect(notice.os.body).toBe('Which color should the button be?');
  });

  it('joins several branch chips and leaves the branch line empty without any', () => {
    const many = inboxItem(ONE, {
      branches: [
        { solution: 'web-front', branch: 'session/a' },
        { solution: 'mobile', branch: 'session/a' },
      ],
    });
    expect(questionNotice(ONE, many, null).toast.branch).toBe('web-front ⎇ session/a · mobile ⎇ session/a');
    expect(questionNotice(ONE, inboxItem(ONE, { branches: [] }), null).toast.branch).toBe('');
  });

  it('without the Inbox item: the session name from the list, else the session id; questions from the event', () => {
    const named = questionNotice(TWO, null, 'asker');
    expect(named.toast.title).toBe('asker');
    expect(named.toast.branch).toBe('');
    expect(named.toast.sub).toBe('2 questions · now');
    expect(named.os.title).toBe('asker needs you');
    expect(questionNotice(TWO, null, null).toast.title).toBe('s1');
  });

  it('helpers', () => {
    expect(questionSub(1)).toBe('question · now');
    expect(questionSub(3)).toBe('3 questions · now');
    expect(osTitle('free-talk')).toBe('free-talk needs you');
  });
});

/** A recording AudioContext double. */
function audioWorld(options: { state?: string; resume?: 'resolve' | 'reject' | 'hang'; throwOnCreate?: boolean } = {}) {
  const log: string[] = [];
  const contexts: FakeContext[] = [];
  class FakeParam {
    value = 0;
    readonly name: string;
    constructor(name: string) {
      this.name = name;
    }
    setValueAtTime(value: number, time: number): void {
      log.push(`${this.name}.set ${value} @${time}`);
    }
    exponentialRampToValueAtTime(value: number, time: number): void {
      log.push(`${this.name}.ramp ${value} @${round(time)}`);
    }
  }
  class FakeContext implements ChimeContext {
    currentTime = 10;
    state = options.state ?? 'running';
    destination = { name: 'destination' };
    closed = 0;
    constructor() {
      if (options.throwOnCreate) throw new Error('no audio');
      contexts.push(this);
    }
    createOscillator() {
      const frequency = new FakeParam('frequency');
      return {
        frequency,
        connect: (target: unknown) => log.push(`osc(${frequency.value}) → ${target === this.destination ? 'destination' : 'gain'}`),
        start: (when?: number) => log.push(`osc(${frequency.value}).start @${round(when ?? -1)}`),
        stop: (when?: number) => log.push(`osc(${frequency.value}).stop @${round(when ?? -1)}`),
      };
    }
    createGain() {
      return { gain: new FakeParam('gain'), connect: (target: unknown) => log.push(`gain → ${target === this.destination ? 'destination' : '?'}`) };
    }
    resume(): Promise<void> {
      log.push('resume');
      if (options.resume === 'resolve') {
        this.state = 'running';
        return Promise.resolve();
      }
      if (options.resume === 'reject') return Promise.reject(new Error('not allowed'));
      return new Promise(() => undefined);
    }
    close(): Promise<void> {
      this.closed += 1;
      this.state = 'closed';
      return Promise.resolve();
    }
  }
  const pending: Array<{ run: () => void; ms: number }> = [];
  const timers: ChimeTimers = { after: (run, ms) => pending.push({ run, ms }) };
  return { Context: FakeContext as unknown as ChimeContextFactory, contexts, log, pending, timers };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

describe('playChime (prototype beep(): 784 Hz → 1046 Hz)', () => {
  it('schedules the two tones with the prototype envelope, then closes its context after the tones', async () => {
    const world = audioWorld();
    expect(await playChime(world.Context, world.timers)).toBe(true);
    expect(world.log).toEqual([
      'gain.set 0.0001 @10',
      'gain.ramp 0.12 @10.02',
      'gain.ramp 0.0001 @10.22',
      'osc(784) → gain',
      'gain → destination',
      'osc(784).start @10',
      'osc(784).stop @10.25',
      'gain.set 0.0001 @10.14',
      'gain.ramp 0.12 @10.16',
      'gain.ramp 0.0001 @10.36',
      'osc(1046) → gain',
      'gain → destination',
      'osc(1046).start @10.14',
      'osc(1046).stop @10.39',
    ]);
    expect(world.contexts).toHaveLength(1);
    expect(world.contexts[0]?.closed).toBe(0);
    expect(world.pending.map((p) => p.ms)).toEqual([CHIME_CLOSE_MS]);
    world.pending[0]?.run();
    expect(world.contexts[0]?.closed).toBe(1);
  });

  it('resumes a suspended context and plays once it runs', async () => {
    const world = audioWorld({ state: 'suspended', resume: 'resolve' });
    expect(await playChime(world.Context, world.timers)).toBe(true);
    expect(world.log[0]).toBe('resume');
    expect(world.log.filter((line) => line.includes('.start'))).toHaveLength(2);
  });

  it('plays nothing and closes the context when the autoplay policy keeps it suspended (rejected or pending resume)', async () => {
    const rejected = audioWorld({ state: 'suspended', resume: 'reject' });
    expect(await playChime(rejected.Context, rejected.timers)).toBe(false);
    expect(rejected.log).toEqual(['resume']);
    expect(rejected.contexts[0]?.closed).toBe(1);

    const hanging = audioWorld({ state: 'suspended', resume: 'hang' });
    const result = playChime(hanging.Context, hanging.timers);
    await Promise.resolve();
    expect(hanging.pending.map((p) => p.ms)).toEqual([CHIME_RESUME_MS]);
    hanging.pending[0]?.run();
    expect(await result).toBe(false);
    expect(hanging.log).toEqual(['resume']);
    expect(hanging.contexts[0]?.closed).toBe(1);
  });

  it('does nothing without Web Audio, or when the context cannot be created', async () => {
    expect(await playChime(null)).toBe(false);
    const broken = audioWorld({ throwOnCreate: true });
    expect(await playChime(broken.Context, broken.timers)).toBe(false);
    expect(broken.log).toEqual([]);
  });
});

/** A recording Notification double. */
function notificationWorld(permission: string, throwOnCreate = false) {
  const sent: Array<{ title: string; options: { body: string; tag: string }; closed: number; onclick: (() => unknown) | null }> = [];
  class FakeNotification {
    static permission = permission;
    readonly title: string;
    readonly options: { body: string; tag: string };
    closed = 0;
    onclick: (() => unknown) | null = null;
    constructor(title: string, options: { body: string; tag: string }) {
      if (throwOnCreate) throw new TypeError('Illegal constructor');
      this.title = title;
      this.options = options;
      sent.push(this);
    }
    close(): void {
      this.closed += 1;
    }
  }
  return { Ctor: FakeNotification as unknown as OsNotificationFactory, sent };
}

describe('notifyOs (Web Notifications API)', () => {
  const notice = { title: 'qa-free-talk needs you', body: 'Which environment should I target?', tag: 'switchboard-batch-req-1' };

  it('sends one when granted; a click runs the jump and closes it', () => {
    const world = notificationWorld('granted');
    let jumps = 0;
    const notification = notifyOs(notice, () => (jumps += 1), world.Ctor);
    expect(notification).not.toBeNull();
    expect(world.sent.map((n) => [n.title, n.options])).toEqual([
      ['qa-free-talk needs you', { body: 'Which environment should I target?', tag: 'switchboard-batch-req-1' }],
    ]);
    world.sent[0]?.onclick?.();
    expect(jumps).toBe(1);
    expect(world.sent[0]?.closed).toBe(1);
  });

  it('sends nothing unless granted (default, denied), without the API, or when the constructor throws', () => {
    for (const permission of ['default', 'denied']) {
      const world = notificationWorld(permission);
      expect(notifyOs(notice, () => undefined, world.Ctor)).toBeNull();
      expect(world.sent).toEqual([]);
    }
    expect(notifyOs(notice, () => undefined, null)).toBeNull();
    expect(notifyOs(notice, () => undefined, notificationWorld('granted', true).Ctor)).toBeNull();
  });
});
