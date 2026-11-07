import { createHmac } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { parseAttention } from '@/features/platform/home';
import { sentryIssues, type SentryConfig } from '@/features/system/checks';
import { formatBytes, formatMs, limitShare, parseSystem } from '@/features/system/system';
import { hashEmail, sendEmail, type EmailConfig, type EmailSend } from '@/lib/email/resend';
import { verifySvix } from '@/lib/email/webhook';

// System health (docs/SUPER_ADMIN_PLAN.md 14d, docs/DECISIONS.md SA-86+).

beforeAll(() => {
  vi.stubEnv('SUPABASE_SECRET_KEY', 'test-secret-key');
  vi.stubEnv('CUSTOMER_COOKIE_SECRET', 'c'.repeat(32));
});

const email = {
  to: ['Owner@Spice.test'],
  subject: 'Your trial ends',
  html: '<p>x</p>',
  text: 'x',
  idempotencyKey: 'reminder/r1/trial_ends_3d/2026-10-03',
};

function config(fetchImpl: typeof fetch, log: EmailConfig['log']): EmailConfig {
  return {
    apiKey: 're_test',
    from: 'MenuMesh <a@b.test>',
    baseUrl: 'https://resend.test',
    fetchImpl,
    log,
  };
}

describe('the email log (SA-87)', () => {
  it('logs a send by its kind, never the subject or body', async () => {
    const log = vi.fn<(send: EmailSend) => Promise<void>>(async () => undefined);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'email_1' })));
    await expect(sendEmail(config(fetchImpl, log), email)).resolves.toBe('email_1');
    expect(log).toHaveBeenCalledWith({
      kind: 'reminder',
      to: ['Owner@Spice.test'],
      status: 'sent',
      provider_id: 'email_1',
      http_status: null,
      error: null,
    });
  });

  it('logs a refusal with the address scrubbed, and a repeated key as already sent', async () => {
    const log = vi.fn<(send: EmailSend) => Promise<void>>(async () => undefined);
    const refused = vi.fn(
      async () => new Response('{"message":"Invalid to: owner@spice.test"}', { status: 422 }),
    );
    await expect(sendEmail(config(refused, log), email)).rejects.toThrow(/422/);
    expect(log.mock.calls[0]![0]).toMatchObject({ status: 'failed', http_status: 422 });
    expect(log.mock.calls[0]![0].error).toContain('[email]');
    expect(log.mock.calls[0]![0].error).not.toContain('spice.test');

    const repeated = vi.fn(async () => new Response('{}', { status: 409 }));
    await expect(sendEmail(config(repeated, log), email)).rejects.toThrow(/409/);
    expect(log.mock.calls[1]![0]).toMatchObject({
      status: 'duplicate',
      http_status: 409,
      error: null,
    });
  });

  it("doesn't fail a send the log couldn't record", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.fn(async () => {
      throw new Error('database down');
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'email_2' })));
    await expect(sendEmail(config(fetchImpl, log), email)).resolves.toBe('email_2');
    expect(error).toHaveBeenCalled();
  });

  it('hashes an address with the secret, whatever its case or spaces', () => {
    const hash = hashEmail(' Owner@Spice.test ', 'k'.repeat(32));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashEmail('owner@spice.test', 'k'.repeat(32)));
    expect(hash).not.toBe(hashEmail('owner@spice.test', 'other-secret'.repeat(3)));
  });
});

describe("Resend's webhook signature (SA-88)", () => {
  const key = Buffer.from('a test signing key');
  const secret = `whsec_${key.toString('base64')}`;
  const body = '{"type":"email.bounced","data":{"email_id":"e1"}}';
  const now = 1_760_000_000;
  const sign = (id: string, timestamp: number, payload = body) =>
    createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64');

  it('accepts a v1 signature among others', () => {
    const signature = `v1,bm90IGl0 v1,${sign('msg_1', now)}`;
    expect(verifySvix(body, { id: 'msg_1', timestamp: String(now), signature }, secret, now)).toBe(
      true,
    );
  });

  it('refuses a changed body, another id, a stale time and missing headers', () => {
    const signature = `v1,${sign('msg_1', now)}`;
    const headers = { id: 'msg_1', timestamp: String(now), signature };
    expect(verifySvix(`${body} `, headers, secret, now)).toBe(false);
    expect(verifySvix(body, { ...headers, id: 'msg_2' }, secret, now)).toBe(false);
    expect(verifySvix(body, headers, secret, now + 301)).toBe(false);
    expect(verifySvix(body, { ...headers, signature: null }, secret, now)).toBe(false);
    expect(
      verifySvix(body, { ...headers, signature: `v2,${sign('msg_1', now)}` }, secret, now),
    ).toBe(false);
  });
});

describe('Sentry issues (SA-89)', () => {
  const sentry: SentryConfig = {
    token: 'tok',
    org: 'menumesh',
    project: 'web',
    baseUrl: 'https://sentry.test/api/0/',
    environment: 'production',
  };
  const issue = (n: number) => ({
    id: String(n),
    shortId: `WEB-${n}`,
    title: `Error ${n}`,
    culprit: null,
    count: '3',
    lastSeen: '2026-10-16T05:00:00Z',
    permalink: `https://sentry.test/issues/${n}/`,
  });

  it('is off without a token', async () => {
    await expect(sentryIssues(null)).resolves.toEqual({ state: 'off' });
  });

  it("asks for this environment's unresolved issues of the day, most frequent first", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([issue(1), issue(2)])));
    const result = await sentryIssues(sentry, fetchImpl);
    expect(result).toMatchObject({ state: 'ok', count: 2, more: false });
    expect(result.state === 'ok' && result.top[0]!.count).toBe(3);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/sentry\.test\/api\/0\/organizations\/menumesh\/issues\/\?/);
    expect(Object.fromEntries(new URL(url).searchParams)).toMatchObject({
      project: 'web',
      environment: 'production',
      statsPeriod: '24h',
      query: 'is:unresolved',
      sort: 'freq',
    });
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('says 100 or more at a full page, and shows the top 5', async () => {
    const full = Array.from({ length: 100 }, (_, n) => issue(n));
    const result = await sentryIssues(
      sentry,
      vi.fn(async () => new Response(JSON.stringify(full))),
    );
    expect(result).toMatchObject({ state: 'ok', count: 100, more: true });
    expect(result.state === 'ok' && result.top).toHaveLength(5);
  });

  it('tells settings to fix from an outage, with a warning only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refused = vi.fn(async () => new Response('{}', { status: 401 }));
    await expect(sentryIssues(sentry, refused)).resolves.toEqual({ state: 'refused', status: 401 });
    const busy = vi.fn(async () => new Response('{}', { status: 502 }));
    await expect(sentryIssues(sentry, busy)).resolves.toEqual({ state: 'error' });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(sentryIssues(sentry, down)).resolves.toEqual({ state: 'error' });
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe('System page helpers', () => {
  it('formats sizes and times', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(374_525_075)).toBe('357 MB');
    expect(formatMs(450)).toBe('450 ms');
    expect(formatMs(3250)).toBe('3.3 s');
    expect(formatMs(null)).toBe('');
  });

  it('shares a size of its limit only once a limit is entered (SA-90)', () => {
    expect(limitShare(800 * 1024 * 1024, 1000)).toBe(0.8);
    expect(limitShare(800, null)).toBeNull();
  });

  it('reads what platform_system returns', () => {
    const system = parseSystem({
      jobs: [
        {
          job: 'daily',
          last_at: 'x',
          missing: false,
          ms: 3000,
          steps: 3,
          failed: 1,
          missing_steps: 1,
        },
      ],
      steps: [
        {
          job: 'daily',
          step: 'b',
          started_at: 'x',
          ms: 2000,
          ok: false,
          detail: 'boom',
          missing: false,
        },
      ],
      failures: [],
      webhooks: { failed_24h: 1, failed_open: 2 },
      email: { kinds: [], recent: [] },
      sizes: { database_bytes: 1, db_limit_mb: null, storage_limit_mb: 10, buckets: [] },
      menu_imports: {
        since: 'x',
        imports: 1,
        photo: 1,
        csv: 0,
        imported: 1,
        failed: 0,
        discarded: 0,
        open: 0,
        cost_paise: 1500,
        cost_unknown: 0,
      },
    });
    expect(system.jobs[0]!.missing_steps).toBe(1);
  });

  it('reads the new Needs attention groups', () => {
    const attention = parseAttention({
      total: 4,
      inactive_days: 7,
      groups: [
        {
          group: 'cron',
          count: 1,
          items: [
            {
              key: 'cron:digest',
              data: { job: 'digest', step: null, started_at: 'x', detail: null, missing: true },
            },
          ],
        },
        {
          group: 'email',
          count: 1,
          items: [
            {
              key: 'email:reminder',
              data: { kind: 'reminder', failed: 1, bounced: 0, complained: 0, last_at: 'x' },
            },
          ],
        },
        {
          group: 'capacity',
          count: 1,
          items: [
            {
              key: 'capacity:database',
              data: { what: 'database', used_bytes: 900, limit_bytes: 1000 },
            },
          ],
        },
        {
          group: 'menu_imports',
          count: 1,
          items: [
            {
              key: 'menu_imports:i1',
              data: {
                import_id: 'i1',
                restaurant_id: 'r1',
                name: 'Cafe',
                source: 'photo',
                error: null,
                completed_at: 'x',
              },
            },
          ],
        },
      ],
    });
    expect(attention.groups.map((group) => group.group)).toEqual([
      'cron',
      'email',
      'capacity',
      'menu_imports',
    ]);
  });
});
