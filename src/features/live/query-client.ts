import { isServer, QueryClient } from '@tanstack/react-query';

/**
 * TanStack Query for the live screens (spec §4, §12). A new client per server
 * render, one shared client in the browser (docs/DECISIONS.md P4-1).
 */
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Realtime events invalidate; this only stops a refetch right after hydrating.
        staleTime: 10_000,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

export function getQueryClient(): QueryClient {
  if (isServer) return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

/**
 * Board data depends on who is looking (the kitchen sees less, waiters have
 * "My tables"), so it is keyed by membership: a shared tablet that switches
 * login never shows the previous user's board.
 */
export const boardKey = (memberId: string) => ['board', memberId] as const;
export const menuKey = (restaurantId: string) => ['menu', restaurantId] as const;

/** Every change to the board runs under this key (see useBoardAction). */
export const BOARD_MUTATION_KEY = ['board-change'] as const;
/** In-stock switches on the Availability page. */
export const MENU_MUTATION_KEY = ['menu-change'] as const;

/** Safety net behind Realtime (spec §12). */
export const BOARD_REFETCH_MS = 30_000;
