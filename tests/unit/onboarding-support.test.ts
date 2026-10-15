import { describe, expect, it } from 'vitest';

import { onboardingLabel, parseOnboarding } from '@/features/onboarding/onboarding';
import { activityKindsFor, activityLine, type ActivityItem } from '@/features/platform/home';
import { readRestaurantFilters } from '@/features/platform/params';
import { supportRequestEmail } from '@/features/support/notify';
import {
  eventLine,
  phoneDigits,
  readInboxFilters,
  requestAge,
  supportRequestSchema,
} from '@/features/support/support';

// Stop 13b: the onboarding checklist, Get help and the support inbox
// (docs/DECISIONS.md SA-41 to SA-45).

const UUID = '0b8e3f0e-6a4c-4b7d-9a51-5f2a8c1d2e3f';

describe('onboarding', () => {
  it('names the next step with how many are done', () => {
    expect(
      onboardingLabel({ done: 2, next: 'qr', since: '2026-10-10T05:00:00Z', stuck: true }),
    ).toBe('2 of 7: QR codes downloaded, printed or delivered');
    expect(
      onboardingLabel({ done: 7, next: null, since: '2026-10-10T05:00:00Z', stuck: false }),
    ).toBe('Done');
  });

  it('reads the steps as the database gives them', () => {
    const steps = parseOnboarding({
      steps: [{ key: 'menu', done_at: '2026-10-10T05:00:00Z' }],
      done: 1,
      next: 'tables',
      since: '2026-10-10T05:00:00Z',
      stuck: false,
    });
    expect(steps.next).toBe('tables');
    expect(() => parseOnboarding({ ...steps, next: 'standee' })).toThrow();
  });

  it('filters the list by where onboarding stands', () => {
    expect(readRestaurantFilters({ onboarding: 'stuck' }).onboarding).toBe('stuck');
    expect(readRestaurantFilters({ onboarding: 'late' }).onboarding).toBeUndefined();
  });
});

describe('Get help', () => {
  const request = {
    topic: 'printing',
    message: '  The printer prints blank.  ',
    contact_method: 'call',
    contact: '+91 98765 43210',
  };

  it('takes a 10-digit mobile however it is typed', () => {
    expect(phoneDigits('+91 98765 43210')).toBe('9876543210');
    expect(phoneDigits('098765-43210')).toBe('9876543210');
    expect(supportRequestSchema.parse(request)).toEqual({
      ...request,
      message: 'The printer prints blank.',
    });
  });

  it('asks for what is missing', () => {
    const result = supportRequestSchema.safeParse({
      topic: '',
      message: ' ',
      contact_method: 'email',
      contact: '9876543210',
    });
    expect(result.success).toBe(false);
    // Every mistake at once, the contact's too while no topic is chosen.
    expect(result.error?.issues.map((issue) => [issue.path[0], issue.message])).toEqual([
      ['topic', 'Choose what it is about.'],
      ['message', 'Say what you need help with.'],
      ['contact', 'Enter an email address.'],
    ]);
    expect(
      supportRequestSchema.safeParse({
        ...request,
        contact_method: 'email',
        contact: 'me@x.co?bcc=a%40b.co',
      }).success,
    ).toBe(false);
    expect(
      supportRequestSchema.safeParse({ ...request, contact_method: 'email' }).error?.issues[0]
        ?.message,
    ).toBe('Enter an email address.');
    expect(
      supportRequestSchema.safeParse({ ...request, contact: '12345' }).error?.issues[0]?.message,
    ).toBe('Enter a 10-digit mobile number.');
  });

  it('emails the team what was asked, and a link to it', () => {
    const email = supportRequestEmail(
      {
        id: 'q1',
        restaurantName: 'Sharma <Dhaba>',
        slug: 'sharma-dhaba',
        name: 'Ravi',
        topic: 'printing',
        message: 'Blank bills',
        contactMethod: 'whatsapp',
        contact: '9876543210',
        screenshot: true,
      },
      'https://menumesh.in/',
    );
    expect(email.subject).toBe('Support request: Sharma <Dhaba>, Printing');
    expect(email.text).toContain('Reach them: WhatsApp: +91 9876543210');
    expect(email.text).toContain('Open it: https://menumesh.in/super/support/q1');
    expect(email.html).toContain('Sharma &lt;Dhaba&gt;');
  });
});

describe('the inbox', () => {
  it('reads its filters from the URL', () => {
    expect(
      readInboxFilters({ status: 'waiting', assignee: 'me', priority: 'high', topic: 'menu' }),
    ).toEqual({ status: 'waiting', assignee: 'me', priority: 'high', topic: 'menu', page: 1 });
    expect(readInboxFilters({ assignee: UUID, restaurant: UUID, page: '3' })).toMatchObject({
      assignee: UUID,
      restaurant: UUID,
      page: 3,
    });
    expect(
      readInboxFilters({ status: 'closed', assignee: 'someone', priority: 'urgent', page: '0' }),
    ).toEqual({
      status: undefined,
      restaurant: undefined,
      assignee: undefined,
      priority: undefined,
      topic: undefined,
      page: 1,
    });
  });

  it('says what changed', () => {
    const event = {
      id: 'e1',
      at: '2026-10-14T05:00:00Z',
      actor: 'team@menumesh.in',
      from: 'open',
      to: 'waiting',
      body: null,
    };
    expect(eventLine({ ...event, kind: 'status' })).toBe('Status: Open to Waiting on restaurant');
    expect(eventLine({ ...event, kind: 'priority', from: 'normal', to: 'high' })).toBe(
      'Priority: Normal to High',
    );
    expect(eventLine({ ...event, kind: 'assignee', from: null, to: 'team@menumesh.in' })).toBe(
      'Assigned to team@menumesh.in',
    );
    expect(eventLine({ ...event, kind: 'assignee', to: null })).toBe('Unassigned');
  });

  it('gives the age in hours, then days', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(requestAge('2026-10-14T09:30:00Z', now)).toBe('2 h');
    expect(requestAge('2026-10-11T12:00:00Z', now)).toBe('3 d');
  });

  it('is in the activity stream for whoever works it', () => {
    const item: ActivityItem = {
      key: 'support:q1',
      kind: 'support',
      at: '2026-10-14T05:12:00Z',
      restaurant_id: 'r1',
      restaurant_name: 'Sharma Dhaba',
      actor: null,
      data: { request_id: 'q1', topic: 'billing', message: 'Where is my invoice', more: true },
    };
    expect(activityLine(item)).toEqual({
      title: 'Support request',
      detail: 'Billing: Where is my invoice…',
      href: '/super/support/q1',
      amount: null,
    });
    expect(
      activityKindsFor({ money: false, growth: false, support: true, audit: false }),
    ).toContain('support');
    expect(
      activityKindsFor({ money: true, growth: true, support: false, audit: true }),
    ).not.toContain('support');
  });
});
