import { describe, expect, it } from 'vitest';

import { describeLabels, parseTableLabels } from '@/features/tables/labels';
import { isLocalAppUrl, qrFileName, tableUrl } from '@/features/tables/qr';

describe('parseTableLabels', () => {
  it('reads a single table name', () => {
    expect(parseTableLabels('5')).toEqual({ ok: true, labels: ['5'] });
    expect(parseTableLabels('  Terrace   2 ')).toEqual({ ok: true, labels: ['Terrace 2'] });
    expect(parseTableLabels('Room 101-B')).toEqual({ ok: true, labels: ['Room 101-B'] });
  });

  it('expands ranges with any dash', () => {
    expect(parseTableLabels('1-3')).toEqual({ ok: true, labels: ['1', '2', '3'] });
    expect(parseTableLabels('1 – 3')).toEqual({ ok: true, labels: ['1', '2', '3'] });
    expect(parseTableLabels('T1-T3')).toEqual({ ok: true, labels: ['T1', 'T2', 'T3'] });
    expect(parseTableLabels('Terrace 1-2')).toEqual({
      ok: true,
      labels: ['Terrace 1', 'Terrace 2'],
    });
    expect(parseTableLabels('08-10')).toEqual({ ok: true, labels: ['08', '09', '10'] });
  });

  it('refuses backwards, oversized and empty input', () => {
    expect(parseTableLabels('5-1')).toMatchObject({ ok: false });
    expect(parseTableLabels('1-101')).toEqual({
      ok: false,
      error: 'Add at most 100 tables at a time.',
    });
    expect(parseTableLabels('   ')).toMatchObject({ ok: false });
    expect(parseTableLabels('x'.repeat(31))).toMatchObject({ ok: false });
  });

  it('describes what will be added', () => {
    expect(describeLabels(['5'])).toBe('Adds table 5');
    expect(describeLabels(['1', '2', '3'])).toBe('Adds 3 tables: 1, 2, 3');
    expect(describeLabels(Array.from({ length: 20 }, (_, i) => String(i + 1)))).toBe(
      'Adds 20 tables: 1, 2, 3 … 20',
    );
  });
});

describe('table QR codes', () => {
  it('point at the customer page (spec §8.3)', () => {
    expect(tableUrl('https://app.example.com/', 'AbCdEfGh12345678')).toBe(
      'https://app.example.com/t/AbCdEfGh12345678',
    );
  });

  it('flag addresses that only work on a local network', () => {
    expect(isLocalAppUrl('http://localhost:3000')).toBe(true);
    expect(isLocalAppUrl('http://192.168.1.20:3000')).toBe(true);
    expect(isLocalAppUrl('http://172.20.0.5')).toBe(true);
    expect(isLocalAppUrl('https://app.example.com')).toBe(false);
    expect(isLocalAppUrl('https://172.32.0.1')).toBe(false);
  });

  it('get safe download names', () => {
    expect(qrFileName('5')).toBe('table-5-qr.png');
    expect(qrFileName('Terrace 2 / Rooftop')).toBe('table-terrace-2-rooftop-qr.png');
    expect(qrFileName('★')).toBe('table-qr-qr.png');
  });
});
