'use client';

import { cn } from 'cn';
import {
  ArrowLeft,
  BellRing,
  ChevronRight,
  CircleCheck,
  Minus,
  Play,
  Plus,
  ReceiptText,
  RotateCcw,
  ShoppingBag,
  Square,
} from 'lucide-react';
import { m, useInView, usePageInView } from 'motion/react';
import { useEffect, useReducer, useRef, useState, type RefObject } from 'react';

import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Money } from '@/components/shared/money';
import { StatusChip } from '@/components/shared/status-chip';
import { Button } from '@/components/ui/button';
import { formatClockTime } from '@/features/ordering/format';
import { MAX_LINE_QUANTITY } from '@/features/ordering/limits';
import { LANG_NAMES, STRINGS, type Strings } from '@/features/ordering/strings';
import { REQUESTS, RequestBadges } from '@/features/orders/components/request-badges';
import { TableStateBadge } from '@/features/orders/components/table-state-badge';
import { DEFAULT_TIMEZONE } from '@/lib/config';
import { formatINR } from '@/lib/money';

import {
  canMakeBill,
  cartCount,
  cartLines,
  cartTotal,
  DEMO_CATEGORIES,
  DEMO_MENU,
  DEMO_TABLE,
  demoBill,
  demoReducer,
  dishById,
  dishName,
  INITIAL_DEMO,
  NEXT_LABELS,
  nextHint,
  PAYMENT_LABELS,
  ticketStep,
  TICKET_ACTION,
  type DemoAction,
  type DemoDevice,
  type DemoDish,
  type DemoRound,
  type DemoState,
  type PaymentMode,
  type RequestKind,
} from '../demo/machine';
import { LaptopFrame, PhoneFrame, TabletFrame } from './device-frames';
import { usePrefersReducedMotion } from './motion';

/**
 * The /demo page: a visitor plays the guest, the kitchen and the counter for
 * one table. All state lives in a reducer (../demo/machine.ts); nothing is
 * sent anywhere. From lg all three devices show; below it, one at a time.
 */

const DEVICES: Array<{ id: DemoDevice; label: string; title: string }> = [
  { id: 'guest', label: 'Guest phone', title: 'Guest phone' },
  { id: 'kitchen', label: 'Kitchen', title: 'Kitchen tablet' },
  { id: 'counter', label: 'Counter', title: 'Counter laptop' },
];

const STEP_MS = 1200;
const TABLE = STRINGS.en.table(DEMO_TABLE);
const fadeIn = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.2 },
};
const pop = {
  initial: { opacity: 0, scale: 0.8 },
  animate: { opacity: 1, scale: 1 },
  transition: { duration: 0.2 },
};

type Act = (action: DemoAction) => void;

/** A placed round shows the clock time, as the guest's orders page does. */
function stamped(action: DemoAction): DemoAction {
  return action.type === 'place'
    ? { ...action, at: formatClockTime(new Date().toISOString(), DEFAULT_TIMEZONE) }
    : action;
}

/**
 * Moves focus once the pressed control has gone (a new page on the phone, a
 * served dish), so keyboard users aren't dropped at the top of the page. A
 * click's update is committed before the next frame, so the target exists.
 */
function focusSoon(target: RefObject<HTMLElement | null>) {
  requestAnimationFrame(() => target.current?.focus());
}

export function DemoSimulator() {
  const [state, dispatch] = useReducer(demoReducer, INITIAL_DEMO);
  const [active, setActive] = useState<DemoDevice>('guest');
  const [auto, setAuto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const pageInView = usePageInView();
  const reduced = usePrefersReducedMotion();
  const hint = nextHint(state);

  // "Show me" stops at the end, off screen, in a hidden tab and with reduced motion.
  if (auto && !(hint && inView && pageInView && !reduced)) setAuto(false);

  useEffect(() => {
    if (!auto) return;
    const step = nextHint(state);
    if (!step) return;
    const timer = window.setTimeout(() => {
      setActive(step.device);
      dispatch(stamped(step.action));
    }, STEP_MS);
    return () => window.clearTimeout(timer);
  }, [auto, state]);

  /** A visitor's own tap, which also stops "Show me". */
  const act: Act = (action) => {
    setAuto(false);
    dispatch(stamped(action));
  };
  const dot = hint && hint.device !== active ? hint.device : null;

  return (
    <div ref={ref} className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:flex-row sm:items-center sm:p-5">
        <p className="min-w-0 flex-1 text-base text-ink">
          <span className="font-semibold text-brand">Next step: </span>
          {hint
            ? hint.text
            : 'All done. The bill is paid and the table is free. Start again to play once more.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="touch"
            variant={auto ? 'default' : 'outline'}
            hidden={reduced}
            // Keeps focus when the last step disables it.
            disabled={!hint}
            focusableWhenDisabled
            onClick={() => setAuto((value) => !value)}
          >
            {auto ? <Square aria-hidden /> : <Play aria-hidden />}
            {auto ? 'Stop' : 'Show me'}
          </Button>
          <Button
            size="touch"
            variant="outline"
            onClick={() => {
              setAuto(false);
              setActive('guest');
              dispatch({ type: 'reset' });
            }}
          >
            <RotateCcw aria-hidden />
            Start again
          </Button>
        </div>
      </div>

      <p role="status" className="sr-only">
        {state.message}
      </p>

      <div role="group" aria-label="Device to show" className="grid grid-cols-3 gap-2 lg:hidden">
        {DEVICES.map((device) => (
          <button
            key={device.id}
            type="button"
            aria-pressed={active === device.id}
            onClick={() => {
              setAuto(false);
              setActive(device.id);
            }}
            className={cn(
              'inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2 py-1 text-center text-sm leading-tight font-semibold transition-colors',
              active === device.id
                ? 'border-brand bg-brand text-white'
                : 'border-line bg-surface text-ink hover:border-brand',
            )}
          >
            {device.label}
            {dot === device.id && (
              <>
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-attention" />
                <span className="sr-only"> (try this next)</span>
              </>
            )}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-x-8 gap-y-10 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
        <DeviceSection device="guest" shown={active === 'guest'}>
          <PhoneFrame className="mx-auto w-full max-w-[20rem]">
            <GuestPhone state={state} act={act} />
          </PhoneFrame>
        </DeviceSection>
        <DeviceSection device="kitchen" shown={active === 'kitchen'}>
          <TabletFrame screenClassName="max-sm:aspect-auto max-sm:h-[34rem]">
            <KitchenTablet state={state} act={act} />
          </TabletFrame>
        </DeviceSection>
        <DeviceSection device="counter" shown={active === 'counter'} className="lg:col-span-2">
          {/* The laptop's base is wider than its screen: the padding keeps it on the page. */}
          <div className="mx-auto w-full max-w-3xl px-[6%] lg:px-0">
            <LaptopFrame screenClassName="max-lg:aspect-auto max-lg:h-[32rem]">
              <CounterLaptop state={state} act={act} />
            </LaptopFrame>
          </div>
        </DeviceSection>
      </div>
    </div>
  );
}

function DeviceSection({
  device,
  shown,
  className,
  children,
}: {
  device: DemoDevice;
  shown: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const { title } = DEVICES.find((d) => d.id === device)!;
  return (
    <section
      aria-labelledby={`demo-${device}`}
      className={cn('flex min-w-0 flex-col gap-3', !shown && 'max-lg:hidden', className)}
    >
      <h2 id={`demo-${device}`} className="text-center text-base font-semibold text-ink-muted">
        {title}
      </h2>
      {children}
    </section>
  );
}

// ─── Guest phone ─────────────────────────────────────────────────────────────

function GuestPhone({ state, act }: { state: DemoState; act: Act }) {
  const t = STRINGS[state.lang];
  const other = state.lang === 'en' ? 'hi' : 'en';
  const titleRef = useRef<HTMLHeadingElement>(null);
  /** A tap that changes the phone's page, so focus moves to the new page. */
  const go: Act = (action) => {
    focusSoon(titleRef);
    act(action);
  };

  return (
    <div lang={state.lang} className="flex min-h-0 flex-1 flex-col text-sm">
      <header className="on-brand flex items-end justify-between gap-2 bg-brand px-4 pt-6 pb-2 text-white">
        <div className="min-w-0">
          <p className="truncate text-base font-bold">Spice Route</p>
          <p className="text-white/85">{t.table(DEMO_TABLE)}</p>
        </div>
        <button
          type="button"
          lang={other}
          onClick={() => act({ type: 'lang', lang: other })}
          className="min-h-11 shrink-0 rounded-md px-2 font-semibold underline underline-offset-4"
        >
          {LANG_NAMES[other]}
        </button>
      </header>
      {/* A new page fades in; the first paint (no message yet) doesn't. */}
      <m.div
        key={state.view}
        {...fadeIn}
        initial={state.message ? fadeIn.initial : false}
        className="flex min-h-0 flex-1 flex-col"
      >
        {state.view === 'menu' && (
          <GuestMenu state={state} t={t} act={act} go={go} titleRef={titleRef} />
        )}
        {state.view === 'cart' && (
          <GuestCart state={state} t={t} act={act} go={go} titleRef={titleRef} />
        )}
        {state.view === 'orders' && (
          <GuestOrders state={state} t={t} act={act} go={go} titleRef={titleRef} />
        )}
      </m.div>
    </div>
  );
}

type ViewProps = {
  state: DemoState;
  t: Strings;
  act: Act;
  go: Act;
  titleRef: RefObject<HTMLHeadingElement | null>;
};

const viewTitle = 'text-lg font-bold text-ink outline-none';

function GuestMenu({ state, t, act, go, titleRef }: ViewProps) {
  const count = cartCount(state);
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 ref={titleRef} tabIndex={-1} className={viewTitle}>
            {t.menu.heading}
          </h3>
          {state.rounds.length > 0 && (
            <Button
              variant="outline"
              size="touch"
              className="h-auto min-h-11 px-3 text-sm whitespace-normal"
              onClick={() => go({ type: 'view', view: 'orders' })}
            >
              {t.menu.tableOrders(state.rounds.length)}
              <ChevronRight aria-hidden />
            </Button>
          )}
        </div>
        {DEMO_CATEGORIES.map((category) => (
          <section key={category.id} className="flex flex-col gap-2">
            <h4 className="text-base font-semibold text-ink-muted">
              {state.lang === 'hi' ? category.nameHi : category.name}
            </h4>
            <ul className="flex flex-col gap-2">
              {DEMO_MENU.filter((dish) => dish.category === category.id).map((dish) => (
                <MenuRow
                  key={dish.id}
                  dish={dish}
                  state={state}
                  t={t}
                  quantity={state.cart[dish.id] ?? 0}
                  act={act}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {count > 0 && (
        <div className="p-3 pt-0">
          <button
            type="button"
            onClick={() => go({ type: 'view', view: 'cart' })}
            className="flex min-h-12 w-full items-center justify-between gap-2 rounded-xl bg-brand px-3 text-left font-semibold text-white shadow-lg"
          >
            <span className="flex items-center gap-2 tabular-nums">
              <ShoppingBag aria-hidden className="size-5 shrink-0" />
              {t.cartBar.items(count)} · {formatINR(cartTotal(state), { fraction: 'auto' })}
            </span>
            <span className="flex shrink-0 items-center gap-0.5">
              {t.cartBar.view}
              <ChevronRight aria-hidden className="size-5" />
            </span>
          </button>
        </div>
      )}
    </>
  );
}

function MenuRow({
  dish,
  state,
  t,
  quantity,
  act,
}: {
  dish: DemoDish;
  state: DemoState;
  t: Strings;
  quantity: number;
  act: Act;
}) {
  const name = dishName(dish, state.lang);
  // Add turns into the stepper and back: focus follows the swap.
  const swapRef = useRef<HTMLButtonElement>(null);
  return (
    <li className="flex items-center gap-2 rounded-lg bg-surface p-2.5 shadow-sm">
      <FoodTypeMark type={dish.foodType} label={t.foodType[dish.foodType]} />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold break-words text-ink">{name}</span>
        <Money paise={dish.paise} fraction="auto" className="text-ink-muted" />
      </span>
      {quantity === 0 ? (
        <Button
          ref={swapRef}
          variant="outline"
          size="touch"
          aria-label={t.menu.addDish(name)}
          className="border-brand px-3 text-brand"
          onClick={() => {
            focusSoon(swapRef);
            act({ type: 'add', dishId: dish.id });
          }}
        >
          {t.menu.add}
        </Button>
      ) : (
        <Stepper
          t={t}
          name={name}
          quantity={quantity}
          moreRef={swapRef}
          onLess={() => {
            if (quantity === 1) focusSoon(swapRef);
            act({ type: 'remove', dishId: dish.id });
          }}
          onMore={() => act({ type: 'add', dishId: dish.id })}
        />
      )}
    </li>
  );
}

/** The app's quantity stepper, without its own live region (the page has one). */
function Stepper({
  t,
  name,
  quantity,
  moreRef,
  onLess,
  onMore,
}: {
  t: Strings;
  name: string;
  quantity: number;
  moreRef?: RefObject<HTMLButtonElement | null>;
  onLess: () => void;
  onMore: () => void;
}) {
  return (
    <div
      role="group"
      aria-label={t.stepper.group(name)}
      className="inline-flex shrink-0 items-center rounded-lg border border-line bg-paper"
    >
      <Button
        variant="ghost"
        size="icon-touch"
        aria-label={quantity === 1 ? t.stepper.remove(name) : t.stepper.less(name)}
        onClick={onLess}
      >
        <Minus aria-hidden />
      </Button>
      <span className="min-w-6 text-center text-base font-semibold tabular-nums">{quantity}</span>
      <Button
        ref={moreRef}
        variant="ghost"
        size="icon-touch"
        aria-label={t.stepper.more(name)}
        disabled={quantity >= MAX_LINE_QUANTITY}
        onClick={onMore}
      >
        <Plus aria-hidden />
      </Button>
    </div>
  );
}

function GuestCart({ state, t, act, go, titleRef }: ViewProps) {
  const lines = cartLines(state);
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <Button
          variant="ghost"
          size="touch"
          className="-ml-2 self-start px-2 text-sm"
          onClick={() => go({ type: 'view', view: 'menu' })}
        >
          <ArrowLeft aria-hidden />
          {t.cart.back}
        </Button>
        <h3 ref={titleRef} tabIndex={-1} className={viewTitle}>
          {t.cart.title}
        </h3>
        {lines.length === 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-base font-semibold text-ink">{t.cart.empty}</p>
            <p className="text-ink-muted">{t.cart.emptyHint}</p>
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {lines.map(({ dish, quantity }) => {
                const name = dishName(dish, state.lang);
                return (
                  <li
                    key={dish.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface p-2.5 shadow-sm"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 font-semibold text-ink">
                        <FoodTypeMark
                          type={dish.foodType}
                          size="sm"
                          label={t.foodType[dish.foodType]}
                        />
                        {name}
                      </span>
                      <Money
                        paise={quantity * dish.paise}
                        fraction="auto"
                        className="text-ink-muted"
                      />
                    </span>
                    <Stepper
                      t={t}
                      name={name}
                      quantity={quantity}
                      onLess={() => {
                        if (quantity === 1) focusSoon(titleRef);
                        act({ type: 'remove', dishId: dish.id });
                      }}
                      onMore={() => act({ type: 'add', dishId: dish.id })}
                    />
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-between text-base font-semibold text-ink">
              <span>{t.cart.estimatedTotal}</span>
              <Money paise={cartTotal(state)} fraction="auto" />
            </div>
            <p className="text-ink-muted">{t.cart.taxesLater}</p>
          </>
        )}
      </div>
      {lines.length > 0 && (
        <div className="p-3 pt-0">
          <Button size="touch" className="w-full" onClick={() => go({ type: 'place' })}>
            {t.cart.place}
          </Button>
        </div>
      )}
    </>
  );
}

function GuestOrders({ state, t, act, go, titleRef }: ViewProps) {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <h3 ref={titleRef} tabIndex={-1} className={viewTitle}>
          {t.orders.title}
        </h3>
        {state.billed && (
          <p className="rounded-lg border border-status-served bg-surface p-3 text-ink">
            {t.orders.billed}
          </p>
        )}
        <ol className="flex flex-col gap-2">
          {state.rounds.map((round) => (
            <li
              key={round.number}
              className="flex flex-col gap-1 rounded-lg bg-surface p-3 shadow-sm"
            >
              <p className="text-ink-muted">{t.orders.round(round.number, round.at)}</p>
              <ul className="flex flex-col">
                {round.lines.map((line) => {
                  const dish = dishById(line.dishId);
                  return (
                    <li key={line.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
                      <FoodTypeMark
                        type={dish.foodType}
                        size="sm"
                        label={t.foodType[dish.foodType]}
                      />
                      <span className="min-w-0 flex-1 font-semibold text-ink">
                        {line.quantity} × {dishName(dish, state.lang)}
                      </span>
                      <m.span key={line.status} {...pop}>
                        <StatusChip
                          status={line.status}
                          label={t.status[line.status]}
                          className="h-7 text-sm"
                        />
                      </m.span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      </div>
      <div className="flex flex-col gap-2 border-t border-line p-3">
        {!state.paid && (
          <div className="grid grid-cols-2 gap-2">
            <ServiceButton state={state} t={t} act={act} kind="call_waiter" />
            {!state.billed && <ServiceButton state={state} t={t} act={act} kind="request_bill" />}
          </div>
        )}
        {!state.billed && (
          <Button variant="outline" size="touch" onClick={() => go({ type: 'view', view: 'menu' })}>
            {t.orders.orderMore}
          </Button>
        )}
      </div>
    </>
  );
}

function ServiceButton({
  state,
  t,
  act,
  kind,
}: {
  state: DemoState;
  t: Strings;
  act: Act;
  kind: RequestKind;
}) {
  const labels = t.service[kind];
  const Icon = kind === 'call_waiter' ? BellRing : ReceiptText;
  return (
    <Button
      variant="outline"
      size="touch"
      className="h-auto min-h-11 px-2 py-1.5 text-sm leading-tight whitespace-normal"
      onClick={() => act({ type: 'request', kind })}
    >
      <Icon aria-hidden />
      {state.requests.includes(kind) ? labels.sent : labels.idle}
    </Button>
  );
}

// ─── Kitchen tablet ──────────────────────────────────────────────────────────

const EDGES = {
  placed: 'border-l-status-placed',
  preparing: 'border-l-status-preparing',
  ready: 'border-l-status-ready',
  served: 'border-l-status-served',
} as const;

function KitchenTablet({ state, act }: { state: DemoState; act: Act }) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const free = state.rounds.length === 0 || state.paid !== null;
  const allServed = state.rounds.every((round) => !ticketStep(round));
  const requests = state.requests.map((kind) => ({
    id: kind,
    type: kind,
    status: 'open' as const,
    createdAt: '',
  }));
  /** A tap whose button goes away afterwards: focus moves to the table. */
  const settle: Act = (action) => {
    focusSoon(titleRef);
    act(action);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="flex items-center justify-between border-b border-line bg-surface px-4 py-2.5">
        <span className="text-base font-bold text-ink">Kitchen</span>
        <span className="inline-flex items-center gap-1.5 text-ink-muted">
          <span aria-hidden className="size-2 rounded-full bg-status-served" />
          Live
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 ref={titleRef} tabIndex={-1} className={viewTitle}>
            {TABLE}
          </h3>
          <TableStateBadge state={free ? 'free' : allServed ? 'all_served' : 'in_progress'} />
          <RequestBadges requests={requests} />
        </div>
        {state.requests.length > 0 && (
          <section
            aria-label="Customer requests"
            className="flex flex-col gap-2 rounded-lg border-2 border-attention bg-surface p-3"
          >
            {state.requests.map((kind) => {
              const { icon: Icon, line } = REQUESTS[kind];
              return (
                <div key={kind} className="flex flex-wrap items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-base font-semibold text-ink">
                    <Icon aria-hidden className="size-5 shrink-0 text-attention" />
                    {line}
                  </p>
                  <Button size="touch" onClick={() => settle({ type: 'resolve', kind })}>
                    Done<span className="sr-only">: {line.toLowerCase()}</span>
                  </Button>
                </div>
              );
            })}
          </section>
        )}
        {free ? (
          <p className="text-base text-ink-muted">
            {state.paid
              ? 'The bill is paid and the table is free for the next guests.'
              : 'No orders yet. Place one from the guest phone.'}
          </p>
        ) : (
          state.rounds.map((round) => (
            <Ticket key={round.number} round={round} act={act} settle={settle} />
          ))
        )}
      </div>
    </div>
  );
}

function Ticket({ round, act, settle }: { round: DemoRound; act: Act; settle: Act }) {
  const step = ticketStep(round);
  return (
    <m.article
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      aria-label={`${TABLE}, round ${round.number}`}
      className={cn(
        'flex flex-col gap-1 rounded-lg border border-l-4 border-line bg-surface p-3',
        EDGES[step?.status ?? 'served'],
      )}
    >
      <p className="font-semibold text-ink-muted">
        {TABLE} · Round {round.number}
      </p>
      <ul className="flex flex-col divide-y divide-line">
        {round.lines.map((line) => {
          const dish = dishById(line.dishId);
          return (
            <li key={line.id} className="flex flex-wrap items-center gap-2 py-2">
              <FoodTypeMark type={dish.foodType} />
              <span className="min-w-0 flex-1 text-base font-semibold text-ink">
                {line.quantity} × {dish.name}
              </span>
              <m.span key={line.status} {...pop}>
                <StatusChip status={line.status} className="h-7 text-sm" />
              </m.span>
              {line.status !== 'served' && (
                <Button
                  size="touch"
                  variant="outline"
                  onClick={() =>
                    (line.status === 'ready' ? settle : act)({ type: 'advance', lineId: line.id })
                  }
                >
                  {NEXT_LABELS[line.status]}
                  <span className="sr-only"> {dish.name}</span>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {step && step.lines.length > 1 && (
        <Button
          size="touch"
          className="self-start"
          onClick={() =>
            (step.status === 'ready' ? settle : act)({ type: 'advanceTicket', round: round.number })
          }
        >
          {TICKET_ACTION[step.status]}
          <span className="sr-only"> in round {round.number}</span>
        </Button>
      )}
    </m.article>
  );
}

// ─── Counter laptop ──────────────────────────────────────────────────────────

const PAYMENT_MODES: PaymentMode[] = ['cash', 'upi', 'card'];

function CounterLaptop({ state, act }: { state: DemoState; act: Act }) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bill = demoBill(state);
  const ready = canMakeBill(state);
  const settle: Act = (action) => {
    focusSoon(titleRef);
    act(action);
  };

  return (
    <div className="flex min-h-0 flex-1 text-sm">
      <div aria-hidden className="hidden w-36 shrink-0 flex-col gap-1 bg-surface p-3 md:flex">
        <span className="px-2 pb-1 font-bold text-brand">Admin</span>
        {['Live orders', 'Bills', 'Menu', 'Tables', 'Reports'].map((item) => (
          <span
            key={item}
            className={cn(
              'rounded px-2 py-1',
              item === 'Bills' ? 'bg-accent font-semibold text-ink' : 'text-ink-muted',
            )}
          >
            {item}
          </span>
        ))}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 ref={titleRef} tabIndex={-1} className={viewTitle}>
            Bill · {TABLE}
          </h3>
          {state.requests.includes('request_bill') && (
            <RequestBadges
              requests={[{ id: 'bill', type: 'request_bill', status: 'open', createdAt: '' }]}
            />
          )}
          {state.paid && (
            <m.span
              initial={{ opacity: 0, scale: 1.4 }}
              animate={{ opacity: 1, scale: 1 }}
              className="inline-flex items-center gap-1.5 rounded border-2 border-status-served px-2 py-0.5 text-base font-bold text-status-served"
            >
              <CircleCheck aria-hidden className="size-4" /> Paid · {PAYMENT_LABELS[state.paid]}
            </m.span>
          )}
        </div>
        {!state.billed ? (
          <>
            <p className="text-base text-ink-muted">
              {state.rounds.length === 0
                ? 'No orders yet. The bill is made here once the dishes are served.'
                : ready
                  ? 'Every dish is served. The bill is ready to make.'
                  : `${TABLE} is eating. Make the bill once every dish is served.`}
            </p>
            <Button
              size="touch"
              className="self-start"
              disabled={!ready}
              onClick={() => settle({ type: 'makeBill' })}
            >
              <ReceiptText aria-hidden />
              Make bill
            </Button>
          </>
        ) : (
          <>
            <m.div
              {...fadeIn}
              className="flex flex-col gap-1.5 rounded-lg bg-surface p-3 text-base shadow-sm"
            >
              {bill.lines.map((line) => (
                <BillRow
                  key={line.dish.id}
                  label={`${line.quantity} × ${line.dish.name}`}
                  paise={line.paise}
                />
              ))}
              <div className="my-1 border-t border-dashed border-line" />
              <BillRow label="Subtotal" paise={bill.subtotalPaise} muted />
              <BillRow label="GST 5%" paise={bill.gstPaise} muted />
              <BillRow label="Total" paise={bill.totalPaise} strong />
            </m.div>
            {state.paid ? (
              <p className="text-base text-ink-muted">{TABLE} is free for the next guests.</p>
            ) : (
              <div role="group" aria-labelledby="demo-payment" className="flex flex-col gap-2">
                <p id="demo-payment" className="font-semibold text-ink">
                  Record the payment
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {PAYMENT_MODES.map((mode) => (
                    <Button
                      key={mode}
                      variant="outline"
                      size="touch"
                      className="px-2"
                      onClick={() => settle({ type: 'pay', mode })}
                    >
                      {PAYMENT_LABELS[mode]}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
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
        'flex justify-between gap-3',
        muted ? 'text-ink-muted' : 'text-ink',
        strong && 'text-lg font-bold',
      )}
    >
      <span>{label}</span>
      <Money paise={paise} />
    </div>
  );
}
