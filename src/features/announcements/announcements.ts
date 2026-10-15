import { z } from 'zod';

import type { Lang } from '@/features/ordering/strings';

/**
 * Announcements (docs/SUPER_ADMIN_PLAN.md 14c, docs/DECISIONS.md SA-82+): a
 * banner in the chosen panels of the restaurants in its audience, between its
 * start and end, optionally emailed to their owners when it starts. Times
 * are India's.
 */

export const PANELS = ['admin', 'worker'] as const;
export type Panel = (typeof PANELS)[number];
export const PANEL_LABELS: Record<Panel, string> = {
  admin: 'Admin panel',
  worker: 'Worker panel',
};

export const AUDIENCES = ['everyone', 'plans', 'cities', 'restaurants'] as const;
export type Audience = (typeof AUDIENCES)[number];
export const AUDIENCE_LABELS: Record<Audience, string> = {
  everyone: 'Everyone',
  plans: 'Plans',
  cities: 'Cities',
  restaurants: 'Chosen restaurants',
};

// ─── A banner, as a login sees it ────────────────────────────────────────────
const bannerSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  title_hi: z.string().nullable(),
  body_hi: z.string().nullable(),
  dismissible: z.boolean(),
});
export type Banner = z.infer<typeof bannerSchema>;
export const parseBanners = (json: unknown) => z.array(bannerSchema).parse(json);

/** The Hindi text for a Hindi login when there is one (P11-15: the worker panel only). */
export function bannerText(
  banner: Pick<Banner, 'title' | 'body' | 'title_hi' | 'body_hi'>,
  lang: Lang,
): { title: string; body: string; lang: Lang } {
  return lang === 'hi' && banner.title_hi && banner.body_hi
    ? { title: banner.title_hi, body: banner.body_hi, lang: 'hi' }
    : { title: banner.title, body: banner.body, lang: 'en' };
}

// ─── The team's list ─────────────────────────────────────────────────────────
const isoOrNull = z.string().nullable();
const announcementRowSchema = bannerSchema.extend({
  panels: z.array(z.enum(PANELS)),
  plan_codes: z.array(z.string()).nullable(),
  cities: z.array(z.string()).nullable(),
  restaurants: z.array(z.object({ id: z.string(), name: z.string() })).nullable(),
  starts_at: z.string(),
  ends_at: isoOrNull,
  ended_at: isoOrNull,
  email: z.boolean(),
  // Counted while it runs.
  audience: z.number().nullable(),
  dismissed: z.number(),
  emailed: z.number(),
  created_by: z.string().nullable(),
  created_at: z.string(),
});
export type AnnouncementRow = z.infer<typeof announcementRowSchema>;
export const parseAnnouncements = (json: unknown) =>
  z
    .object({ announcements: z.array(announcementRowSchema), cities: z.array(z.string()) })
    .parse(json);

export function announcementStatus(
  row: Pick<AnnouncementRow, 'starts_at' | 'ends_at' | 'ended_at'>,
  now = new Date(),
): 'live' | 'scheduled' | 'ended' {
  if (row.ended_at || (row.ends_at && Date.parse(row.ends_at) <= now.getTime())) return 'ended';
  return Date.parse(row.starts_at) > now.getTime() ? 'scheduled' : 'live';
}

export function audienceOf(row: Pick<AnnouncementRow, 'plan_codes' | 'cities' | 'restaurants'>) {
  if (row.plan_codes) return 'plans';
  if (row.cities) return 'cities';
  if (row.restaurants) return 'restaurants';
  return 'everyone';
}

/** "Everyone", "Growth, Pro", "Jaipur", "2 restaurants: Spice Hub, Tandoor". */
export function audienceLabel(
  row: Pick<AnnouncementRow, 'plan_codes' | 'cities' | 'restaurants'>,
  planNames: Record<string, string>,
) {
  if (row.plan_codes) return row.plan_codes.map((code) => planNames[code] ?? code).join(', ');
  if (row.cities) return row.cities.join(', ');
  if (row.restaurants) {
    const names = row.restaurants.map((restaurant) => restaurant.name).join(', ');
    return `${row.restaurants.length} ${row.restaurants.length === 1 ? 'restaurant' : 'restaurants'}: ${names}`;
  }
  return 'Everyone';
}

// ─── India time for datetime-local inputs ────────────────────────────────────
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** '2026-10-16T21:00' (India) as an instant, or null when it isn't one. */
export function fromIndiaInput(value: string): string | null {
  if (!LOCAL.test(value)) return null;
  const date = new Date(`${value}:00+05:30`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** An instant as India's '2026-10-16T21:00', for a datetime-local input. */
export function toIndiaInput(iso: string): string {
  return new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 16);
}

// ─── The form ────────────────────────────────────────────────────────────────
export const announcementSchema = z
  .object({
    title: z.string().trim().min(1, 'Enter a title.').max(120, 'Use 120 characters or fewer.'),
    body: z.string().trim().min(1, 'Enter the text.').max(500, 'Use 500 characters or fewer.'),
    titleHi: z.string().trim().max(120, 'Use 120 characters or fewer.'),
    bodyHi: z.string().trim().max(500, 'Use 500 characters or fewer.'),
    panels: z.array(z.enum(PANELS)).min(1, 'Choose at least one panel.'),
    audience: z.enum(AUDIENCES),
    planCodes: z.array(z.string()),
    cities: z.array(z.string()),
    restaurants: z.array(z.object({ id: z.uuid(), name: z.string() })),
    // Empty: from now; no end.
    startsAt: z.string(),
    endsAt: z.string(),
    dismissible: z.boolean(),
    email: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.titleHi) !== Boolean(value.bodyHi)) {
      ctx.addIssue({
        code: 'custom',
        path: [value.titleHi ? 'bodyHi' : 'titleHi'],
        message: 'Give both the Hindi title and text, or neither.',
      });
    }
    const picked = { plans: value.planCodes, cities: value.cities, restaurants: value.restaurants };
    if (value.audience !== 'everyone' && picked[value.audience].length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: [value.audience === 'plans' ? 'planCodes' : value.audience],
        message: `Choose at least one ${value.audience === 'plans' ? 'plan' : value.audience === 'cities' ? 'city' : 'restaurant'}.`,
      });
    }
    const starts = value.startsAt ? fromIndiaInput(value.startsAt) : new Date().toISOString();
    if (!starts) {
      ctx.addIssue({ code: 'custom', path: ['startsAt'], message: 'Choose a date and time.' });
    }
    if (value.endsAt) {
      const ends = fromIndiaInput(value.endsAt);
      if (!ends) {
        ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Choose a date and time.' });
      } else if (starts && ends <= starts) {
        ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'After it starts.' });
      }
    }
  });
export type AnnouncementInput = z.input<typeof announcementSchema>;

/** The form as platform_save_announcement takes it. */
export function announcementPayload(value: z.output<typeof announcementSchema>) {
  return {
    title: value.title,
    body: value.body,
    title_hi: value.titleHi || null,
    body_hi: value.bodyHi || null,
    panels: value.panels,
    plan_codes: value.audience === 'plans' ? value.planCodes : null,
    cities: value.audience === 'cities' ? value.cities : null,
    restaurant_ids:
      value.audience === 'restaurants'
        ? value.restaurants.map((restaurant) => restaurant.id)
        : null,
    starts_at: value.startsAt ? fromIndiaInput(value.startsAt) : null,
    ends_at: value.endsAt ? fromIndiaInput(value.endsAt) : null,
    dismissible: value.dismissible,
    email: value.email,
  };
}

/** An announcement as the form shows it. */
export function announcementForm(row: AnnouncementRow): AnnouncementInput {
  return {
    title: row.title,
    body: row.body,
    titleHi: row.title_hi ?? '',
    bodyHi: row.body_hi ?? '',
    panels: row.panels,
    audience: audienceOf(row),
    planCodes: row.plan_codes ?? [],
    cities: row.cities ?? [],
    restaurants: row.restaurants ?? [],
    startsAt: toIndiaInput(row.starts_at),
    endsAt: row.ends_at ? toIndiaInput(row.ends_at) : '',
    dismissible: row.dismissible,
    email: row.email,
  };
}
