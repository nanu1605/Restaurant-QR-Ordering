import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { FILTER_LABELS, TABLE_STATE_LABELS } from '@/features/orders/board-view';
import { REJECT_REASONS, REMOVE_REASONS } from '@/features/orders/schemas';
import { HI_REFUSALS, STAFF_STRINGS } from '@/features/orders/strings';
import { fromDbError } from '@/lib/action-result';
import { ORDER_ITEM_STATUS_LABELS } from '@/lib/order-status';
import { dbErrorMessage } from '@/lib/db-errors';

// The worker panel in Hindi (docs/DECISIONS.md P11-15 to P11-18).

const { en, hi } = STAFF_STRINGS;
const DEVANAGARI = /[\u0900-\u097F]/;

/** Every string leaf of a dictionary, by its dotted path. */
function leaves(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) =>
      leaves(child, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

/** Codes the worker panel's actions can meet (lib/db-errors.ts, "Live orders" and the shared ones). */
const WORKER_CODES = [
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_INPUT',
  'RESTAURANT_READ_ONLY',
  'SESSION_NOT_OPEN',
  'ORDER_NOT_PENDING',
  'ORDER_NOT_ACCEPTED',
  'ORDER_NOT_ACTIVE',
  'ITEM_NOT_ACTIVE',
  'INVALID_STATUS_CHANGE',
  'REQUIRES_MANAGER',
  'REASON_REQUIRED',
  'ORDERING_UNAVAILABLE',
  'ITEM_UNAVAILABLE',
  'TABLE_BUSY',
];

describe('worker panel words', () => {
  it('English keeps the words the board already used', () => {
    expect(en.tableState).toBe(TABLE_STATE_LABELS);
    expect(en.filters).toBe(FILTER_LABELS);
    expect(en.status).toBe(ORDER_ITEM_STATUS_LABELS);
    expect(en.elapsed(65)).toBe('1 h 05 min');
    expect(en.table('5')).toBe('Table 5');
  });

  it('every Hindi word is in Devanagari, with nuktas as separate marks', () => {
    for (const [path, text] of leaves(hi)) {
      expect(text, path).toMatch(DEVANAGARI);
      expect(text, path).not.toMatch(/[\u0958-\u095F]/);
      expect(text, path).not.toContain('हिंदी');
    }
  });

  it('the dictionary file, functions included, writes nuktas as marks and हिन्दी as such', () => {
    const source = readFileSync('src/features/orders/strings.ts', 'utf8');
    expect(source).not.toMatch(/[\u0958-\u095F]/);
    expect(source).not.toContain('हिंदी');
  });

  it('Hindi has its own times, tables and counts', () => {
    expect(hi.elapsed(7)).toBe('7 मिनट');
    expect(hi.elapsed(125)).toBe('2 घं 05 मिनट');
    expect(hi.table('5')).toBe('टेबल 5');
    expect(hi.table('Terrace')).toBe('Terrace');
    expect(hi.drawer.waitingElsewhere(1)).toMatch(/^एक ऑर्डर/);
    expect(hi.drawer.waitingElsewhere(3)).toMatch(/^3 ऑर्डर/);
    expect(hi.drawer.closeOnTheWay(1)).toContain('हो जाएगी;');
    expect(hi.drawer.closeOnTheWay(2)).toContain('हो जाएँगी;');
    expect(hi.add.unavailable(['पनीर टिक्का', 'दाल'])).toBe(
      'पनीर टिक्का और दाल स्टॉक में नहीं हैं या मेन्यू में नहीं हैं, इसलिए इन्हें हटा दिया गया।',
    );
    expect(hi.drawer.removedBy('Ravi', null)).toBe('Ravi ने हटाया');
    expect(hi.offline.kept(1)).toBe('1 बदलाव इस डिवाइस पर रखा गया है');
    expect(hi.offline.kept(3)).toBe('3 बदलाव इस डिवाइस पर रखे गए हैं');
    expect(hi.remove.keeps(1, 'दाल')).toContain('1 × दाल रहेगा।');
    expect(hi.remove.keeps(2, 'दाल')).toContain('2 × दाल रहेंगे।');
    // The remove dialog's stepper counts what is removed.
    expect(hi.remove.stepper.more('दाल')).toBe('एक और दाल हटाएँ');
    expect(hi.drawer.removedBy(null, 'ग़लत डिश')).toBe('हटाया गया: ग़लत डिश');
  });

  it('preset reasons show in Hindi but are saved in English', () => {
    for (const reason of [...REJECT_REASONS, ...REMOVE_REASONS]) {
      expect(en.reason.text(reason)).toBe(reason);
      expect(hi.reason.text(reason), reason).toMatch(DEVANAGARI);
    }
    expect(hi.reason.text('Guest left early')).toBe('Guest left early');
  });
});

describe('worker panel refusals', () => {
  it('every code a worker action can meet has English and its own Hindi', () => {
    expect(Object.keys(HI_REFUSALS).sort()).toEqual([...WORKER_CODES].sort());
    for (const code of WORKER_CODES) {
      const english = dbErrorMessage({ code: 'P0001', message: code, details: '5' });
      expect(english, code).not.toBeNull();
      const hindi = hi.refusal({ error: english!, code, detail: '5' });
      expect(hindi, code).toMatch(DEVANAGARI);
      expect(hindi, code).not.toBe(hi.generic);
    }
  });

  it('English shows the server’s words; Hindi words them by code', () => {
    const refusal = fromDbError({ code: 'P0001', message: 'TABLE_BUSY', details: '5' }, 'test');
    expect(refusal).toEqual({
      ok: false,
      error: 'Table 5 has guests now. Choose another table.',
      code: 'TABLE_BUSY',
      detail: '5',
      fieldErrors: undefined,
    });
    expect(en.refusal(refusal)).toBe('Table 5 has guests now. Choose another table.');
    expect(hi.refusal(refusal)).toBe('टेबल 5 पर अभी मेहमान हैं। कोई दूसरी टेबल चुनें।');
    expect(hi.refusal({ ...refusal, detail: '' })).toBe(
      'उस टेबल पर अभी मेहमान हैं। कोई दूसरी टेबल चुनें।',
    );
  });

  it('a refusal without a known code is the generic message in Hindi', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unexpected = fromDbError({ code: '40001', message: 'deadlock' }, 'test');
    expect(unexpected).not.toHaveProperty('code');
    expect(hi.refusal(unexpected)).toBe(hi.generic);
    expect(hi.refusal({ error: 'Check the highlighted fields and try again.' })).toBe(hi.generic);
    expect(hi.refusal({ error: 'x', code: 'toString' })).toBe(hi.generic);
  });
});
