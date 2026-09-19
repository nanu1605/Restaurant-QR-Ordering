'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { BoardTiles } from '@/features/dashboard/components/mini-board';
import type { Board } from '@/features/orders/board';
import { useServerNow } from '@/features/orders/use-server-now';

/** How often the support board reloads (platform admins get no Realtime). */
const REFRESH_MS = 15_000;

/** The restaurant's tables as a manager sees them, reloaded every 15 seconds. */
export function SupportBoard({ board }: { board: Board }) {
  const router = useRouter();
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
