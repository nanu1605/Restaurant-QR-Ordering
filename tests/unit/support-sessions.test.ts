import { describe, expect, it } from 'vitest';

import {
  staffNameSchema,
  supportChangeLine,
  supportHoursSchema,
  untilText,
} from '@/features/support/support-access';

// Stop 13c: support sessions (docs/DECISIONS.md SA-46 to SA-52).

const TZ = 'Asia/Kolkata';
// 14 Oct 2026, 10:00 am in India.
const NOW = new Date('2026-10-14T04:30:00Z');

describe('support access', () => {
  it('takes 1, 4 or 24 hours only', () => {
    expect(supportHoursSchema.safeParse(4).success).toBe(true);
    expect(supportHoursSchema.safeParse(2).success).toBe(false);
    expect(supportHoursSchema.safeParse('4').success).toBe(false);
  });

  it('needs a short name the restaurant sees', () => {
    expect(staffNameSchema.parse('  Priya ')).toBe('Priya');
    expect(staffNameSchema.safeParse('   ').success).toBe(false);
    expect(staffNameSchema.safeParse('x'.repeat(41)).success).toBe(false);
  });

  it('says when access ends in the restaurant’s time', () => {
    expect(untilText('2026-10-14T10:00:00Z', TZ, NOW)).toBe('3:30 pm today');
    expect(untilText('2026-10-15T04:30:00Z', TZ, NOW)).toBe('10:00 am tomorrow');
    expect(untilText('2026-10-17T04:30:00Z', TZ, NOW)).toBe('10:00 am on 17 Oct');
    // After midnight in India, though still the 14th in UTC.
    expect(untilText('2026-10-14T19:00:00Z', TZ, NOW)).toBe('12:30 am tomorrow');
  });
});

describe('changes made by MenuMesh support', () => {
  const line = (action: string, after: Record<string, unknown> | null = null, id?: string) =>
    supportChangeLine({ action, entity_id: id ?? null, after }, { m1: 'ravi' });

  it('names what changed', () => {
    expect(line('menu_item.created', { name: 'Paneer Tikka' })).toBe(
      'Added the dish “Paneer Tikka”',
    );
    expect(line('menu_item.availability', { name: 'Dal', is_available: false })).toBe(
      'Marked “Dal” out of stock',
    );
    expect(line('addon.availability', { is_available: true })).toBe('Marked an add-on available');
    expect(line('menu.reordered', { kind: 'items', count: 4 })).toBe(
      'Changed the order of the dishes',
    );
    expect(line('tables.created', { labels: ['1', '2'] })).toBe('Added tables 1, 2');
    expect(line('menu_category.added', { count: 5 })).toBe('Added 5 suggested categories');
    expect(line('settings.logo_replaced')).toBe('Replaced the logo');
  });

  it('names every login created or reset, so its password can be changed', () => {
    expect(line('staff.created', { username: 'kitchen1', role: 'kitchen' })).toBe(
      'Created the login kitchen1',
    );
    expect(line('staff.password_reset', null, 'm1')).toBe('Set a new password for the login ravi');
    expect(line('staff.password_reset', null, 'gone')).toBe('Set a new password for a staff login');
  });

  it('reads anything else from its action', () => {
    expect(line('menu_category.updated')).toBe('Changed the category');
    expect(line('something.new_thing')).toBe('Something new thing');
  });
});
