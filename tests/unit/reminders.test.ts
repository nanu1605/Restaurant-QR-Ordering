import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  reminderEmail,
  sendSubscriptionReminders,
  type DueReminder,
} from '@/features/subscriptions/reminders';
import { EmailError, sendEmail, type EmailConfig } from '@/lib/email/resend';
import type { Database } from '@/types/database';

// Reminder emails through Resend (spec §14.6, docs/DECISIONS.md P8-12).

function config(fetchImpl: typeof fetch): EmailConfig {
  return {
    apiKey: 're_test',
    from: 'MenuMesh <billing@menumesh.test>',
    baseUrl: 'https://resend.test/',
    fetchImpl,
  };
}

const reminder = (overrides: Partial<DueReminder> = {}): DueReminder => ({
  restaurant_id: '11111111-1111-4111-8111-111111111111',
  restaurant_name: 'Spice <Route>',
  timezone: 'Asia/Kolkata',
  kind: 'trial_ends_3d',
  due_key: '2026-10-03',
  recipients: ['owner@spice.test'],
  plan_name: 'Growth',
  trial_ends_at: '2026-10-03T16:30:00Z',
  restriction_at: '2026-10-03T22:30:00Z',
  ends_at: '2026-10-03T22:30:00Z',
  ...overrides,
});

describe('sendEmail', () => {
  it('posts the email with the API key and the idempotency key', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'email_1' })));
    const id = await sendEmail(config(fetchImpl), {
      to: ['a@b.test'],
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      idempotencyKey: 'reminder/1',
    });
    expect(id).toBe('email_1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://resend.test/emails');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer re_test',
      'Idempotency-Key': 'reminder/1',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'MenuMesh <billing@menumesh.test>',
      to: ['a@b.test'],
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
    });
  });

  it('turns refusals and network errors into EmailError', async () => {
    const email = { to: ['a@b.test'], subject: 'x', html: 'x', text: 'x', idempotencyKey: 'k' };
    const refused = vi.fn(async () => new Response('{"message":"invalid from"}', { status: 422 }));
    await expect(sendEmail(config(refused), email)).rejects.toThrow(/422/);
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(sendEmail(config(down), email)).rejects.toBeInstanceOf(EmailError);
  });
});

describe('reminderEmail', () => {
  it('names the day in the restaurant time zone and links the subscription page', () => {
    const email = reminderEmail(reminder(), 'https://menumesh.in/');
    expect(email.subject).toBe('Your MenuMesh free trial ends on 3 Oct 2026');
    expect(email.text).toContain('https://menumesh.in/admin/subscription');
    expect(email.html).toContain('Spice &lt;Route&gt;');
    expect(email.html).not.toContain('<Route>');
  });

  it('says when to pay after a failed payment, and that ordering paused', () => {
    expect(reminderEmail(reminder({ kind: 'payment_failed' }), 'https://x.test').text).toContain(
      'Pay by 3 Oct 2026',
    );
    expect(reminderEmail(reminder({ kind: 'access_restricted' }), 'https://x.test').subject).toBe(
      'Ordering is paused at Spice <Route>',
    );
  });

  it('asks to set up autopay again when an offer’s last payment is made', () => {
    const email = reminderEmail(reminder({ kind: 'autopay_ends_7d' }), 'https://x.test');
    expect(email.subject).toBe('Set up MenuMesh autopay again for Spice <Route>');
    expect(email.text).toContain('the paid period ends on 3 Oct 2026');
    expect(email.text).toContain('Set up autopay for Growth again');
  });
});

describe('sendSubscriptionReminders', () => {
  function admin(due: DueReminder[], logError: unknown = null) {
    const rpc = vi.fn(async (name: string) =>
      name === 'subscription_reminders_due'
        ? { data: due, error: null }
        : { data: true, error: logError },
    );
    return { client: { rpc } as unknown as SupabaseClient<Database>, rpc };
  }

  it('logs each reminder only after Resend took it, and carries on after a failure', async () => {
    const { client, rpc } = admin([
      reminder(),
      reminder({ restaurant_id: '22222222-2222-4222-8222-222222222222' }),
    ]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"message":"rate limited"}', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'email_2' })));
    const result = await sendSubscriptionReminders(client, config(fetchImpl), 'https://x.test', {
      pauseMs: 0,
    });
    expect(result).toEqual({ sent: 1, failed: 1 });
    const logged = rpc.mock.calls.filter(([name]) => name === 'subscription_reminder_sent');
    expect(logged).toEqual([
      [
        'subscription_reminder_sent',
        {
          p_restaurant_id: '22222222-2222-4222-8222-222222222222',
          p_kind: 'trial_ends_3d',
          p_due_key: '2026-10-03',
        },
      ],
    ]);
    const [, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(
      'reminder/22222222-2222-4222-8222-222222222222/trial_ends_3d/2026-10-03',
    );
  });

  it('counts a reminder that was sent but not logged as failed', async () => {
    const { client } = admin([reminder()], { message: 'db down' });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'email_1' })));
    const result = await sendSubscriptionReminders(client, config(fetchImpl), 'https://x.test', {
      pauseMs: 0,
    });
    expect(result).toEqual({ sent: 0, failed: 1 });
  });
});
