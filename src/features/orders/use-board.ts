'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useLive } from '@/features/live/live-provider';
import { BOARD_MUTATION_KEY, BOARD_REFETCH_MS, boardKey } from '@/features/live/query-client';
import { createClient } from '@/lib/supabase/browser';

import { type Board, fetchBoard } from './board';

/** The live board, hydrated from the server and kept fresh by Realtime (spec §12). */
export function useBoard() {
  const { memberId } = useLive();
  return useQuery({
    queryKey: boardKey(memberId),
    queryFn: () => fetchBoard(createClient()),
    refetchInterval: BOARD_REFETCH_MS,
  });
}

/** An action's refusal, carried through TanStack Query as an error. */
export class ActionFailed extends Error {}

type Result = { ok: true } | { ok: false; error: string };

type BoardActionOptions<TVars> = {
  action: (vars: TVars) => Promise<Result>;
  /** Shown straight away; the refetch after the action replaces it with the truth. */
  optimistic?: (board: Board, vars: TVars) => Board;
  /** Toast on success, if the change isn't obvious on screen. */
  successMessage?: (vars: TVars) => string | undefined;
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
}: BoardActionOptions<TVars>) {
  const queryClient = useQueryClient();
  const { memberId } = useLive();
  const key = boardKey(memberId);

  return useMutation({
    mutationKey: BOARD_MUTATION_KEY,
    mutationFn: async (vars: TVars) => {
      const result = await action(vars);
      if (!result.ok) throw new ActionFailed(result.error);
      return result;
    },
    onMutate: async (vars) => {
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
        error instanceof ActionFailed ? error.message : 'Something went wrong. Try again.',
      );
    },
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: BOARD_MUTATION_KEY }) === 1) {
        void queryClient.invalidateQueries({ queryKey: ['board'] });
      }
    },
  });
}
