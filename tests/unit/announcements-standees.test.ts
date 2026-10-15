import { describe, expect, it } from 'vitest';

import {
  announcementPayload,
  announcementSchema,
  announcementStatus,
  audienceLabel,
  bannerText,
  fromIndiaInput,
  toIndiaInput,
  type AnnouncementInput,
} from '@/features/announcements/announcements';
import { announcementEmail } from '@/features/announcements/email';
import {
  nextStep,
  readStandeeFilters,
  standeePayload,
  standeeSchema,
  stepPatch,
  type StandeeInput,
} from '@/features/platform/standees';

// Stop 14c: announcements and standees (docs/DECISIONS.md SA-82+).

describe('banners', () => {
  const banner = { title: 'New menu', body: 'Text', title_hi: 'नया मेन्यू', body_hi: 'पाठ' };

  it('shows a Hindi login the Hindi text when there is one', () => {
    expect(bannerText(banner, 'hi')).toEqual({ title: 'नया मेन्यू', body: 'पाठ', lang: 'hi' });
    expect(bannerText({ ...banner, title_hi: null, body_hi: null }, 'hi')).toEqual({
      title: 'New menu',
      body: 'Text',
      lang: 'en',
    });
    expect(bannerText(banner, 'en').lang).toBe('en');
  });

  it('is live between its start and end, until ended', () => {
    const now = new Date('2026-10-16T10:00:00Z');
    const row = { starts_at: '2026-10-16T09:00:00Z', ends_at: null, ended_at: null };
    expect(announcementStatus(row, now)).toBe('live');
    expect(announcementStatus({ ...row, starts_at: '2026-10-16T11:00:00Z' }, now)).toBe(
      'scheduled',
    );
    expect(announcementStatus({ ...row, ends_at: '2026-10-16T10:00:00Z' }, now)).toBe('ended');
    expect(announcementStatus({ ...row, ended_at: '2026-10-16T09:30:00Z' }, now)).toBe('ended');
  });

  it('names its audience', () => {
    const none = { plan_codes: null, cities: null, restaurants: null };
    expect(audienceLabel(none, {})).toBe('Everyone');
    expect(audienceLabel({ ...none, plan_codes: ['growth', 'pro'] }, { growth: 'Growth' })).toBe(
      'Growth, pro',
    );
    expect(audienceLabel({ ...none, restaurants: [{ id: 'a', name: 'Spice Hub' }] }, {})).toBe(
      '1 restaurant: Spice Hub',
    );
  });
});

describe('India time inputs', () => {
  it('reads and writes India time', () => {
    expect(fromIndiaInput('2026-10-16T21:00')).toBe('2026-10-16T15:30:00.000Z');
    expect(toIndiaInput('2026-10-16T15:30:00.000Z')).toBe('2026-10-16T21:00');
    expect(fromIndiaInput('2026-10-16')).toBeNull();
    expect(fromIndiaInput('2026-13-40T99:00')).toBeNull();
  });
});

describe('the announcement form', () => {
  const form = (patch: Partial<AnnouncementInput> = {}): AnnouncementInput => ({
    title: 'New menu',
    body: 'Text',
    titleHi: '',
    bodyHi: '',
    panels: ['admin'],
    audience: 'everyone',
    planCodes: ['growth'],
    cities: [],
    restaurants: [],
    startsAt: '',
    endsAt: '',
    dismissible: true,
    email: false,
    ...patch,
  });
  const errors = (input: AnnouncementInput) => {
    const parsed = announcementSchema.safeParse(input);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'));
  };

  it('sends only the chosen kind of audience', () => {
    const payload = announcementPayload(announcementSchema.parse(form()));
    expect(payload).toMatchObject({ plan_codes: null, cities: null, restaurant_ids: null });
    expect(payload.starts_at).toBeNull();
    expect(
      announcementPayload(announcementSchema.parse(form({ audience: 'plans' }))).plan_codes,
    ).toEqual(['growth']);
  });

  it('asks for a choice, both Hindi parts and an end after the start', () => {
    expect(errors(form({ audience: 'cities' }))).toEqual(['cities']);
    expect(errors(form({ titleHi: 'नया' }))).toEqual(['bodyHi']);
    expect(errors(form({ panels: [] }))).toEqual(['panels']);
    expect(errors(form({ startsAt: '2026-10-16T21:00', endsAt: '2026-10-16T20:00' }))).toEqual([
      'endsAt',
    ]);
    expect(errors(form({ startsAt: '2026-10-16T21:00', endsAt: '2026-10-17T09:00' }))).toEqual([]);
  });

  it('emails the title and paragraphs, escaped', () => {
    const email = announcementEmail(
      { title: 'Prices <soon>', body: 'One & two\nlines\n\nNext' },
      'https://menumesh.in/',
    );
    expect(email.subject).toBe('MenuMesh: Prices <soon>');
    expect(email.html).toContain('<strong>Prices &lt;soon&gt;</strong>');
    expect(email.html).toContain('<p>One &amp; two<br>lines</p>\n<p>Next</p>');
    expect(email.text).toContain('Admin panel: https://menumesh.in/admin');
  });
});

describe('standees', () => {
  const form = (patch: Partial<StandeeInput> = {}): StandeeInput => ({
    quantity: '4',
    printedOn: '2026-10-10',
    dispatchedOn: '',
    deliveredOn: '',
    installedOn: '',
    vendor: '',
    notes: '',
    cost: '',
    today: '2026-10-16',
    ...patch,
  });
  const errors = (input: StandeeInput) => {
    const parsed = standeeSchema.safeParse(input);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'));
  };

  it('keeps steps in order and not after today', () => {
    expect(errors(form({ deliveredOn: '2026-10-09' }))).toEqual(['deliveredOn']);
    expect(errors(form({ installedOn: '2026-10-17' }))).toEqual(['installedOn']);
    expect(errors(form({ deliveredOn: '2026-10-12' }))).toEqual([]);
    expect(errors(form({ quantity: '0' }))).toEqual(['quantity']);
    expect(errors(form({ cost: 'lots' }))).toEqual(['cost']);
  });

  it('sends the record to managers and the cost to money roles', () => {
    const value = standeeSchema.parse(form({ cost: '1,200.50', vendor: 'PrintCo' }));
    expect(standeePayload(value, { manage: true, record: false })).toEqual({
      quantity: 4,
      printed_on: '2026-10-10',
      dispatched_on: null,
      delivered_on: null,
      installed_on: null,
      vendor: 'PrintCo',
      notes: null,
    });
    expect(standeePayload(value, { manage: false, record: true })).toEqual({
      cost_paise: 120050,
    });
  });

  it('marks the next step', () => {
    expect(nextStep('not_started')).toBe('start');
    expect(nextStep('to_print')).toBe('printed');
    expect(nextStep('delivered')).toBe('installed');
    expect(nextStep('installed')).toBeNull();
    expect(stepPatch('printed', '2026-10-16')).toEqual({
      expected_status: 'printed',
      dispatched_on: '2026-10-16',
    });
    expect(stepPatch('not_started', '2026-10-16')).toEqual({ expected_status: 'not_started' });
  });

  it('reads the tab from the address', () => {
    expect(readStandeeFilters({ status: 'printed', page: '2' })).toEqual({
      status: 'printed',
      page: 2,
    });
    expect(readStandeeFilters({ status: 'open' })).toEqual({ status: undefined, page: 1 });
    expect(readStandeeFilters({ status: 'lost' })).toEqual({ status: undefined, page: 1 });
  });
});
