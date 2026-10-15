import { describe, expect, it } from 'vitest';

import { formatShare, sourceLabel } from '@/features/growth/funnel';
import {
  followUpOverdue,
  fromIndiaInput,
  leadEventLine,
  newLeadSchema,
  readLeadFilters,
  toIndiaInput,
  type LeadEvent,
} from '@/features/growth/leads';

describe('the funnel', () => {
  it('shows a share with its fraction, and only the fraction below 5', () => {
    expect(formatShare(2, 3)).toBe('2 of 3');
    expect(formatShare(430, 612)).toBe('430 of 612, 70%');
    expect(formatShare(0, 5)).toBe('0 of 5, 0%');
    expect(formatShare(0, 0)).toBe('—');
  });

  it('names a website source by its utm source, else the site that linked', () => {
    expect(sourceLabel({ utm_source: 'google', referrer: null })).toBe('google');
    expect(sourceLabel({ utm_source: null, referrer: 'news.example' })).toBe('From news.example');
    expect(sourceLabel({ utm_source: null, referrer: null })).toBe('Direct or not known');
  });
});

describe('leads', () => {
  it('reads a time into a datetime-local field in India time, and back with its offset', () => {
    expect(toIndiaInput('2026-10-16T10:00:00Z')).toBe('2026-10-16T15:30');
    expect(toIndiaInput('2026-10-16T19:00:00Z')).toBe('2026-10-17T00:30');
    expect(toIndiaInput(null)).toBe('');
    expect(fromIndiaInput('2026-10-16T15:30')).toBe('2026-10-16T15:30:00+05:30');
    expect(fromIndiaInput('2026-10-16')).toBeNull();
    expect(fromIndiaInput('')).toBeNull();
  });

  it('flags a follow-up that has passed, only while the lead is in play', () => {
    const now = new Date('2026-10-16T10:00:00Z');
    const past = '2026-10-16T09:59:00Z';
    expect(followUpOverdue({ follow_up_at: past, stage: 'contacted' }, now)).toBe(true);
    expect(followUpOverdue({ follow_up_at: '2026-10-16T10:01:00Z', stage: 'new' }, now)).toBe(
      false,
    );
    expect(followUpOverdue({ follow_up_at: past, stage: 'won' }, now)).toBe(false);
    expect(followUpOverdue({ follow_up_at: null, stage: 'new' }, now)).toBe(false);
  });

  it('keeps known filters from the URL and drops the rest', () => {
    expect(
      readLeadFilters({
        stage: 'demo_done',
        assignee: 'me',
        channel: 'field_visit',
        due: 'overdue',
        q: ' Asha ',
        page: '2',
        view: 'board',
      }),
    ).toEqual({
      stage: 'demo_done',
      assignee: 'me',
      channel: 'field_visit',
      due: 'overdue',
      q: 'Asha',
      page: 2,
      view: 'board',
    });
    expect(
      readLeadFilters({ stage: 'maybe', assignee: 'bob', channel: 'tv', due: 'soon', page: '0' }),
    ).toEqual({ page: 1 });
  });

  it('says what changed in its history, and who did it', () => {
    const event = (patch: Partial<LeadEvent>): LeadEvent => ({
      id: 'e',
      kind: 'stage',
      actor: 'asha@menumesh.test',
      automatic: false,
      from: null,
      to: null,
      from_label: null,
      to_label: null,
      body: null,
      at: '2026-10-16T10:00:00Z',
      ...patch,
    });
    expect(leadEventLine(event({ from: 'lost:price', to: 'lost:no_response' }))).toBe(
      'Lost (price) to Lost (no response), by asha@menumesh.test',
    );
    expect(leadEventLine(event({ from: 'new', to: 'contacted' }))).toBe(
      'New to Contacted, by asha@menumesh.test',
    );
    expect(
      leadEventLine(event({ from: 'contacted', to: 'trial', automatic: true, actor: null })),
    ).toBe('Contacted to Trial, automatically');
    expect(
      leadEventLine(
        event({
          kind: 'restaurant',
          to: 'r1',
          to_label: 'Asha Cafe',
          automatic: true,
          actor: null,
        }),
      ),
    ).toBe('Linked to Asha Cafe, automatically (same mobile)');
    expect(leadEventLine(event({ kind: 'restaurant', from: 'r1', from_label: 'Asha Cafe' }))).toBe(
      'Unlinked from Asha Cafe, by asha@menumesh.test',
    );
    expect(
      leadEventLine(event({ kind: 'assignee', to: 'u1', to_label: 'ravi@menumesh.test' })),
    ).toBe('Assigned to ravi@menumesh.test, by asha@menumesh.test');
    expect(leadEventLine(event({ kind: 'follow_up', actor: null }))).toBe(
      'Follow-up cleared, by a former team member',
    );
  });

  it('takes a lead added by hand with a mobile written any way', () => {
    const lead = newLeadSchema.parse({
      name: ' Ravi ',
      restaurantName: 'Ravi Dhaba',
      city: 'Bhopal',
      phone: '+91 98765 43210',
      email: ' Ravi@Example.TEST ',
      channel: 'field_visit',
      stage: 'contacted',
      message: '',
      assignee: '',
    });
    expect(lead).toMatchObject({ name: 'Ravi', phone: '9876543210', email: 'ravi@example.test' });
    expect(
      newLeadSchema
        .safeParse({ ...lead, phone: '98765', channel: 'website_lead' })
        .error?.issues.map((issue) => issue.path[0]),
    ).toEqual(['phone', 'channel']);
  });
});
