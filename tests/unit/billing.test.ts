import { describe, expect, it } from 'vitest';

import {
  halfRateLabel,
  lineName,
  parseBillDetail,
  parseBillDraft,
  parseBillingSessions,
  parseSampleBill,
  parseTotalOrders,
  percentLabel,
} from '@/features/billing/bill';
import {
  cashChange,
  checkPayments,
  discountValue,
  generateBillSchema,
  readTotalOrdersParams,
  totalOrdersFilters,
} from '@/features/billing/schemas';
import { addDays, datePresets } from '@/lib/date-range';
import { dbErrorMessage } from '@/lib/db-errors';
import { amountInWords } from '@/lib/money';

describe('amountInWords', () => {
  it('writes rupees in words with Indian numbering', () => {
    expect(amountInWords(66200)).toBe('Rupees Six Hundred Sixty Two Only');
    expect(amountInWords(6200)).toBe('Rupees Sixty Two Only');
    expect(amountInWords(0)).toBe('Rupees Zero Only');
    expect(amountInWords(1_100)).toBe('Rupees Eleven Only');
    expect(amountInWords(100_000_00)).toBe('Rupees One Lakh Only');
    expect(amountInWords(1_00_500_00)).toBe('Rupees One Lakh Five Hundred Only');
    expect(amountInWords(20_00_000_00)).toBe('Rupees Twenty Lakh Only');
    expect(amountInWords(12_34_56_789_00)).toBe(
      'Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine Only',
    );
    expect(amountInWords(1_000_00_00_000_00)).toBe('Rupees One Thousand Crore Only');
    expect(amountInWords(1_00_000_00_00_000_00)).toBe('Rupees One Lakh Crore Only');
  });

  it('adds paise when there are any', () => {
    expect(amountInWords(66250)).toBe('Rupees Six Hundred Sixty Two and Fifty Paise Only');
    expect(amountInWords(5)).toBe('Rupees Zero and Five Paise Only');
  });

  it('refuses negative or fractional amounts', () => {
    expect(() => amountInWords(-100)).toThrow(TypeError);
    expect(() => amountInWords(10.5)).toThrow(TypeError);
  });
});

describe('discountValue', () => {
  it('turns rupees into paise and percentages into basis points', () => {
    expect(discountValue('none', 'anything')).toBe(0);
    expect(discountValue('flat', '100')).toBe(10000);
    expect(discountValue('flat', ' 99.5 ')).toBe(9950);
    expect(discountValue('percent', '10')).toBe(1000);
    expect(discountValue('percent', '12.5')).toBe(1250);
    expect(discountValue('percent', '100')).toBe(10000);
  });

  it('is null until the text is a valid amount', () => {
    expect(discountValue('flat', '')).toBeNull();
    expect(discountValue('flat', '1.234')).toBeNull();
    expect(discountValue('flat', '-5')).toBeNull();
    expect(discountValue('percent', '100.01')).toBeNull();
    expect(discountValue('percent', 'ten')).toBeNull();
  });
});

describe('generateBillSchema', () => {
  const base = {
    sessionId: '11111111-1111-4111-8111-111111111111',
    discountType: 'percent' as const,
    discountValue: 1000,
    discountReason: 'Regular guest',
    applyServiceCharge: true,
    expectedGrandTotalPaise: 66200,
  };

  it('accepts a discount with a reason', () => {
    expect(generateBillSchema.safeParse(base).success).toBe(true);
    expect(
      generateBillSchema.safeParse({
        ...base,
        discountType: 'none',
        discountValue: 0,
        discountReason: '',
      }).success,
    ).toBe(true);
  });

  it('needs a reason for a discount and caps percentages at 100%', () => {
    expect(generateBillSchema.safeParse({ ...base, discountReason: '  ' }).success).toBe(false);
    expect(generateBillSchema.safeParse({ ...base, discountValue: 10001 }).success).toBe(false);
  });
});

describe('checkPayments and cashChange', () => {
  it('accepts payments that add up to the total', () => {
    expect(checkPayments([{ mode: 'cash', amount: '662', reference: '' }], 66200)).toEqual({
      ok: true,
      paidPaise: 66200,
    });
    expect(
      checkPayments(
        [
          { mode: 'cash', amount: '300', reference: '' },
          { mode: 'upi', amount: '362', reference: 'UTR 1' },
        ],
        66200,
      ).ok,
    ).toBe(true);
    expect(checkPayments([{ mode: 'cash', amount: '0', reference: '' }], 0).ok).toBe(true);
  });

  it('explains what is wrong otherwise', () => {
    expect(checkPayments([{ mode: 'cash', amount: '600', reference: '' }], 66200)).toEqual({
      ok: false,
      error: 'Payments must add up to the total.',
      paidPaise: 60000,
    });
    expect(checkPayments([{ mode: 'cash', amount: 'abc', reference: '' }], 66200).ok).toBe(false);
    expect(
      checkPayments(
        [
          { mode: 'cash', amount: '0', reference: '' },
          { mode: 'upi', amount: '662', reference: '' },
        ],
        66200,
      ),
    ).toMatchObject({ ok: false, error: 'Each payment needs an amount.' });
  });

  it('works out the change for cash', () => {
    expect(cashChange(100000, 66200)).toBe(33800);
    expect(cashChange(66200, 66200)).toBe(0);
    expect(cashChange(50000, 66200)).toBeNull();
    expect(cashChange(null, 66200)).toBeNull();
  });
});

describe('total orders filters', () => {
  const table = '22222222-2222-4222-8222-222222222222';

  it('reads the URL into database filters', () => {
    expect(
      totalOrdersFilters({
        from: '2026-09-10',
        to: '2026-09-12',
        table,
        waiter: 'not-a-uuid',
        payment: 'unpaid',
        mode: 'upi',
        invoice: ' 0042 ',
        void: 'hide',
        view: 'closed',
        page: '3',
      }),
    ).toEqual({
      from: '2026-09-10',
      to: '2026-09-12',
      table_id: table,
      payment_status: 'unpaid',
      payment_mode: 'upi',
      invoice: '0042',
      show_void: false,
      view: 'closed_unbilled',
      page: 3,
    });
  });

  it('drops anything malformed', () => {
    expect(
      totalOrdersFilters({
        from: '10/09/2026',
        to: '2026-09-01',
        mode: 'cheque',
        page: '0',
        payment: ['x'],
      }),
    ).toEqual({});
    expect(totalOrdersFilters({ from: '2026-09-10', to: '2026-09-01' })).toEqual({
      from: '2026-09-10',
    });
  });

  it('fixes impossible dates and ranges longer than a year, and says so', () => {
    expect(readTotalOrdersParams({ from: '2026-02-30' })).toEqual({
      filters: {},
      notice: 'That date doesn’t exist, so today is shown.',
    });
    expect(readTotalOrdersParams({ from: '2025-04-01', to: '2026-09-17' })).toEqual({
      filters: { from: '2025-04-01', to: '2026-04-02' },
      notice: 'Total orders shows up to a year at a time, so the range was shortened.',
    });
    expect(readTotalOrdersParams({ from: '2025-09-17', to: '2026-09-18' }).notice).toBeNull();
    expect(readTotalOrdersParams({ from: '2026-09-10', to: '2026-09-01' }).notice).toBe(
      'The end date was before the start date, so one day is shown.',
    );
    expect(readTotalOrdersParams({ from: '2026-09-10', to: '2026-09-31' })).toEqual({
      filters: { from: '2026-09-10' },
      notice: 'That end date doesn’t exist, so one day is shown.',
    });
  });

  it('builds date presets from the business day', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(datePresets('2026-09-03')).toEqual([
      { key: 'today', label: 'Today', from: '2026-09-03', to: '2026-09-03' },
      { key: 'yesterday', label: 'Yesterday', from: '2026-09-02', to: '2026-09-02' },
      { key: 'week', label: 'Last 7 days', from: '2026-08-28', to: '2026-09-03' },
      { key: 'month', label: 'This month', from: '2026-09-01', to: '2026-09-03' },
    ]);
  });
});

const totals = {
  subtotal_paise: 70000,
  discount_paise: 7000,
  service_charge_paise: 0,
  taxable_paise: 63000,
  cgst_paise: 1575,
  sgst_paise: 1575,
  total_tax_paise: 3150,
  round_off_paise: 50,
  grand_total_paise: 66200,
};

const line = {
  name: 'Butter Chicken',
  variant: 'Half',
  qty: 2,
  unit_price_paise: 28000,
  line_total_paise: 56000,
  food_type: 'non_veg',
};

const document = {
  id: '33333333-3333-4333-8333-333333333333',
  is_sample: false,
  session_id: '44444444-4444-4444-8444-444444444444',
  invoice_number: 'INV/2026-27/00001',
  document_type: 'tax_invoice',
  status: 'active',
  payment_status: 'unpaid',
  table_label: '5',
  waiter_name: 'Ravi',
  generated_at: '2026-09-17T12:00:00+05:30',
  generated_by_name: 'Priya',
  lines: [line],
  restaurant: { name: 'Spice Route', legal_name: null, gstin: '27ABCDE1234F1Z5', footer: 'Thanks' },
  gst_mode: 'regular',
  gst_rate_bps: 500,
  prices_include_tax: false,
  discount_type: 'percent',
  discount_value: 1000,
  discount_reason: 'Regular guest',
  service_charge_bps: 0,
  print_count: 0,
  paid_at: null,
  void_reason: null,
  voided_at: null,
  voided_by_name: null,
  ...totals,
};

const print = {
  paper_width: '80mm',
  timezone: 'Asia/Kolkata',
  print_waiter_on_bill: true,
  show_branding: true,
  upi: { vpa: 'spice@okicici', payee_name: 'Spice Route' },
};

describe('bill parsers', () => {
  it('parses the bill builder draft', () => {
    const draft = parseBillDraft({
      session: {
        id: 's1',
        table_label: '5',
        opened_at: '2026-09-17T11:00:00+05:30',
        status: 'open',
      },
      waiter: null,
      waiter_required: true,
      waiting_count: 0,
      unserved: [{ name: 'Paneer Tikka', variant: null, quantity: 1, status: 'ready' }],
      lines: [line],
      document_type: 'tax_invoice',
      discount_type: 'percent',
      discount_value: 1000,
      apply_service_charge: false,
      service_charge_bps: 0,
      settings: {
        gst_mode: 'regular',
        gst_rate_bps: 500,
        prices_include_tax: false,
        service_charge_enabled: false,
        service_charge_bps: 500,
        discounts: true,
      },
      totals: { ...totals, pre_round_paise: 66150 },
    });
    expect(draft.lines[0]).toEqual({
      name: 'Butter Chicken',
      variant: 'Half',
      quantity: 2,
      unitPricePaise: 28000,
      lineTotalPaise: 56000,
      foodType: 'non_veg',
    });
    expect(draft.totals.grandTotalPaise).toBe(66200);
    expect(draft.settings.serviceChargeEnabled).toBe(false);
    expect(draft.waiterRequired).toBe(true);
  });

  it('parses a stored bill with payments, audit and reopen state', () => {
    const detail = parseBillDetail({
      now: '2026-09-17T12:05:00+05:30',
      bill: document,
      print,
      session: { id: 's1', status: 'billed', opened_at: '2026-09-17T11:00:00+05:30' },
      payments: [
        {
          id: 'p1',
          mode: 'upi',
          amount_paise: 66200,
          reference: null,
          is_void: false,
          created_at: '2026-09-17T12:04:00+05:30',
          recorded_by_name: 'Priya',
        },
      ],
      audit: [
        {
          id: 'a1',
          action: 'bill.generated',
          actor_label: 'Priya',
          actor_role: 'manager',
          reason: null,
          before: null,
          after: { invoice_number: 'INV/2026-27/00001' },
          created_at: '2026-09-17T12:00:00+05:30',
        },
      ],
      reopen: { allowed: true, blocker: null, until: '2026-09-17T12:30:00+05:30' },
      features: { split_payments: false },
    });
    expect(detail.bill.restaurant).toMatchObject({
      name: 'Spice Route',
      legalName: null,
      city: null,
    });
    expect(detail.bill.discountReason).toBe('Regular guest');
    expect(detail.print.upi).toEqual({ vpa: 'spice@okicici', payeeName: 'Spice Route' });
    expect(detail.payments[0]?.amountPaise).toBe(66200);
    expect(detail.reopen.allowed).toBe(true);
    expect(detail.splitPayments).toBe(false);
  });

  it('parses the sample bill', () => {
    const sample = parseSampleBill({
      bill: { ...document, id: null, is_sample: true },
      print: { ...print, upi: null },
    });
    expect(sample.bill.isSample).toBe(true);
    expect(sample.print.upi).toBeNull();
  });

  it('parses open tables and total orders in both views', () => {
    expect(
      parseBillingSessions(
        {
          now: 'n',
          sessions: [
            {
              session_id: 's1',
              table_label: '5',
              opened_at: 'o',
              waiter_id: null,
              waiter_name: null,
              items: 3,
              subtotal_paise: 84000,
              unserved: 1,
              waiting: 0,
            },
          ],
        },
        42,
      ),
    ).toEqual({
      now: 'n',
      fetchedAt: 42,
      sessions: [
        {
          sessionId: 's1',
          tableLabel: '5',
          openedAt: 'o',
          waiterName: null,
          items: 3,
          subtotalPaise: 84000,
          unserved: 1,
          waiting: 0,
        },
      ],
    });

    const common = {
      today: '2026-09-17',
      from: '2026-09-17',
      to: '2026-09-17',
      page: 1,
      page_size: 50,
      total: 1,
      summary: {
        bills: 1,
        orders: 2,
        items: 3,
        gross_paise: 70000,
        discount_paise: 7000,
        tax_paise: 3150,
        total_paise: 66200,
        collected_paise: 66200,
        unpaid_bills: 0,
        void_bills: 0,
        closed_unbilled: 1,
      },
      tables: [{ id: 't5', label: '5' }],
      waiters: [{ id: 'w1', name: 'Ravi', is_active: true }],
    };
    const bills = parseTotalOrders({
      ...common,
      view: 'bills',
      rows: [
        {
          id: 'b1',
          invoice_number: 'INV/2026-27/00001',
          status: 'active',
          payment_status: 'paid',
          table_label: '5',
          waiter_name: 'Ravi',
          opened_at: 'o',
          generated_at: 'g',
          minutes: 60,
          items: 3,
          grand_total_paise: 66200,
          modes: ['upi'],
          generated_by_name: 'Priya',
        },
      ],
    });
    expect(bills.view === 'bills' && bills.rows[0]?.modes).toEqual(['upi']);
    expect(bills.summary.closedUnbilled).toBe(1);

    const closed = parseTotalOrders({
      ...common,
      view: 'closed_unbilled',
      rows: [
        {
          session_id: 's2',
          table_label: '6',
          waiter_name: null,
          opened_at: 'o',
          closed_at: 'c',
          closed_by_name: 'Ravi',
          reason: 'Walked out',
        },
      ],
    });
    expect(closed.view === 'closed_unbilled' && closed.rows[0]?.reason).toBe('Walked out');
  });

  it('labels rates and lines', () => {
    expect(percentLabel(500)).toBe('5%');
    expect(percentLabel(1250)).toBe('12.5%');
    expect(halfRateLabel(500)).toBe('2.5%');
    expect(halfRateLabel(1800)).toBe('9%');
    expect(lineName({ name: 'Butter Chicken', variant: 'Half' })).toBe('Butter Chicken (Half)');
    expect(lineName({ name: 'Paneer Tikka', variant: null })).toBe('Paneer Tikka');
  });
});

describe('billing error messages', () => {
  const message = (code: string, details = '') =>
    dbErrorMessage({ code: 'P0001', message: code, details });

  it('says what to do next', () => {
    expect(message('ORDERS_WAITING')).toBe('Approve or reject the waiting order first.');
    expect(message('WAITER_REQUIRED')).toBe('Assign a waiter before generating the bill.');
    expect(message('PAYMENT_MISMATCH', '66200')).toBe('Payments must add up to ₹662.00.');
    expect(message('PAYMENT_MISMATCH', 'x')).toBe('Payments must add up to the bill total.');
    expect(message('BILL_CHANGED', '66200')).toContain('Check the new total');
    expect(message('REOPEN_NOT_ALLOWED', 'table_inactive')).toContain('switched off');
    expect(message('REOPEN_NOT_ALLOWED', 'table_busy')).toContain('New guests');
    expect(message('REOPEN_NOT_ALLOWED', 'window')).toContain('time to reopen');
  });
});
