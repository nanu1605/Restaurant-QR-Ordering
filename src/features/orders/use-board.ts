'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useLive } from '@/features/live/live-provider';
import {
  BOARD_MUTATION_KEY,
  BOARD_REFETCH_MS,
  boardKey,
  QUEUED_MUTATION_KEY,
} from '@/features/live/query-client';
import { createClient } from '@/lib/supabase/browser';

import { markOrderServed, setItemsStatus } from './actions';
import { type Board, fetchBoard } from './board';
import { dropChange, saveChange, type StatusChange } from './offline-queue';
import { withItemStatus, withRoundServed } from './optimistic';
import { useStaffLang, useStaffStrings } from './staff-lang';
import type { Refusal } from './strings';

/** Dishes by their Hindi name where they have one (docs/DECISIONS.md P11-16). */
function withHindiNames(board: Board): Board {
  return {
    ...board,
    tables: board.tables.map((table) =>
      table.session
        ? {
            ...table,
            session: {
              ...table.session,
              rounds: table.session.rounds.map((round) => ({
                ...round,
                items: round.items.map((item) =>
                  item.nameHi ? { ...item, name: item.nameHi } : item,
                ),
              })),
            },
          }
        : table,
    ),
  };
}

/**
 * The live board, hydrated from the server and kept fresh by Realtime (spec
 * §12). Pass `watchOnly` for a component that only needs the query kept alive
 * and polling (it won't re-render on changes). A worker panel in Hindi sees the
 * dishes' Hindi names; the cache keeps the board as the server sent it.
 */
export function useBoard({ watchOnly = false }: { watchOnly?: boolean } = {}) {
  const { memberId } = useLive();
  const lang = useStaffLang();
  const queryClient = useQueryClient();
  // While this device is changing the board, its last change refetches (see
  // useBoardAction); an automatic refetch in between would undo the optimistic
  // update on screen.
  const idle = () => queryClient.isMutating({ mutationKey: BOARD_MUTATION_KEY }) === 0;
  return useQuery({
    queryKey: boardKey(memberId),
    queryFn: () => fetchBoard(createClient()),
    refetchInterval: () => (idle() ? BOARD_REFETCH_MS : false),
    refetchOnWindowFocus: () => idle(),
    refetchOnReconnect: () => idle(),
    notifyOnChangeProps: watchOnly ? [] : undefined,
    select: lang === 'hi' ? withHindiNames : undefined,
  });
}

/** An action's refusal, carried through TanStack Query as an error. */
export class ActionFailed extends Error {}

type Result = { ok: true } | ({ ok: false } & Refusal);

type BoardActionOptions<TVars> = {
  action: (vars: TVars) => Promise<Result>;
  /** Shown straight away; the refetch after the action replaces it with the truth. */
  optimistic?: (board: Board, vars: TVars) => Board;
  /** Toast on success, if the change isn't obvious on screen. */
  successMessage?: (vars: TVars) => string | undefined;
  /** Waits for the network and keeps the change on the device meanwhile (useStatusChange). */
  queue?: { save: (vars: TVars) => void; drop: (vars: TVars) => void };
};

/**
 * Runs a board change (docs/DECISIONS.md P4-19): optimistic update, server
 * action, then one refetch once this device's last change has finished, so
 * overlapping taps never flicker back. Errors show as a toast and the refetch
 * puts the board right.
 */
export function useBoardAction<TVars>({
  action,
  optimistic,
  successMessage,
  queue,
}: BoardActionOptions<TVars>) {
  const queryClient = useQueryClient();
  const { memberId } = useLive();
  const t = useStaffStrings();
  const key = boardKey(memberId);

  return useMutation({
    ...(queue
      ? {
          mutationKey: QUEUED_MUTATION_KEY,
          // Paused while offline, then sent once the network is back.
          networkMode: 'online',
          // Wi-Fi up but the server unreachable: the request throws a TypeError.
          retry: (_count: number, error: Error) => error instanceof TypeError,
        }
      : { mutationKey: BOARD_MUTATION_KEY }),
    // One after another in tap order, so a Revert or Remove never overtakes a
    // dish move still waiting to be sent.
    scope: { id: 'board' },
    mutationFn: async (vars: TVars) => {
      const result = await action(vars);
      if (!result.ok) throw new ActionFailed(t.refusal(result));
      return result;
    },
    onMutate: async (vars) => {
      queue?.save(vars);
      await queryClient.cancelQueries({ queryKey: key });
      if (optimistic) {
        queryClient.setQueryData<Board>(key, (board) => board && optimistic(board, vars));
      }
    },
    onSuccess: (_result, vars) => {
      const message = successMessage?.(vars);
      if (message) toast.success(message);
    },
    onError: (error) => {
      toast.error(
        error instanceof ActionFailed
          ? error.message
          : error instanceof TypeError
            ? t.network
            : t.generic,
      );
    },
    onSettled: (_result, _error, vars) => {
      queue?.drop(vars);
      if (queryClient.isMutating({ mutationKey: BOARD_MUTATION_KEY }) === 1) {
        void queryClient.invalidateQueries({ queryKey: ['board'] });
      }
    },
  });
}

/**
 * Dish status moves: one dish or a ticket forward, or a round served. They are
 * the only board changes that work offline (spec §19 Phase 9,
 * docs/DECISIONS.md P9-5): the board shows them at once and they reach the
 * server once the network is back, in order, even after a reload.
 */
export function useStatusChange() {
  const { memberId } = useLive();
  return useBoardAction({
    action: (change: StatusChange) =>
      'orderId' in change
        ? markOrderServed(change.orderId)
        : setItemsStatus(change.ids, change.status),
    optimistic: (board, change) =>
      'orderId' in change
        ? withRoundServed(board, change.orderId)
        : withItemStatus(board, change.ids, change.status),
    queue: {
      save: (change) => saveChange(memberId, change),
      drop: (change) => dropChange(memberId, change.key),
    },
  });
}
