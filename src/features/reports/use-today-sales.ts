'use client';

import { useQuery } from '@tanstack/react-query';

import { useLive } from '@/features/live/live-provider';
import { billingKey, BOARD_REFETCH_MS } from '@/features/live/query-client';
import { createClient } from '@/lib/supabase/browser';

import { parseSalesReport, type SalesReport } from './report';

/**
 * Today's sales for the dashboard (docs/DECISIONS.md P6-11). The key sits
 * under the billing keys, so a new bill refreshes it through Realtime.
 */
export function useTodaySales() {
  const { memberId } = useLive();
  return useQuery<SalesReport>({
    queryKey: [...billingKey(memberId), 'today'],
    queryFn: async () => {
      const { data, error } = await createClient().rpc('admin_report_sales', { p_filters: {} });
      if (error) throw error;
      return parseSalesReport(data);
    },
    refetchInterval: BOARD_REFETCH_MS,
  });
}
