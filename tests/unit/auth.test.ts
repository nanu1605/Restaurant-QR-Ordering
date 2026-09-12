import { describe, expect, it } from 'vitest';

import { allowedPanelsFor, homePathFor, safeNextPath } from '@/lib/auth/redirects';
import { emailLoginSchema, staffLoginSchema } from '@/lib/auth/schemas';
import { staffEmail } from '@/lib/auth/staff-email';

describe('staffEmail', () => {
  it('builds <username>@<slug>.staff.<domain>', () => {
    expect(staffEmail('waiter1', 'demo', 'tableorder.test')).toBe(
      'waiter1@demo.staff.tableorder.test',
    );
  });

  it('normalises case and whitespace', () => {
    expect(staffEmail(' Waiter1 ', ' Demo ', 'App.Example.com')).toBe(
      'waiter1@demo.staff.app.example.com',
    );
  });

  it('rejects invalid usernames and restaurant codes', () => {
    expect(() => staffEmail('ab', 'demo', 'x.test')).toThrow(/username/);
    expect(() => staffEmail('ravi.k', 'demo', 'x.test')).toThrow(/username/);
    expect(() => staffEmail('ravi', '-demo', 'x.test')).toThrow(/restaurant code/);
  });
});

describe('homePathFor', () => {
  it('sends each role to its panel (spec §9.5)', () => {
    expect(homePathFor({ isPlatformAdmin: true, role: null })).toBe('/super');
    expect(homePathFor({ isPlatformAdmin: true, role: 'owner' })).toBe('/super');
    expect(homePathFor({ isPlatformAdmin: false, role: 'owner' })).toBe('/admin');
    expect(homePathFor({ isPlatformAdmin: false, role: 'manager' })).toBe('/admin');
    expect(homePathFor({ isPlatformAdmin: false, role: 'waiter' })).toBe('/staff');
    expect(homePathFor({ isPlatformAdmin: false, role: 'kitchen' })).toBe('/staff');
    expect(homePathFor({ isPlatformAdmin: false, role: null })).toBeNull();
  });
});

describe('allowedPanelsFor', () => {
  it('lets managers use the worker panel too', () => {
    expect(allowedPanelsFor({ isPlatformAdmin: false, role: 'manager' })).toEqual([
      '/admin',
      '/staff',
    ]);
    expect(allowedPanelsFor({ isPlatformAdmin: false, role: 'waiter' })).toEqual(['/staff']);
    expect(allowedPanelsFor({ isPlatformAdmin: true, role: null })).toEqual(['/super']);
  });
});

describe('safeNextPath', () => {
  it('keeps same-origin panel paths with their query', () => {
    expect(safeNextPath('/admin')).toBe('/admin');
    expect(safeNextPath('/admin/menu?tab=items')).toBe('/admin/menu?tab=items');
    expect(safeNextPath('/staff/kitchen')).toBe('/staff/kitchen');
  });

  it('rejects anything that could leave the app or the panels', () => {
    for (const bad of [
      'https://evil.example/admin',
      '//evil.example/admin',
      '/\\evil.example',
      '\\\\evil.example',
      'javascript:alert(1)',
      'admin',
      '/',
      '/login',
      '/adminx',
      '/t/DEMO0000TABLE001',
      '',
      null,
      undefined,
      42,
    ]) {
      expect(safeNextPath(bad), String(bad)).toBeNull();
    }
  });

  it('normalises dot segments before checking the panel', () => {
    expect(safeNextPath('/admin/../login')).toBeNull();
    expect(safeNextPath('/staff/./kitchen')).toBe('/staff/kitchen');
  });

  it('only allows panels the user may open', () => {
    expect(safeNextPath('/admin', ['/staff'])).toBeNull();
    expect(safeNextPath('/staff', ['/admin', '/staff'])).toBe('/staff');
  });
});

describe('login schemas', () => {
  it('normalises restaurant code and username', () => {
    const parsed = staffLoginSchema.parse({
      restaurantCode: ' Demo ',
      username: 'Waiter1',
      password: 'Password123!',
    });
    expect(parsed).toMatchObject({ restaurantCode: 'demo', username: 'waiter1' });
  });

  it('explains what is missing', () => {
    const result = staffLoginSchema.safeParse({ restaurantCode: '', username: 'x', password: '' });
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'Enter your restaurant code.',
        'Enter your username.',
        'Enter your password.',
      ]),
    );
  });

  it('validates and lowercases email', () => {
    expect(emailLoginSchema.parse({ email: ' Owner@Local.Test ', password: 'x' }).email).toBe(
      'owner@local.test',
    );
    expect(emailLoginSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false);
  });
});
