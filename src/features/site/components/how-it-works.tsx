'use client';

import { cn } from 'cn';
import { Banknote, CreditCard, QrCode, Smartphone } from 'lucide-react';
import { AnimatePresence, m } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Money } from '@/components/shared/money';
import { StatusChip } from '@/components/shared/status-chip';

import { STEPS } from '../content';

/**
 * The four steps. On laptops the picture stays in place while the steps
 * scroll past it, and follows the step in the middle of the screen; on
 * phones and tablets each step carries its own picture.
 */
export function HowItWorks() {
  const [active, setActive] = useState(0);
  const items = useRef<Array<HTMLLIElement | null>>([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.step));
        }
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    for (const item of items.current) if (item) observer.observe(item);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-16">
      <div aria-hidden className="hidden lg:block">
        <div className="sticky top-28 flex h-[26rem] items-center justify-center rounded-3xl border border-line bg-surface">
          <AnimatePresence mode="wait">
            <m.div
              key={active}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.3 }}
            >
              <StepPicture step={active} large />
            </m.div>
          </AnimatePresence>
        </div>
      </div>
      <ol className="flex flex-col gap-6 lg:gap-0">
        {STEPS.map((step, index) => (
          <li
            key={step.title}
            ref={(node) => {
              items.current[index] = node;
            }}
            data-step={index}
            className="lg:flex lg:min-h-[60vh] lg:items-center"
          >
            <div
              className={cn(
                'site-reveal flex w-full flex-col gap-3 rounded-2xl border bg-surface p-6 transition-colors duration-300 sm:p-8',
                active === index
                  ? 'lg:border-brand lg:shadow-lg lg:shadow-brand/10'
                  : 'border-line',
              )}
            >
              <span className="flex size-10 items-center justify-center rounded-full bg-primary text-base font-bold text-primary-foreground">
                {index + 1}
              </span>
              <h3 className="text-xl font-bold text-ink">{step.title}</h3>
              <p className="text-base text-ink-muted">{step.body}</p>
              <div
                aria-hidden
                className="mt-2 flex justify-center rounded-xl bg-paper p-5 lg:hidden"
              >
                <StepPicture step={index} />
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepPicture({ step, large = false }: { step: number; large?: boolean }) {
  const size = large ? 'text-base' : 'text-sm';
  switch (step) {
    case 0:
      return (
        <div className={cn('flex items-end gap-4', size, large && 'gap-6')}>
          <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-ink bg-surface px-5 py-4">
            <QrCode aria-hidden className={large ? 'size-28' : 'size-20'} strokeWidth={1.4} />
            <span className="font-bold text-ink">Table 5</span>
          </div>
          <Smartphone aria-hidden className={cn('text-brand', large ? 'size-20' : 'size-14')} />
        </div>
      );
    case 1:
      return (
        <div className={cn('flex w-full max-w-64 flex-col gap-2', size, large && 'w-80 max-w-80')}>
          {[
            { name: 'Paneer Tikka', paise: 28000, count: 1 },
            { name: 'Dal Makhani', paise: 24000, count: 1 },
            { name: 'Butter Naan', paise: 6000, count: 2 },
          ].map((dish) => (
            <div
              key={dish.name}
              className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 shadow-sm ring-1 ring-line"
            >
              <FoodTypeMark type="veg" size="sm" />
              <span className="flex-1 font-medium text-ink">{dish.name}</span>
              <span className="rounded bg-primary px-1.5 font-bold text-primary-foreground">
                {dish.count}
              </span>
            </div>
          ))}
          <div className="mt-1 flex justify-between rounded-lg bg-primary px-3 py-2.5 font-semibold text-primary-foreground">
            <span>4 items</span>
            <span>Place order</span>
          </div>
        </div>
      );
    case 2:
      return (
        <div className={cn('flex flex-col items-start gap-3', size)}>
          {(['placed', 'preparing', 'ready', 'served'] as const).map((status, index) => (
            <div
              key={status}
              className="flex items-center gap-3"
              style={{ marginLeft: index * 16 }}
            >
              <StatusChip status={status} className={large ? 'h-8 px-3 text-sm' : undefined} />
              <span className="text-ink-muted">Paneer Tikka</span>
            </div>
          ))}
        </div>
      );
    default:
      return (
        <div
          className={cn(
            'flex w-full max-w-64 flex-col gap-2 rounded-lg bg-surface p-4 shadow-md ring-1 ring-line',
            size,
            large && 'w-80 max-w-80',
          )}
        >
          <span className="font-bold text-ink">Bill · Table 5</span>
          <div className="flex justify-between text-ink">
            <span>4 items</span>
            <Money paise={64000} />
          </div>
          <div className="flex justify-between text-ink-muted">
            <span>GST 5%</span>
            <Money paise={3200} />
          </div>
          <div className="flex justify-between border-t border-dashed border-line pt-2 font-bold text-ink">
            <span>Total</span>
            <Money paise={67200} />
          </div>
          <div className="mt-1 flex gap-2">
            {[
              { label: 'Cash', icon: Banknote },
              { label: 'UPI', icon: QrCode },
              { label: 'Card', icon: CreditCard },
            ].map(({ label, icon: Icon }) => (
              <span
                key={label}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold',
                  label === 'UPI'
                    ? 'border-status-served bg-status-served text-status-served-foreground'
                    : 'border-line text-ink-muted',
                )}
              >
                <Icon aria-hidden className="size-3.5" />
                {label}
              </span>
            ))}
          </div>
        </div>
      );
  }
}
