'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';

import { BoardTiles } from '@/features/dashboard/components/mini-board';
import { parseBoard } from '@/features/orders/board';
import { useServerNow } from '@/features/orders/use-server-now';

/** How often the support board reloads (platform admins get no Realtime). */
const REFRESH_MS = 15_000;

/**
 * The restaurant's tables as a manager sees them, reloaded every 15 seconds.
 * The board is parsed here, not on the server, so its fetch time is this
 * device's clock, which the elapsed times correct against (as on the staff
 * board).
 */
export function SupportBoard({ json }: { json: unknown }) {
  const router = useRouter();
  const board = useMemo(() => parseBoard(json), [json]);
  const nowMs = useServerNow(board);

  useEffect(() => {
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);

  if (board.tables.length === 0) {
    return <p className="text-sm text-ink-muted">No tables yet.</p>;
  }
  return <BoardTiles board={board} nowMs={nowMs} />;
}
