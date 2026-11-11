import { EventEmitter } from 'node:events';

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveAnnouncement } from '@/features/announcements/actions';
import type { AnnouncementInput } from '@/features/announcements/announcements';
import { sendAnnouncementEmails } from '@/features/announcements/email';
import { EmailError, sendEmail, sendFailure, type EmailConfig } from '@/lib/email/resend';
import { jobRun, runExclusive } from '@/lib/jobs';
import { stopJobsOnSigterm } from '@/lib/shutdown';
import type { Database } from '@/types/database';

// Announcement emails in runs that the next run resumes (docs/DECISIONS.md VPS-28): the list read
// again each round, send starts paced, and what each of Resend's answers leaves for the next run.

const next = vi.hoisted(() => ({ tasks: [] as (() => Promise<unknown>)[] }));
vi.mock('next/server', () => ({
  after: (task: () => Promise<unknown>) => next.tasks.push(task),
}));
vi.mock('next/cache', () => ({ refresh: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ requirePlatformPermission: async () => ({}) }));
const db = vi.hoisted(() => ({ admin: null as unknown, save: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ rpc: db.save }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.admin }));
const mail = vi.hoisted(() => ({ config: null as unknown }));
vi.mock('@/lib/email/resend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/resend')>()),
  emailConfig: () => mail.config,
}));
vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env')>()),
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: APP }),
}));

const APP = 'https://menumesh.test';

type Due = Database['public']['Functions']['announcement_emails_next']['Returns'][number];

const due = (announcement: string, restaurant: string): Due => ({
  announcement_id: announcement,
  restaurant_id: restaurant,
  title: `News ${announcement}`,
  body: 'Text',
  recipients: [`owner@${restaurant}.test`],
});
const pair = (announcement: string, restaurant: string) => ({
  p_announcement_id: announcement,
  p_restaurant_id: restaurant,
});

/**
 * A database holding these due emails. Its list leaves out the ones recorded or set aside, as
 * announcement_emails_next does, p_limit at a time; `fail` gives a call an error.
 */
function fakeDb(emails: Due[], { fail }: { fail?: string } = {}) {
  const waiting = [...emails];
  const done = new Set<string>();
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === fail) return { data: null, error: { message: 'connection refused' } };
    if (fn === 'announcement_emails_next') {
      const left = waiting.filter((e) => !done.has(`${e.announcement_id}/${e.restaurant_id}`));
      return { data: left.slice(0, args.p_limit as number), error: null };
    }
    done.add(`${args.p_announcement_id}/${args.p_restaurant_id}`);
    return { data: null, error: null };
  });
  const calls = (fn: string) => rpc.mock.calls.filter(([name]) => name === fn).map(([, a]) => a);
  return { admin: { rpc } as unknown as SupabaseClient<Database>, rpc, calls, waiting };
}

/** One of Resend's answers. */
const answer = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;
const accepted = () => answer(200, { id: 'email_1' });
const busy = () =>
  answer(409, {
    statusCode: 409,
    message: 'There is another request in progress with the same idempotency key.',
    name: 'concurrent_idempotent_requests',
  });
const usedBefore = () =>
  answer(409, {
    statusCode: 409,
    message:
      'This idempotency key has been used with this HTTP method and endpoint within the last 24 hours, but the request body was modified.',
    name: 'invalid_idempotent_request',
  });
const refused = (address = 'owner@r1.test') =>
  answer(422, {
    statusCode: 422,
    message: `Invalid \`to\` field: ${address}`,
    name: 'validation_error',
  });

type Reply = (init: RequestInit) => Response | Promise<Response>;

/** Resend's own trouble, nothing to do with the email: what sendFailure calls unavailable. */
const troubles: [string, Reply][] = [
  [
    'does not answer in time',
    (init) =>
      new Promise((_, reject) =>
        init.signal!.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        ),
      ),
  ],
  [
    'cannot be reached',
    () => {
      throw new TypeError('fetch failed');
    },
  ],
  ['answers 401', () => answer(401, { name: 'missing_api_key' })],
  ['answers 403', () => answer(403, { name: 'validation_error' })],
  ['answers 429', () => answer(429, { name: 'rate_limit_exceeded' })],
  ['answers 500', () => answer(500, { name: 'application_error' })],
];

/** Resend, answering each key as given and any other with an accepted email. */
function resend(replies: Record<string, Reply> = {}, otherwise: Reply = accepted) {
  return vi.fn(async (_url: RequestInfo | URL, init: RequestInit = {}) => {
    const key = (init.headers as Record<string, string>)['Idempotency-Key']!;
    return (replies[key] ?? otherwise)(init);
  });
}
const keysSent = (fetchImpl: ReturnType<typeof resend>) =>
  fetchImpl.mock.calls.map(
    ([, init]) => (init!.headers as Record<string, string>)['Idempotency-Key'],
  );

const config = (fetchImpl: typeof fetch): EmailConfig => ({
  apiKey: 're_test',
  from: 'MenuMesh <news@menumesh.test>',
  baseUrl: 'https://resend.test',
  fetchImpl,
});

/** A run of the emails, with no pause between sends unless the case gives one. */
const send = (
  admin: SupabaseClient<Database>,
  fetchImpl: typeof fetch,
  options: Partial<Parameters<typeof sendAnnouncementEmails>[3]> = {},
) =>
  sendAnnouncementEmails(admin, config(fetchImpl), APP, {
    run: jobRun(60_000),
    pauseMs: 0,
    ...options,
  });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** A process with its own SIGTERM listener, as Next.js's has, that then gets SIGTERM. */
function stopTheServer() {
  const proc = new EventEmitter();
  proc.on('SIGTERM', () => undefined);
  stopJobsOnSigterm(proc);
  proc.emit('SIGTERM');
}

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  const holder = globalThis as Record<symbol, unknown>;
  delete holder[Symbol.for('menumesh.drain')];
  delete holder[Symbol.for('menumesh.jobGates')];
  delete holder[Symbol.for('menumesh.announcementEmailsPausedUntil')];
  next.tasks = [];
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  // No send's timer outlives it.
  if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('sendAnnouncementEmails', () => {
  it('sends each due email under its key, in turn, and records it', async () => {
    const { admin, calls } = fakeDb([due('a1', 'r1'), due('a1', 'r2'), due('a2', 'r1')]);
    const fetchImpl = resend();

    await expect(
      send(admin, fetchImpl, { now: () => new Date('2026-11-08T21:30:00.000Z') }),
    ).resolves.toEqual({ sent: 3, duplicate: 0, refused: 0 });

    expect(keysSent(fetchImpl)).toEqual([
      'announcement/a1/r1',
      'announcement/a1/r2',
      'announcement/a2/r1',
    ]);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string).to).toEqual(['owner@r2.test']);
    expect(calls('announcement_email_sent')).toEqual([
      pair('a1', 'r1'),
      pair('a1', 'r2'),
      pair('a2', 'r1'),
    ]);
    expect(calls('announcement_emails_next')[0]).toEqual({
      p_at: '2026-11-08T21:30:00.000Z',
      p_limit: 50,
      p_minute_job: false,
    });
    expect(info).toHaveBeenCalledWith('[announcements] emails', {
      sent: 3,
      duplicate: 0,
      refused: 0,
    });
  });

  it('starts sends at least 600 ms apart, and adds no pause after a slow one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { admin } = fakeDb([due('a1', 'r1'), due('a1', 'r2'), due('a1', 'r3')]);
    const starts: number[] = [];
    const fetchImpl = resend({}, async () => {
      starts.push(Date.now());
      // The first answers after a second.
      if (starts.length === 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
      return accepted();
    });

    const running = sendAnnouncementEmails(admin, config(fetchImpl), APP, { run: jobRun(60_000) });
    await vi.runAllTimersAsync();
    await expect(running).resolves.toMatchObject({ sent: 3 });
    expect(starts.map((at) => at - starts[0]!)).toEqual([0, 1_000, 1_600]);
  });

  it('starts no send once the run stops starting work, and records the one it started', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { admin, calls } = fakeDb([due('a1', 'r1'), due('a1', 'r2'), due('a1', 'r3')]);
    const fetchImpl = resend();

    // Starts at 0 and 600 ms; the third would start at 1,200 ms, past the budget.
    const running = sendAnnouncementEmails(admin, config(fetchImpl), APP, { run: jobRun(1_000) });
    await vi.runAllTimersAsync();
    await expect(running).resolves.toEqual({ sent: 2, duplicate: 0, refused: 0 });
    expect(keysSent(fetchImpl)).toEqual(['announcement/a1/r1', 'announcement/a1/r2']);
    expect(calls('announcement_emails_next')).toHaveLength(1);
  });

  it('records the send in flight when the server stops, and starts no other', async () => {
    const { admin, calls } = fakeDb([due('a1', 'r1'), due('a1', 'r2')]);
    const fetchImpl = resend({}, () => {
      stopTheServer();
      return accepted();
    });

    await expect(send(admin, fetchImpl)).resolves.toEqual({ sent: 1, duplicate: 0, refused: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls('announcement_email_sent')).toEqual([pair('a1', 'r1')]);
  });

  it('leaves one Resend is still busy with for the next run, and records one it already has', async () => {
    const { admin, calls } = fakeDb([due('a1', 'r1'), due('a1', 'r2'), due('a1', 'r3')]);
    const fetchImpl = resend({ 'announcement/a1/r1': busy, 'announcement/a1/r2': usedBefore });

    await expect(send(admin, fetchImpl)).resolves.toEqual({ sent: 1, duplicate: 1, refused: 0 });
    // Asked once: it stays due, for the next run.
    expect(keysSent(fetchImpl)).toEqual([
      'announcement/a1/r1',
      'announcement/a1/r2',
      'announcement/a1/r3',
    ]);
    expect(calls('announcement_email_sent')).toEqual([pair('a1', 'r2'), pair('a1', 'r3')]);
    expect(calls('announcement_email_failed')).toEqual([]);
    expect(calls('announcement_emails_next')).toHaveLength(2);
  });

  it('sets a refused email aside and goes on with the others', async () => {
    const emails = ['r1', 'r2', 'r3', 'r4', 'r5'].map((r) => due('a1', r));
    const { admin, calls } = fakeDb(emails);
    // Two refusals, a send, then two more: never three in a row.
    const fetchImpl = resend({ 'announcement/a1/r3': accepted }, () => refused());

    await expect(send(admin, fetchImpl)).resolves.toEqual({ sent: 1, duplicate: 0, refused: 4 });
    const setAside = calls('announcement_email_failed');
    expect(setAside.map(({ p_restaurant_id }) => p_restaurant_id)).toEqual([
      'r1',
      'r2',
      'r4',
      'r5',
    ]);
    expect(setAside[0]).toEqual({
      ...pair('a1', 'r1'),
      p_error: expect.stringContaining('Resend answered 422'),
    });
    // Resend's answer named the address: what is kept doesn't.
    expect(setAside[0]!.p_error).not.toContain('owner@r1.test');
    expect(calls('announcement_email_sent')).toEqual([pair('a1', 'r3')]);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(error).not.toHaveBeenCalled();
  });

  it('stops at three refusals in a row and sends none for 30 minutes in this process', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = fakeDb(['r1', 'r2', 'r3', 'r4'].map((r) => due('a1', r)));
    const fetchImpl = resend({}, () => refused());

    await expect(send(first.admin, fetchImpl)).resolves.toEqual({
      sent: 0,
      duplicate: 0,
      refused: 3,
      stopped: 'refused',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(first.calls('announcement_email_failed')).toHaveLength(3);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('check EMAIL_FROM'),
      expect.any(EmailError),
    );

    const later = fakeDb([due('a2', 'r9')]);
    vi.setSystemTime(Date.now() + 29 * 60_000);
    await expect(send(later.admin, resend())).resolves.toEqual({ skipped: 'paused' });
    expect(later.rpc).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 60_000);
    await expect(send(later.admin, resend())).resolves.toEqual({
      sent: 1,
      duplicate: 0,
      refused: 0,
    });
  });

  it.each(troubles)(
    'ends the minute job’s run with nothing recorded when Resend %s',
    async (_case, reply) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const { admin, rpc } = fakeDb([due('a1', 'r1'), due('a1', 'r2')]);
      const fetchImpl = resend({}, reply);

      // Its next run comes within a minute.
      const running = send(admin, fetchImpl, { minuteJob: true });
      await vi.runAllTimersAsync();
      await expect(running).resolves.toEqual({
        sent: 0,
        duplicate: 0,
        refused: 0,
        stopped: 'unavailable',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls.map(([fn]) => fn)).toEqual(['announcement_emails_next']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    },
  );

  it('goes on past Resend’s trouble in a save or the daily run, and leaves that email due', async () => {
    const { admin, calls } = fakeDb([due('a1', 'r1'), due('a1', 'r2'), due('a1', 'r3')]);
    const fetchImpl = resend({
      'announcement/a1/r1': () => answer(500, { name: 'application_error' }),
    });

    // On Vercel no minute job comes: the others still go.
    await expect(send(admin, fetchImpl)).resolves.toEqual({ sent: 2, duplicate: 0, refused: 0 });
    // Asked once: it stays due, for the next run.
    expect(keysSent(fetchImpl)).toEqual([
      'announcement/a1/r1',
      'announcement/a1/r2',
      'announcement/a1/r3',
    ]);
    expect(calls('announcement_email_sent')).toEqual([pair('a1', 'r2'), pair('a1', 'r3')]);
    expect(calls('announcement_email_failed')).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it.each(troubles)(
    'ends a save’s or the daily run when Resend %s three times since an email last went',
    async (_case, reply) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const { admin, calls } = fakeDb(
        ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((r) => due('a1', r)),
      );
      // Trouble, a send that starts the count again, then trouble three times.
      const fetchImpl = resend(
        { 'announcement/a1/r2': accepted, 'announcement/a1/r6': accepted },
        reply,
      );

      const running = send(admin, fetchImpl);
      await vi.runAllTimersAsync();
      await expect(running).resolves.toEqual({
        sent: 1,
        duplicate: 0,
        refused: 0,
        stopped: 'unavailable',
      });
      expect(keysSent(fetchImpl)).toEqual(
        ['r1', 'r2', 'r3', 'r4', 'r5'].map((r) => `announcement/a1/${r}`),
      );
      expect(calls('announcement_email_sent')).toEqual([pair('a1', 'r2')]);
      expect(calls('announcement_email_failed')).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(4);
      expect(error).not.toHaveBeenCalled();
    },
  );

  it('ends the run when a send cannot be recorded, for the next run to record', async () => {
    const { admin } = fakeDb([due('a1', 'r1'), due('a1', 'r2')], {
      fail: 'announcement_email_sent',
    });
    const fetchImpl = resend();

    await expect(send(admin, fetchImpl)).resolves.toEqual({
      sent: 0,
      duplicate: 0,
      refused: 0,
      stopped: 'database',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      '[announcements] sent but not recorded',
      'a1/r1',
      'connection refused',
    );
  });

  it('ends the run when a refusal cannot be recorded', async () => {
    const { admin } = fakeDb([due('a1', 'r1'), due('a1', 'r2')], {
      fail: 'announcement_email_failed',
    });
    const fetchImpl = resend({}, () => refused());

    await expect(send(admin, fetchImpl)).resolves.toEqual({
      sent: 0,
      duplicate: 0,
      refused: 0,
      stopped: 'database',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lists the emails again each round, so it sends those that came due meanwhile', async () => {
    const emails = Array.from({ length: 52 }, (_, n) => due('a1', `r${n}`));
    const store = fakeDb(emails);
    const fetchImpl = resend({}, () => {
      // A restaurant joins a running announcement's audience.
      if (fetchImpl.mock.calls.length === 1) store.waiting.push(due('a2', 'joined'));
      return accepted();
    });

    await expect(send(store.admin, fetchImpl)).resolves.toEqual({
      sent: 53,
      duplicate: 0,
      refused: 0,
    });
    // 50, then the 3 left, then none.
    expect(store.calls('announcement_emails_next')).toHaveLength(3);
    expect(store.calls('announcement_emails_next').map((args) => args.p_limit)).toEqual([
      50, 50, 50,
    ]);
    expect(keysSent(fetchImpl).at(-1)).toBe('announcement/a2/joined');
  });

  it('lists past the emails it left due, so that every due email is asked for once', async () => {
    const emails = Array.from({ length: 150 }, (_, n) => due('a1', `r${100 + n}`));
    const { admin, calls } = fakeDb(emails);
    // 429 and 200 in turn, as with a rate limit shared with another sender: never three unavailable
    // answers since an email last went, so a save's run goes on, and the 429s stay due, first.
    const fetchImpl = resend({}, () =>
      fetchImpl.mock.calls.length % 2 === 1
        ? answer(429, { name: 'rate_limit_exceeded' })
        : accepted(),
    );

    await expect(send(admin, fetchImpl)).resolves.toEqual({ sent: 75, duplicate: 0, refused: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(150);
    expect(new Set(keysSent(fetchImpl)).size).toBe(150);
    expect(calls('announcement_email_sent')).toHaveLength(75);
    // Each round holds 50 new ones beside the ones left due, then none is new.
    expect(calls('announcement_emails_next').map((args) => args.p_limit)).toEqual([
      50, 75, 100, 125,
    ]);
  });

  it('asks for the minute job’s emails when the minute job runs it, and logs nothing idle', async () => {
    const { admin, calls } = fakeDb([]);

    await expect(send(admin, resend(), { minuteJob: true })).resolves.toEqual({
      sent: 0,
      duplicate: 0,
      refused: 0,
    });
    expect(calls('announcement_emails_next')).toEqual([
      { p_at: expect.any(String), p_limit: 50, p_minute_job: true },
    ]);
    expect(info).not.toHaveBeenCalled();
  });

  it('throws when the list cannot be read', async () => {
    const { admin } = fakeDb([], { fail: 'announcement_emails_next' });
    await expect(send(admin, resend())).rejects.toThrow(
      'Could not list due announcement emails: connection refused',
    );
  });
});

describe('sendFailure', () => {
  const email = {
    to: ['owner@r1.test'],
    subject: 'News',
    html: '<p>x</p>',
    text: 'x',
    idempotencyKey: 'announcement/a1/r1',
  };
  /** What a send that Resend answered so means. */
  const failureOf = (reply: Response) =>
    sendEmail(config(vi.fn(async () => reply)), email).then(() => 'sent', sendFailure);

  it('tells a key Resend is still busy with from one it already sent', async () => {
    await expect(failureOf(busy())).resolves.toBe('in_flight');
    await expect(failureOf(usedBefore())).resolves.toBe('already_sent');
    // Any other 409 is taken as sent, as the digest's rerun is (SA-31).
    await expect(failureOf(answer(409, {}))).resolves.toBe('already_sent');
  });

  it('takes 400 and 422 as a refusal of the email, and anything else as Resend’s trouble', async () => {
    for (const status of [400, 422]) {
      await expect(failureOf(answer(status, { name: 'validation_error' }))).resolves.toBe(
        'refused',
      );
    }
    for (const status of [401, 403, 404, 408, 429, 500, 503]) {
      await expect(failureOf(answer(status, {}))).resolves.toBe('unavailable');
    }
    expect(sendFailure(new EmailError('Resend did not answer in time'))).toBe('unavailable');
    expect(sendFailure(new Error('fetch failed'))).toBe('unavailable');
  });
});

describe('saveAnnouncement', () => {
  const form = (patch: Partial<AnnouncementInput> = {}): AnnouncementInput => ({
    title: 'New menu',
    body: 'Text',
    titleHi: '',
    bodyHi: '',
    panels: ['admin'],
    audience: 'everyone',
    planCodes: [],
    cities: [],
    restaurants: [],
    startsAt: '',
    endsAt: '',
    dismissible: true,
    email: true,
    ...patch,
  });

  it('emails after the response, once a run already going has ended, by the save’s rule', async () => {
    const { admin, calls } = fakeDb([due('a1', 'r1')]);
    db.admin = admin;
    mail.config = config(resend());
    db.save.mockResolvedValue({ data: { id: 'a1', email_due: true }, error: null });
    // The minute job's run, which leaves out an announcement that hasn't started.
    const minuteJob = deferred();
    const going = runExclusive('announcement_emails', 60_000, () => minuteJob.promise);

    await expect(saveAnnouncement(form())).resolves.toEqual({ ok: true, data: { emailing: true } });
    expect(next.tasks).toHaveLength(1);
    const emailing = next.tasks[0]!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls('announcement_emails_next')).toEqual([]);

    minuteJob.resolve();
    await going;
    await emailing;
    expect(calls('announcement_emails_next')[0]).toEqual({
      p_at: expect.any(String),
      p_limit: 50,
      p_minute_job: false,
    });
    expect(calls('announcement_email_sent')).toEqual([pair('a1', 'r1')]);
  });
});
