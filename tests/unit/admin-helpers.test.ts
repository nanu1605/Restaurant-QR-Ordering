import { describe, expect, it } from 'vitest';

import {
  hasFeature,
  NO_PLAN,
  parsePlanFeatures,
  remainingUnder,
  upgradeHint,
  usageLabel,
} from '@/features/plans/plan-features';
import { accessBanner } from '@/features/subscriptions/access-banner';
import { assignableRoles, canManageRole } from '@/lib/auth/roles';
import { dbErrorCode, dbErrorMessage } from '@/lib/db-errors';

describe('plan features (spec §14.2)', () => {
  const starter = parsePlanFeatures({
    plan_code: 'starter',
    plan_name: 'Starter',
    max_tables: 8,
    max_staff: 3,
    features: { kds: false, upi_qr_on_bill: false, discounts: 'yes' },
  });

  it('reads flags strictly (only true counts)', () => {
    expect(starter.maxTables).toBe(8);
    expect(hasFeature(starter, 'upi_qr_on_bill')).toBe(false);
    expect(hasFeature(starter, 'discounts')).toBe(false);
    expect(hasFeature(starter, 'csv_export')).toBe(false);
    expect(
      hasFeature(
        parsePlanFeatures({
          plan_code: 'growth',
          plan_name: 'Growth',
          max_tables: null,
          max_staff: 15,
          features: { kds: true },
        }),
        'kds',
      ),
    ).toBe(true);
  });

  it('treats a missing subscription as no plan', () => {
    expect(parsePlanFeatures(null)).toBe(NO_PLAN);
    expect(NO_PLAN.maxTables).toBe(0);
  });

  it('describes limits and upgrades', () => {
    expect(upgradeHint('upi_qr_on_bill')).toBe('Available on Growth');
    expect(upgradeHint('remove_branding')).toBe('Available on Pro');
    expect(usageLabel(8, 8, 'table')).toBe('8 of 8 tables');
    expect(usageLabel(1, null, 'table')).toBe('1 table');
    expect(remainingUnder(8, 5)).toBe(3);
    expect(remainingUnder(8, 9)).toBe(0);
    expect(remainingUnder(null, 500)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('role hierarchy (spec §3, §13.3)', () => {
  it('lets owners manage everyone but owners, and managers manage waiters and kitchen', () => {
    expect(canManageRole('owner', 'manager')).toBe(true);
    expect(canManageRole('owner', 'owner')).toBe(false);
    expect(canManageRole('manager', 'waiter')).toBe(true);
    expect(canManageRole('manager', 'manager')).toBe(false);
    expect(canManageRole('waiter', 'kitchen')).toBe(false);
    expect(assignableRoles('owner')).toEqual(['manager', 'waiter', 'kitchen']);
    expect(assignableRoles('manager')).toEqual(['waiter', 'kitchen']);
    expect(assignableRoles('kitchen')).toEqual([]);
  });
});

describe('database error messages', () => {
  it('map business codes, using the detail when it helps', () => {
    expect(dbErrorMessage({ code: 'P0001', message: 'TABLE_LABEL_TAKEN', details: '5' })).toBe(
      'There is already a table called “5”.',
    );
    expect(dbErrorMessage({ code: 'P0001', message: 'WAITER_HAS_OPEN_TABLES', details: '3' })).toBe(
      'Reassign Table 3 first.',
    );
    expect(
      dbErrorMessage({ code: 'P0001', message: 'WAITER_HAS_OPEN_TABLES', details: '3, Terrace 1' }),
    ).toBe('Reassign Tables 3, Terrace 1 first.');
    expect(dbErrorMessage({ code: 'P0001', message: 'PLAN_LIMIT_TABLES', details: '8' })).toMatch(
      /up to 8 tables\. Upgrade to Growth/,
    );
  });

  it('treat permission errors as FORBIDDEN and leave the rest unmapped', () => {
    expect(dbErrorCode({ code: '42501', message: 'permission denied for table menu_items' })).toBe(
      'FORBIDDEN',
    );
    expect(dbErrorMessage({ code: 'P0001', message: 'SOMETHING_NEW' })).toBeNull();
    expect(dbErrorMessage({ code: '23505', message: 'duplicate key' })).toBeNull();
  });
});

describe('access banner (spec §10.6, §14.6)', () => {
  const now = new Date('2026-09-12T06:00:00Z');

  it('explains a lapsed subscription, with a plan link only for the owner', () => {
    const access = {
      state: 'read_only',
      reason: 'trial_ended',
      restrictionAt: null,
      warning: null,
    } as const;
    const owner = accessBanner({ access, role: 'owner', timezone: 'Asia/Kolkata', now });
    expect(owner).toMatchObject({ tone: 'blocked', action: { href: '/admin/subscription' } });
    expect(owner?.text).toContain('Setup changes are paused too.');

    const manager = accessBanner({ access, role: 'manager', timezone: 'Asia/Kolkata', now });
    expect(manager?.action).toBeUndefined();
    expect(manager?.text).toContain('Contact the owner.');
  });

  it('says a suspended restaurant should contact support', () => {
    const banner = accessBanner({
      access: { state: 'read_only', reason: 'suspended', restrictionAt: null, warning: null },
      role: 'owner',
      timezone: 'Asia/Kolkata',
      now,
    });
    expect(banner?.text).toContain('suspended');
    expect(banner?.action).toBeUndefined();
  });

  it('warns about a trial ending soon and a failed payment', () => {
    const trial = accessBanner({
      access: {
        state: 'full',
        reason: null,
        restrictionAt: '2026-09-14T22:30:00Z',
        warning: 'trial_ends_soon',
      },
      role: 'owner',
      timezone: 'Asia/Kolkata',
      now,
    });
    expect(trial).toMatchObject({ tone: 'warning', text: 'Your trial ends in 3 days.' });

    const payment = accessBanner({
      access: {
        state: 'full',
        reason: null,
        restrictionAt: '2026-09-17T22:30:00Z',
        warning: 'payment_failed',
      },
      role: 'manager',
      timezone: 'Asia/Kolkata',
      now,
    });
    expect(payment?.text).toMatch(
      /^Payment failed\. Update payment by 17 Sept? to keep ordering active\. Ask the owner to renew\.$/,
    );
  });

  it('shows nothing when all is well', () => {
    expect(
      accessBanner({
        access: { state: 'full', reason: null, restrictionAt: null, warning: null },
        role: 'owner',
        timezone: 'Asia/Kolkata',
        now,
      }),
    ).toBeNull();
  });
});
