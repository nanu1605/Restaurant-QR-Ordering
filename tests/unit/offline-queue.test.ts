// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  dropChange,
  QUEUE_TTL_MS,
  saveChange,
  savedChanges,
} from '@/features/orders/offline-queue';

const RAVI = 'member-ravi';
const KAVITA = 'member-kavita';
const served = { key: 'k1', ids: ['dish-1'], status: 'served' as const };
const round = { key: 'k2', orderId: 'order-1' };

describe('offline status journal', () => {
  beforeEach(() => window.localStorage.clear());

  it('keeps changes in tap order until they reach the server', () => {
    saveChange(RAVI, served, 1000);
    saveChange(RAVI, round, 2000);
    expect(savedChanges(RAVI, 3000)).toEqual([served, round]);

    dropChange(RAVI, 'k1', 3000);
    expect(savedChanges(RAVI, 3000)).toEqual([round]);
    dropChange(RAVI, 'k2', 3000);
    expect(window.localStorage.length).toBe(0);
  });

  it('keeps a replayed change once, in its first place', () => {
    saveChange(RAVI, served, 1000);
    saveChange(RAVI, round, 2000);
    saveChange(RAVI, served, 5000);
    expect(savedChanges(RAVI, 6000)).toEqual([served, round]);
  });

  it('is per member, so another login never sends them', () => {
    saveChange(RAVI, served, 1000);
    expect(savedChanges(KAVITA, 1000)).toEqual([]);
  });

  it('forgets changes after a day', () => {
    saveChange(RAVI, served, 1000);
    saveChange(RAVI, round, 1000 + QUEUE_TTL_MS);
    expect(savedChanges(RAVI, 1000 + QUEUE_TTL_MS)).toEqual([round]);
  });

  it('ignores a damaged journal', () => {
    window.localStorage.setItem(`tableorder:queue:${RAVI}`, '{not json');
    expect(savedChanges(RAVI)).toEqual([]);
    window.localStorage.setItem(`tableorder:queue:${RAVI}`, JSON.stringify([{ change: {} }]));
    expect(savedChanges(RAVI)).toEqual([]);
    saveChange(RAVI, served);
    expect(savedChanges(RAVI)).toEqual([served]);
  });
});
