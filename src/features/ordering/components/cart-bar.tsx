'use client';

import { ChevronRight, ShoppingBag } from 'lucide-react';
import Link from 'next/link';

import { formatINR } from '@/lib/money';

import { useStrings } from './lang-provider';

type CartBarProps = { href: string; count: number; totalPaise: number };

/** Sticky "3 items · ₹620 — View cart" bar (spec §13.1). */
export function CartBar({ href, count, totalPaise }: CartBarProps) {
  const t = useStrings();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30">
      <div className="pointer-events-auto mx-auto max-w-[560px] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Link
          href={href}
          className="flex h-14 items-center justify-between gap-3 rounded-xl bg-primary px-4 text-primary-foreground shadow-lg"
        >
          <span className="flex items-center gap-2 text-base font-semibold tabular-nums">
            <ShoppingBag aria-hidden className="size-5" />
            {t.cartBar.items(count)} · {formatINR(totalPaise, { fraction: 'auto' })}
          </span>
          <span className="flex items-center gap-1 text-base font-semibold">
            {t.cartBar.view}
            <ChevronRight aria-hidden className="size-5" />
          </span>
        </Link>
      </div>
    </div>
  );
}
