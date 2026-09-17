'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useLive } from '@/features/live/live-provider';
import { BOARD_REFETCH_MS, billingKey } from '@/features/live/query-client';
import { createClient } from '@/lib/supabase/browser';

import { type DiscountChoice, fetchBillDraft, fetchBillingSessions } from './bill';

/** Open tables to bill, hydrated from the server and refreshed by Realtime events. */
export function useBillingSessions() {
  const { memberId } = useLive();
  return useQuery({
    queryKey: [...billingKey(memberId), 'sessions'],
    queryFn: () => fetchBillingSessions(createClient()),
    refetchInterval: BOARD_REFETCH_MS,
  });
}

/**
 * The bill preview for the chosen discount (docs/DECISIONS.md P5-14). The
 * previous preview stays on screen while the next one loads.
 */
export function useBillDraft(sessionId: string, choice: DiscountChoice) {
  const { memberId } = useLive();
  return useQuery({
    queryKey: [...billingKey(memberId), 'draft', sessionId, choice],
    queryFn: () => fetchBillDraft(createClient(), sessionId, choice),
    placeholderData: keepPreviousData,
    refetchInterval: BOARD_REFETCH_MS,
    retry: false,
  });
}

/** `value`, once it has stopped changing for `delayMs`. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
