import { z } from 'zod';

import { formatClockTime } from '@/features/ordering/format';
import { DEFAULT_LOCALE } from '@/lib/config';
import { hasNoHiddenCharacters } from '@/lib/person-name';

/**
 * Support sessions (docs/SUPER_ADMIN_PLAN.md 13c, docs/DECISIONS.md SA-46 to
 * SA-52): the owner allows MenuMesh support in for a few hours, and sees every
 * change made in each session.
 */

export const SUPPORT_HOURS = [1, 4, 24] as const;
export type SupportHours = (typeof SUPPORT_HOURS)[number];

export const supportHoursSchema = z.literal(SUPPORT_HOURS, { error: 'Choose 1, 4 or 24 hours.' });

/** The name the restaurant sees, never the team member's email (SA-50). */
export const staffNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter your name, as the restaurant will see it.')
  .max(40, 'Keep it to 40 characters.')
  .refine(hasNoHiddenCharacters, 'Remove the hidden characters from your name.');

/** The approved consent wording (docs/DECISIONS.md SA-52). */
export const SUPPORT_ACCESS_TEXT =
  "Let the MenuMesh team sign in to your restaurant to set it up or fix something, for example while you're on a call with us. During a session they can change your menu, tables and QR codes, waiters, waiter and kitchen logins, restaurant details, ordering settings and bill layout, and they can see what a manager sees, including orders, bills and reports. They can't create or void bills, record payments, change tax, invoice or UPI payment settings, change your subscription, or change your login or a manager's. Every change they make is listed here, including any login they create or reset, so you can change that password afterwards. You can end access at any time.";

function dayIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
}

/** "3:30 pm today", "3:30 pm tomorrow" or "3:30 pm on 16 Oct", in the restaurant's timezone. */
export function untilText(iso: string, timeZone: string, now = new Date()): string {
  const at = new Date(iso);
  const time = formatClockTime(iso, timeZone);
  const day = dayIn(at, timeZone);
  if (day === dayIn(now, timeZone)) return `${time} today`;
  if (day === dayIn(new Date(now.getTime() + 24 * 3600 * 1000), timeZone)) {
    return `${time} tomorrow`;
  }
  const date = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone,
    day: 'numeric',
    month: 'short',
  }).format(at);
  return `${time} on ${date}`;
}

/** One audit row from a session, as the restaurant reads it. */
export type SupportChange = {
  action: string;
  entity_id: string | null;
  after: Record<string, unknown> | null;
};

const REORDERED: Record<string, string> = {
  categories: 'the categories',
  items: 'the dishes',
  tables: 'the tables',
};

/**
 * What a change was, in a line. Logins are named, so the owner can change the
 * password of any login support created or reset (SA-52); `logins` maps a
 * staff login's id to its username.
 */
export function supportChangeLine(change: SupportChange, logins: Record<string, string>): string {
  const after = change.after ?? {};
  const text = (key: string) => (typeof after[key] === 'string' ? (after[key] as string) : '');
  const quoted = (key: string) => (text(key) ? `“${text(key)}”` : '');
  const username = (change.entity_id && logins[change.entity_id]) || text('username');
  const login = username ? `the login ${username}` : 'a staff login';
  const available = after.is_available === true ? 'available' : 'out of stock';

  switch (change.action) {
    case 'menu_category.created':
      return `Added the category ${quoted('name')}`.trim();
    case 'menu_category.updated':
      return `Changed the category ${quoted('name')}`.trim();
    case 'menu_category.deleted':
      return `Deleted the category ${quoted('name')}`.trim();
    case 'menu_category.added':
      return `Added ${String(after.count ?? 'the')} suggested categories`;
    case 'menu.reordered':
      return `Changed the order of ${REORDERED[text('kind')] ?? 'the menu'}`;
    case 'menu_item.created':
      return `Added the dish ${quoted('name')}`.trim();
    case 'menu_item.updated':
      return `Changed the dish ${quoted('name')}`.trim();
    case 'menu_item.availability':
      return `Marked ${quoted('name') || 'a dish'} ${available}`;
    case 'addon_group.saved':
      return `Saved the add-on group ${quoted('name')}`.trim();
    case 'addon_group.deleted':
      return `Deleted the add-on group ${quoted('name')}`.trim();
    case 'addon.availability':
      return `Marked ${text('name') ? `the add-on ${quoted('name')}` : 'an add-on'} ${available}`;
    case 'menu.imported':
      return 'Imported a menu';
    case 'tables.created': {
      const labels = Array.isArray(after.labels) ? after.labels.join(', ') : '';
      return labels ? `Added tables ${labels}` : 'Added tables';
    }
    case 'table.updated':
      return `Changed the table ${quoted('label')}`.trim();
    case 'table.qr_regenerated':
      return 'Made a new QR code for a table';
    case 'table.qr_downloaded':
      return 'Downloaded a table QR code';
    case 'table.qr_sheet_printed':
      return 'Printed the QR code sheet';
    case 'waiter.created':
      return `Added the waiter ${quoted('full_name')}`.trim();
    case 'waiter.updated':
      return `Changed the waiter ${quoted('full_name')}`.trim();
    case 'waiter.deleted':
      return 'Removed a waiter';
    case 'waiter.on_duty_changed':
      return 'Changed who is on duty';
    case 'staff.created':
      return `Created ${login}`;
    case 'staff.updated':
      return `Changed ${login}`;
    case 'staff.deactivated':
      return `Turned off ${login}`;
    case 'staff.reactivated':
      return `Turned on ${login}`;
    case 'staff.password_reset':
      return `Set a new password for ${login}`;
    case 'settings.updated':
      return 'Changed the restaurant settings';
    case 'settings.logo_replaced':
      return 'Replaced the logo';
    default: {
      const words = change.action.replace(/[._]/g, ' ');
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}
