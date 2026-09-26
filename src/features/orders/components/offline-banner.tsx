'use client';

import { useMutationState, useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { CloudOff } from 'lucide-react';
import { useEffect } from 'react';

import { useLive } from '@/features/live/live-provider';
import { QUEUED_MUTATION_KEY } from '@/features/live/query-client';

import { type StatusChange, savedChanges } from '../offline-queue';
import { useStatusChange } from '../use-board';

/**
 * Offline banner for the live screens (spec §19 Phase 9, docs/DECISIONS.md
 * P9-5): how many dish moves wait on this device. On load, and when the
 * network comes back, it resends the ones a reload or another closed tab left
 * behind.
 */
export function OfflineBanner({ className }: { className?: string }) {
  const { memberId, connection } = useLive();
  const queryClient = useQueryClient();
  const { mutate } = useStatusChange();
  const waiting = useMutationState({
    filters: { mutationKey: QUEUED_MUTATION_KEY, status: 'pending' },
    select: (mutation) => mutation.state.failureCount,
  });

  useEffect(() => {
    const resend = () => {
      // Moves this tab is still sending are left alone; resending is safe anyway.
      const sending = new Set(
        queryClient
          .getMutationCache()
          .findAll({ mutationKey: QUEUED_MUTATION_KEY, status: 'pending' })
          .map((mutation) => (mutation.state.variables as StatusChange).key),
      );
      for (const change of savedChanges(memberId)) {
        if (!sending.has(change.key)) mutate(change);
      }
    };
    resend();
    window.addEventListener('online', resend);
    return () => window.removeEventListener('online', resend);
  }, [memberId, mutate, queryClient]);

  const count = waiting.length;
  const kept =
    count === 0 ? null : `${count} ${count === 1 ? 'change' : 'changes'} kept on this device`;
  let message: string | null = null;
  if (connection === 'offline') {
    message = kept
      ? `Offline. ${kept}, sent when you’re back online. Other actions need a connection.`
      : 'Offline. Dish status changes are kept on this device and sent when you’re back online. Other actions need a connection.';
  } else if (waiting.some((failures) => failures > 0)) {
    // Online, but the server doesn't answer: the changes keep retrying.
    message = `Can’t reach the server. ${kept}, sent as soon as it answers.`;
  }

  return (
    // Always in the accessibility tree (sr-only while empty), so screen readers
    // announce the message when it appears.
    <div role="status" className={cn('empty:sr-only', className)}>
      {message && (
        <p className="flex items-start gap-2 rounded-lg border-2 border-attention bg-surface px-3 py-2 text-sm text-ink">
          <CloudOff aria-hidden className="mt-0.5 size-4 shrink-0 text-attention" />
          {message}
        </p>
      )}
    </div>
  );
}
