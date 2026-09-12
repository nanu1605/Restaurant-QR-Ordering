import { describe, expect, it } from 'vitest';

import {
  billTabSchema,
  bpsToPercent,
  orderingTabSchema,
  percentToBps,
  settingsPatch,
  taxTabSchema,
} from '@/features/settings/schemas';
import { normalizeIndianMobile, waiterFormSchema } from '@/features/waiters/schemas';
import { buildUpiUrl } from '@/lib/upi';

describe('percentages and basis points', () => {
  it('convert both ways', () => {
    expect(percentToBps('5')).toBe(500);
    expect(percentToBps('7.5')).toBe(750);
    expect(percentToBps('12.25%')).toBe(1225);
    expect(percentToBps('100')).toBe(10_000);
    expect(bpsToPercent(500)).toBe('5');
    expect(bpsToPercent(750)).toBe('7.5');
    expect(bpsToPercent(1225)).toBe('12.25');
  });

  it('reject anything outside 0–100 with two decimals', () => {
    expect(percentToBps('')).toBeNull();
    expect(percentToBps('100.01')).toBeNull();
    expect(percentToBps('5.125')).toBeNull();
    expect(percentToBps('-1')).toBeNull();
  });
});

describe('tax tab', () => {
  const tax = {
    gstMode: 'regular',
    gstRateBps: 500,
    pricesIncludeTax: false,
    serviceChargeEnabled: false,
    serviceChargePercent: '0',
    gstin: '',
    fssaiLicense: '',
  } as const;

  it('validates and capitalises the GSTIN', () => {
    expect(taxTabSchema.parse({ ...tax, gstin: '23aaacd1234e1z5' }).gstin).toBe('23AAACD1234E1Z5');
    expect(taxTabSchema.safeParse({ ...tax, gstin: '23AAACD1234E1Z' }).success).toBe(false);
    expect(taxTabSchema.safeParse({ ...tax, fssaiLicense: '1234' }).success).toBe(false);
  });

  it('needs a service charge percentage when it is on', () => {
    const result = taxTabSchema.safeParse({
      ...tax,
      serviceChargeEnabled: true,
      serviceChargePercent: '',
    });
    expect(result.error?.issues[0].path).toEqual(['serviceChargePercent']);
  });

  it('becomes a database patch', () => {
    const values = taxTabSchema.parse({
      ...tax,
      serviceChargeEnabled: true,
      serviceChargePercent: '7.5',
      gstin: '23aaacd1234e1z5',
    });
    expect(settingsPatch('tax', values)).toEqual({
      gst_mode: 'regular',
      gst_rate_bps: 500,
      prices_include_tax: false,
      service_charge_enabled: true,
      service_charge_bps: 750,
      gstin: '23AAACD1234E1Z5',
      fssai_license: null,
    });
  });
});

describe('bill and ordering tabs', () => {
  const bill = {
    invoicePrefix: 'INV',
    paperWidth: '80mm',
    billFooterText: '',
    printWaiterOnBill: true,
    showUpiQrOnBill: true,
    upiVpa: '',
    upiPayeeName: '',
  } as const;

  it('needs a UPI ID before printing a UPI QR', () => {
    expect(billTabSchema.safeParse(bill).error?.issues[0].path).toEqual(['upiVpa']);
    expect(billTabSchema.safeParse({ ...bill, upiVpa: 'cafe@okicici' }).success).toBe(true);
    expect(billTabSchema.safeParse({ ...bill, upiVpa: 'not a vpa' }).success).toBe(false);
    expect(
      billTabSchema.safeParse({ ...bill, upiVpa: 'x', invoicePrefix: 'INV/2026' }).success,
    ).toBe(false);
  });

  it('keeps ordering numbers in range', () => {
    const ordering = {
      requireFirstOrderApproval: true,
      customerCancelWindowSeconds: 120,
      reopenWindowMinutes: 30,
      businessDayStartHour: 4,
      maxTablesPerWaiter: 1,
      staffCanRemoveServedItems: false,
    };
    expect(orderingTabSchema.safeParse(ordering).success).toBe(true);
    expect(
      orderingTabSchema.safeParse({ ...ordering, customerCancelWindowSeconds: 601 }).success,
    ).toBe(false);
    expect(orderingTabSchema.safeParse({ ...ordering, maxTablesPerWaiter: 0 }).success).toBe(false);
    expect(
      orderingTabSchema.safeParse({ ...ordering, businessDayStartHour: Number.NaN }).success,
    ).toBe(false);
  });
});

describe('UPI links', () => {
  it('build a upi://pay link, with the amount when given', () => {
    expect(buildUpiUrl({ vpa: 'cafe@okicici', payeeName: 'Bean There' })).toBe(
      'upi://pay?pa=cafe%40okicici&pn=Bean%20There&cu=INR',
    );
    expect(
      buildUpiUrl({ vpa: 'cafe@okicici', amountPaise: 66250, note: 'INV/2026-27/00001' }),
    ).toBe('upi://pay?pa=cafe%40okicici&am=662.50&cu=INR&tn=INV%2F2026-27%2F00001');
  });
});

describe('waiter profiles', () => {
  it('normalise Indian mobile numbers', () => {
    expect(normalizeIndianMobile('98765 43210')).toBe('9876543210');
    expect(normalizeIndianMobile('+91 98765-43210')).toBe('9876543210');
    expect(normalizeIndianMobile('919876543210')).toBe('9876543210');
    expect(normalizeIndianMobile('09876543210')).toBe('9876543210');
    expect(normalizeIndianMobile('5876543210')).toBeNull();
    expect(normalizeIndianMobile('12345')).toBeNull();
  });

  const waiter = {
    fullName: 'Ravi',
    phone: '',
    employeeCode: '',
    joinedOn: '',
    notes: '',
    loginMode: 'none',
    memberId: '',
    username: '',
    password: '',
  } as const;

  it('needs a login to link, or a username and password to create one', () => {
    expect(waiterFormSchema.safeParse(waiter).success).toBe(true);
    expect(
      waiterFormSchema.safeParse({ ...waiter, loginMode: 'link' }).error?.issues[0].path,
    ).toEqual(['memberId']);
    const create = waiterFormSchema.safeParse({
      ...waiter,
      loginMode: 'create',
      username: 'Ra',
      password: 'short',
    });
    expect(create.error?.issues.map((issue) => issue.path[0])).toEqual(['username', 'password']);
  });
});
