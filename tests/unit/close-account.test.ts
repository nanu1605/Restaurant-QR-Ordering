import { describe, expect, it } from 'vitest';

import { closeAccountSchema, parseClosure, parseExportRow } from '@/features/closure/closure';
import { closureEmail } from '@/features/closure/email';
import { COLUMNS, exportFiles, type ExportData } from '@/features/closure/export-files';
import { mandateCanCharge } from '@/features/subscriptions/autopay';
import { zipArchive, zipEntry } from '@/lib/zip';

import { readZip } from '../read-zip';

// Closing an account (docs/SUPER_ADMIN_PLAN.md 14e, docs/DECISIONS.md SA-93+).

describe('the ZIP writer', () => {
  it('writes files any reader can open, whatever their language', async () => {
    const files = { 'a.txt': 'hello ₹500', 'b/c.csv': 'नमस्ते,'.repeat(5000), 'empty.txt': '' };
    const entries = await Promise.all(
      Object.entries(files).map(([name, text]) => zipEntry(name, text)),
    );
    const zip = zipArchive(entries, new Date('2026-11-01T10:20:30Z'));
    expect(readZip(zip)).toEqual(files);
    // Compressed, and the first file's header holds the time it was given.
    expect(zip.length).toBeLessThan(files['b/c.csv'].length);
    expect(zip.readUInt16LE(10)).toBe((10 << 11) | (20 << 5) | 15);
    expect(zip.readUInt16LE(12)).toBe((46 << 9) | (11 << 5) | 1);
  });
});

const row = (overrides: object) => overrides as never;

const data: ExportData = {
  restaurant: row({ name: 'Spice Cafe', slug: 'spice', timezone: 'Asia/Kolkata', phone: '98765' }),
  subscription: null,
  categories: [row({ id: 'c1', name: 'Starters' })],
  items: [row({ id: 'i1', name: 'Paneer Tikka', price_paise: 28000 })],
  variants: [],
  addonGroups: [
    row({ id: 'g1', name: 'Extras', menu_item_addon_groups: [{ menu_item_id: 'i1' }] }),
  ],
  addons: [],
  // More than the columns ask for, as a guard on what each file picks.
  tables: [
    row({ id: 't1', label: 'T1', sort_order: 1, is_active: true, qr_token: 'SECRETQRTOKEN' }),
  ],
  staff: [
    row({
      id: 'm1',
      display_name: 'Ravi',
      username: 'ravi',
      role: 'waiter',
      is_active: true,
      user_id: 'SECRETUSERID',
    }),
  ],
  waiters: [row({ id: 'w1', full_name: 'Ravi', notes: '=HYPERLINK("x")', on_duty: true })],
  sessions: [row({ id: 's1', table_label_snapshot: 'T1' })],
  orders: [
    row({
      id: 'o1',
      session_id: 's1',
      round_number: 2,
      created_at: '2026-10-31T18:30:00Z',
      client_device_id: 'SECRETDEVICE',
      idempotency_key: 'SECRETKEY',
    }),
  ],
  orderItems: [
    row({
      order_id: 'o1',
      item_name_snapshot: 'Paneer Tikka',
      unit_price_paise: 28000,
      quantity: 2,
      addons_snapshot: [],
    }),
  ],
  bills: [
    row({
      id: 'b1',
      invoice_number: 'INV/1',
      subtotal_paise: 56000,
      discount_paise: 0,
      service_charge_paise: 0,
      taxable_paise: 56000,
      cgst_paise: 1400,
      sgst_paise: 1400,
      total_tax_paise: 2800,
      round_off_paise: 0,
      grand_total_paise: 58800,
      line_items: [{ name: 'Paneer Tikka' }],
    }),
  ],
  billPayments: [row({ bill_id: 'b1', mode: 'upi', amount_paise: 58800, is_void: false })],
  subscriptionPayments: [row({ purpose: 'setup_fee', amount_paise: 58882, base_paise: null })],
};

const files = () =>
  Object.fromEntries(
    [...exportFiles(data, new Date('2026-11-01T00:00:00Z'))].map((f) => [f.name, f.text]),
  );

describe('what an export holds (SA-93)', () => {
  it('has the plan’s files', () => {
    expect(Object.keys(files())).toEqual([
      'README.txt',
      'profile.json',
      'menu.json',
      'tables.csv',
      'staff.csv',
      'waiters.csv',
      'orders.csv',
      'order_items.csv',
      'bills.csv',
      'bills.json',
      'bill_payments.csv',
      'subscription_payments.csv',
    ]);
  });

  it('asks for no secrets, and writes none it is handed', () => {
    const asked: string[] = Object.values(COLUMNS).flat();
    for (const secret of [
      'qr_token',
      'user_id',
      'client_device_id',
      'idempotency_key',
      'placed_by_user_id',
      'generated_by',
      'recorded_by',
      'razorpay_customer_id',
      'razorpay_subscription_id',
      'storefront_photo_path',
      'signup_source',
      'suspended_reason',
    ]) {
      expect(asked).not.toContain(secret);
    }
    const csvs = Object.entries(files())
      .filter(([name]) => name.endsWith('.csv'))
      .map(([, text]) => text)
      .join('');
    expect(csvs).not.toContain('SECRET');
  });

  it('writes rupees, local times and safe text in CSV, paise in JSON', () => {
    const { 'bills.csv': bills, 'bills.json': billsJson, ...rest } = files();
    expect(bills).toContain('INV/1');
    expect(bills).toContain('588.00');
    expect(JSON.parse(billsJson!)[0].grand_total_paise).toBe(58800);
    expect(rest['orders.csv']).toContain('2026-11-01 00:00');
    expect(rest['orders.csv']).toContain('T1');
    expect(rest['bill_payments.csv']).toContain('INV/1,upi,588.00');
    expect(rest['waiters.csv']).toContain(`"'=HYPERLINK(""x"")"`);
    expect(JSON.parse(rest['menu.json']!).addon_groups).toEqual([
      { id: 'g1', name: 'Extras', dish_ids: ['i1'] },
    ]);
    expect(rest['README.txt']).toContain('Spice Cafe');
  });
});

describe('closing', () => {
  it('asks for a reason and the code', () => {
    expect(closeAccountSchema.safeParse({ reason: 'Asked to', code: ' spice ' }).data).toEqual({
      reason: 'Asked to',
      code: 'spice',
    });
    expect(closeAccountSchema.safeParse({ reason: ' ', code: 'spice' }).success).toBe(false);
    expect(closeAccountSchema.safeParse({ reason: 'x', code: '' }).success).toBe(false);
  });

  it('tells the owner the last day, and whom to ask', () => {
    const closed = {
      name: 'Spice <Cafe>',
      timezone: 'Asia/Kolkata',
      removal_due_at: '2026-11-30T20:00:00Z',
      recipients: ['owner@spice.test'],
    };
    const email = closureEmail(closed, { email: 'help@menumesh.test', phone: null });
    expect(email.subject).toContain('Spice <Cafe>');
    expect(email.text).toContain('help@menumesh.test by 1 Dec 2026');
    expect(email.html).toContain('Spice &lt;Cafe&gt;');
    expect(closureEmail(closed, { email: null, phone: null }).text).toContain(
      'MenuMesh support by',
    );
    expect(closureEmail(closed, { email: 'help@menumesh.test', phone: '98765' }).text).toContain(
      'at help@menumesh.test or 98765 by',
    );
  });

  it('stops every mandate that could still charge', () => {
    const can = (razorpayStatus: string | null, cancelAtPeriodEnd = false) =>
      mandateCanCharge({ razorpayStatus, cancelAtPeriodEnd });
    for (const status of ['created', 'authenticated', 'active', 'pending', 'halted']) {
      expect(can(status)).toBe(true);
    }
    // Set to end with the paid period: nothing more to stop. A retry still charges.
    expect(can('active', true)).toBe(false);
    expect(can('pending', true)).toBe(true);
    for (const status of ['cancelled', 'completed', 'expired', null]) {
      expect(can(status)).toBe(false);
    }
  });

  it('reads what the database returns', () => {
    expect(parseClosure(null)).toBeNull();
    expect(
      parseClosure({
        closed_at: 'x',
        closed_by: null,
        reason: 'Asked',
        removal_due_at: 'y',
        removed_at: null,
      })?.removal_due_at,
    ).toBe('y');
    expect(parseExportRow(null)).toBeNull();
    expect(() => parseExportRow({ status: 'done', path: 'x' })).toThrow();
  });
});
