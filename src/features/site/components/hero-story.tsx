'use client';

import { cn } from 'cn';
import { CircleCheck, Pause, Play, Printer } from 'lucide-react';
import { AnimatePresence, m, useInView, usePageInView } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { FoodTypeMark, type FoodType } from '@/components/shared/food-type-mark';
import { Money } from '@/components/shared/money';
import { StatusChip } from '@/components/shared/status-chip';

import type { SiteContent } from '../content';
import { LaptopFrame, PhoneFrame, TabletFrame } from './device-frames';
import { usePrefersReducedMotion } from './motion';

/**
 * The hero scene (docs/DECISIONS.md W-3): one order travelling from a guest's
 * phone to the kitchen tablet and onto the bill. Steps: 0 menu, 1 dish added,
 * 2 placed, 3 preparing, 4 ready, 5 served, 6 bill, 7 paid. It plays only
 * while on screen and the tab is visible; with reduced motion it shows the
 * finished scene, and it can be paused (WCAG 2.2.2). The guest's phone speaks
 * the page's language; the kitchen board and the bill stay English, as in the app.
 */

const DURATIONS = [1600, 1400, 1700, 1500, 1500, 1700, 1700, 2800] as const;
const LAST = DURATIONS.length - 1;
const DISH_STATUSES = ['placed', 'preparing', 'ready', 'served'] as const;
type DishStatus = (typeof DISH_STATUSES)[number];

const MENU: Array<{ name: string; foodType: FoodType; paise: number }> = [
  { name: 'Paneer Tikka', foodType: 'veg', paise: 28000 },
  { name: 'Chicken 65', foodType: 'non_veg', paise: 32000 },
  { name: 'Dal Makhani', foodType: 'veg', paise: 24000 },
  { name: 'Butter Naan', foodType: 'veg', paise: 6000 },
];
const DISH = MENU[0]!;
const GST_PAISE = 1400; // 5% of ₹280

/** The guest phone's words, the menu's own (STRINGS) in the page's language, from the server. */
export type GuestWords = {
  table: string;
  /** Dish names, by their English name. */
  dishes: Record<string, string>;
  add: string;
  ordersTitle: string;
  round: string;
  status: Record<DishStatus, string>;
  oneItem: string;
  fourItems: string;
  place: string;
};

function dishStatus(step: number): DishStatus | null {
  return step < 2 ? null : DISH_STATUSES[Math.min(step - 2, 3)]!;
}

function captionFor(step: number): number {
  if (step <= 1) return 0;
  if (step === 2) return 1;
  if (step <= 4) return 2;
  return step === 5 ? 3 : 4;
}

const chip = 'h-[1.4em] gap-[0.25em] rounded px-[0.45em] text-[1em] [&_svg]:size-[1em]';
const pop = {
  initial: { opacity: 0, scale: 0.8 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.8 },
};

export function HeroStory({
  t,
  guest,
  className,
}: {
  t: SiteContent['story'];
  guest: GuestWords;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const pageInView = usePageInView();
  const reduced = usePrefersReducedMotion();
  const [paused, setPaused] = useState(false);
  const [step, setStep] = useState(0);
  const playing = inView && pageInView && !reduced && !paused;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(
      () => setStep((current) => (current + 1) % DURATIONS.length),
      DURATIONS[step],
    );
    return () => window.clearTimeout(timer);
  }, [playing, step]);

  const shown = reduced ? LAST : step;
  const caption = captionFor(shown);

  return (
    <figure ref={ref} className={cn('flex flex-col gap-5', className)}>
      <div aria-hidden className="relative h-[19.5rem] sm:h-[25rem] md:h-[27rem] lg:h-[29rem]">
        <LaptopFrame className="absolute top-0 right-0 hidden w-[25rem] md:flex lg:w-[24rem] xl:w-[27rem]">
          <BillScreen step={shown} />
        </LaptopFrame>
        <TabletFrame className="absolute top-2 left-0 w-[15.5rem] sm:w-[20rem] md:top-auto md:bottom-0 md:w-[21rem] lg:w-[20rem] xl:w-[22rem]">
          <BoardScreen step={shown} />
          {/* On narrow screens the bill appears on the tablet, as the admin panel would. */}
          <AnimatePresence>
            {shown >= 6 && (
              <m.div
                key="bill"
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 24 }}
                className="absolute inset-0 flex bg-paper/95 md:hidden"
              >
                <BillScreen step={shown} />
              </m.div>
            )}
          </AnimatePresence>
        </TabletFrame>
        <PhoneFrame className="absolute right-0 bottom-0 z-10 w-[8.75rem] sm:w-[10.5rem] md:right-[13.5rem] md:w-[10.5rem] lg:right-[12rem] xl:right-[13.5rem]">
          <GuestScreen t={guest} step={shown} playing={playing} />
        </PhoneFrame>
      </div>

      <figcaption className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setPaused((value) => !value)}
          aria-label={paused ? t.play : t.pause}
          hidden={reduced}
          // Hidden from the first paint too: the server can't know, and a late hide shifts the hero.
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink-muted hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:hidden"
        >
          {paused ? (
            <Play aria-hidden className="size-4" />
          ) : (
            <Pause aria-hidden className="size-4" />
          )}
        </button>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div aria-hidden className="flex gap-1.5">
            {t.steps.map((_, index) => (
              <span
                key={index}
                className={cn(
                  'h-1 w-6 rounded-full transition-colors duration-300',
                  index <= caption ? 'bg-brand' : 'bg-line',
                )}
              />
            ))}
          </div>
          <p aria-hidden className="text-sm text-ink-muted">
            {t.steps[caption]}
          </p>
          <ol className="sr-only">
            {t.steps.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ol>
        </div>
      </figcaption>
    </figure>
  );
}

/**
 * The guest's phone: the menu, then their order and its status. The finger
 * tap pulses only while the scene plays, so pausing stops all movement.
 */
function GuestScreen({ t, step, playing }: { t: GuestWords; step: number; playing: boolean }) {
  const status = dishStatus(step);
  return (
    <div className="flex h-full flex-col text-[0.5rem] sm:text-[0.6rem]">
      <div className="bg-primary px-[0.9em] pt-[2.4em] pb-[0.9em] text-primary-foreground">
        <p className="text-[1.15em] font-bold">Spice Route</p>
        <p>{t.table}</p>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {status === null ? (
          <m.ul key="menu" {...pop} className="flex flex-1 flex-col gap-[0.5em] p-[0.7em]">
            {MENU.map((dish, index) => (
              <li
                key={dish.name}
                className="flex items-center gap-[0.5em] rounded-md bg-surface p-[0.55em] shadow-sm"
              >
                <FoodTypeMark type={dish.foodType} className="size-[1.1em]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-ink">
                    {t.dishes[dish.name] ?? dish.name}
                  </span>
                  <Money paise={dish.paise} fraction="auto" className="text-ink-muted" />
                </span>
                {index === 0 && step === 1 ? (
                  <m.span
                    initial={{ scale: 0.6 }}
                    animate={{ scale: 1 }}
                    className="rounded bg-primary px-[0.6em] py-[0.2em] font-bold text-primary-foreground"
                  >
                    1
                  </m.span>
                ) : (
                  <span className="relative rounded border border-brand px-[0.5em] py-[0.15em] font-semibold text-brand">
                    {t.add}
                    {index === 0 && step === 0 && playing && <Tap />}
                  </span>
                )}
              </li>
            ))}
          </m.ul>
        ) : (
          <m.div key="orders" {...pop} className="flex flex-1 flex-col gap-[0.6em] p-[0.7em]">
            <p className="font-bold text-ink">{t.ordersTitle}</p>
            <div className="flex flex-col gap-[0.5em] rounded-md bg-surface p-[0.6em] shadow-sm">
              <p className="text-ink-muted">{t.round}</p>
              <div className="flex items-center gap-[0.4em]">
                <FoodTypeMark type="veg" className="size-[1.1em]" />
                <span className="flex-1 font-semibold text-ink">
                  1 × {t.dishes[DISH.name] ?? DISH.name}
                </span>
              </div>
              <AnimatePresence mode="popLayout" initial={false}>
                <m.span key={status} {...pop} className="self-start">
                  <StatusChip status={status} label={t.status[status]} className={chip} />
                </m.span>
              </AnimatePresence>
            </div>
          </m.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {step === 1 && (
          <m.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            className="m-[0.6em] flex items-center justify-between rounded-md bg-primary px-[0.7em] py-[0.6em] font-semibold text-primary-foreground"
          >
            <span>
              {t.oneItem} · <Money paise={DISH.paise} fraction="auto" />
            </span>
            <span className="relative">
              {t.place}
              {playing && <Tap />}
            </span>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The staff board on the kitchen tablet: table 5's card arrives and moves on. */
function BoardScreen({ step }: { step: number }) {
  const status = dishStatus(step);
  const edge: Record<DishStatus, string> = {
    placed: 'border-l-status-placed',
    preparing: 'border-l-status-preparing',
    ready: 'border-l-status-ready',
    served: 'border-l-status-served',
  };
  return (
    <div lang="en" className="flex h-full flex-col text-[0.5rem] sm:text-[0.6rem]">
      <div className="flex items-center justify-between border-b border-line bg-surface px-[0.9em] py-[0.6em]">
        <span className="font-bold text-ink">Tables</span>
        <span className="text-ink-muted">Kitchen · Live</span>
      </div>
      <div className="grid flex-1 grid-cols-3 gap-[0.6em] p-[0.7em]">
        <AnimatePresence mode="popLayout" initial={false}>
          {status ? (
            <m.div
              key="t5"
              initial={{ opacity: 0, scale: 0.85, y: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={cn(
                'flex flex-col gap-[0.4em] rounded-md border border-l-[0.35em] border-line bg-surface p-[0.5em] ring-brand/40 transition-colors duration-300',
                edge[status],
                status === 'placed' && 'ring-2',
              )}
            >
              <span className="text-[1.3em] font-bold text-ink">T5</span>
              <MiniLine name={DISH.name} status={status} />
            </m.div>
          ) : (
            <TableCard key="t5-free" label="T5" edge="border-l-line">
              <span className="text-ink-muted">Free</span>
            </TableCard>
          )}
        </AnimatePresence>
        <TableCard label="T2" edge="border-l-status-preparing">
          <MiniLine name="Dal Makhani" status="preparing" />
          <MiniLine name="Butter Naan" status="ready" />
        </TableCard>
        <TableCard label="T3" edge="border-l-line">
          <span className="text-ink-muted">Free</span>
        </TableCard>
        <TableCard label="T6" edge="border-l-status-served">
          <MiniLine name="Masala Dosa" status="served" />
        </TableCard>
        <TableCard label="T7" edge="border-l-line">
          <span className="text-ink-muted">Free</span>
        </TableCard>
        <TableCard label="T8" edge="border-l-status-placed">
          <MiniLine name="Veg Biryani" status="placed" />
        </TableCard>
      </div>
    </div>
  );
}

// The ref lets AnimatePresence's popLayout lift a leaving card out of the grid, instead of
// both cards sharing it for a frame and pushing the others along.
function TableCard({
  label,
  edge,
  children,
  ref,
}: {
  label: string;
  edge: string;
  children: React.ReactNode;
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      className={cn(
        'flex flex-col gap-[0.4em] rounded-md border border-l-[0.35em] border-line bg-surface p-[0.5em]',
        edge,
      )}
    >
      <span className="text-[1.3em] font-bold text-ink">{label}</span>
      {children}
    </div>
  );
}

function MiniLine({ name, status }: { name: string; status: DishStatus }) {
  return (
    <div className="flex flex-col items-start gap-[0.25em]">
      <span className="w-full truncate text-ink">{name}</span>
      <AnimatePresence mode="popLayout" initial={false}>
        <m.span key={status} {...pop}>
          <StatusChip status={status} className={chip} />
        </m.span>
      </AnimatePresence>
    </div>
  );
}

/** The bill in the admin panel: generated, printed, paid. */
function BillScreen({ step }: { step: number }) {
  const ready = step >= 6;
  return (
    <div lang="en" className="flex h-full w-full text-[0.55rem] sm:text-[0.6rem] lg:text-[0.65rem]">
      <div className="hidden w-[18%] flex-col gap-[0.6em] bg-surface p-[0.8em] md:flex">
        <span className="font-bold text-brand">Admin</span>
        {['Live orders', 'Bills', 'Menu', 'Tables', 'Reports'].map((item, index) => (
          <span
            key={item}
            className={cn(
              'rounded px-[0.4em] py-[0.2em]',
              index === 1 ? 'bg-accent text-ink' : 'text-ink-muted',
            )}
          >
            {item}
          </span>
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-[0.6em] p-[0.9em]">
        <div className="flex items-center justify-between">
          <span className="text-[1.25em] font-bold text-ink">Bill · Table 5</span>
          <AnimatePresence>
            {step === LAST && (
              <m.span
                initial={{ opacity: 0, scale: 1.6, rotate: -12 }}
                animate={{ opacity: 1, scale: 1, rotate: -6 }}
                className="inline-flex items-center gap-[0.3em] rounded border-2 border-status-served px-[0.5em] py-[0.15em] font-bold text-status-served"
              >
                <CircleCheck aria-hidden className="size-[1.1em]" /> Paid · UPI
              </m.span>
            )}
          </AnimatePresence>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          {ready ? (
            <m.div
              key="bill"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col gap-[0.45em] rounded-md bg-surface p-[0.8em] shadow-sm"
            >
              <BillRow label={`1 × ${DISH.name}`} paise={DISH.paise} />
              <BillRow label="GST 5%" paise={GST_PAISE} muted />
              <div className="my-[0.2em] border-t border-dashed border-line" />
              <BillRow label="Total" paise={DISH.paise + GST_PAISE} strong />
              <span className="mt-[0.3em] inline-flex items-center gap-[0.4em] self-start rounded bg-primary px-[0.6em] py-[0.3em] font-semibold text-primary-foreground">
                <Printer aria-hidden className="size-[1.1em]" /> Printed
              </span>
            </m.div>
          ) : (
            <m.p key="waiting" exit={{ opacity: 0 }} className="text-ink-muted">
              Table 5 is eating. Generate the bill when they ask for it.
            </m.p>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function BillRow({
  label,
  paise,
  muted,
  strong,
}: {
  label: string;
  paise: number;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex justify-between',
        muted ? 'text-ink-muted' : 'text-ink',
        strong && 'text-[1.15em] font-bold',
      )}
    >
      <span>{label}</span>
      <Money paise={paise} />
    </div>
  );
}

/** A finger tap on the control the guest uses next. */
function Tap() {
  return (
    <m.span
      className="pointer-events-none absolute top-1/2 left-1/2 size-[2.4em] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/30"
      initial={{ scale: 0.4, opacity: 0.9 }}
      animate={{ scale: 1.4, opacity: 0 }}
      transition={{ duration: 0.9, repeat: Infinity, ease: 'easeOut' }}
    />
  );
}
