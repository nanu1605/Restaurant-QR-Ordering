'use client';

import { Bell } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatINR } from '@/lib/money';

import { markAlertsSeen } from '../actions';
import { activityLine, parseAlerts, type ActivityItem, type Alerts } from '../home';
import { formatDateTime } from '../platform';

const POLL_MS = 60_000;

// The Needs attention count from the latest poll, for Home's badge in the sidebar.
let attention: number | null = null;
const listeners = new Set<() => void>();
function setAttention(next: number) {
  if (next === attention) return;
  attention = next;
  listeners.forEach((listener) => listener());
}

export function useAttentionCount(): number | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => attention,
    () => null,
  );
}

function describe(item: ActivityItem): string {
  const line = activityLine(item);
  return [
    item.restaurant_name,
    line.amount && formatINR(line.amount.basePaise + line.amount.gstPaise, { fraction: 'auto' }),
    line.detail,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * The alerts bell (docs/SUPER_ADMIN_PLAN.md 12e, docs/DECISIONS.md SA-30):
 * asks every 60 s while the page is in view, shows a toast for each new
 * signup, payment, failed payment or lead after the first look, and counts
 * what this admin hasn't opened yet.
 */
export function AlertsBell() {
  const [alerts, setAlerts] = useState<Alerts | null>(null);
  const [, startTransition] = useTransition();
  // Keys already shown; null until the first answer, which stays quiet.
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    let stopped = false;
    const deployment = (globalThis as { NEXT_DEPLOYMENT_ID?: string }).NEXT_DEPLOYMENT_ID;
    async function poll() {
      try {
        const response = await fetch('/super/alerts', {
          cache: 'no-store',
          headers: deployment ? { 'x-deployment-id': deployment } : undefined,
        });
        if (!response.ok || stopped) return;
        const next = parseAlerts(await response.json());
        if (stopped) return;
        if (seen.current) {
          const fresh = next.items.filter((item) => !seen.current!.has(item.key)).reverse();
          for (const item of fresh.slice(-3)) {
            toast(activityLine(item).title, { description: describe(item) });
          }
          if (fresh.length > 3)
            toast(`And ${fresh.length - 3} more`, { description: 'See Alerts.' });
        } else {
          seen.current = new Set();
        }
        next.items.forEach((item) => seen.current!.add(item.key));
        setAlerts(next);
        setAttention(next.attention);
      } catch {
        // Offline or signed out: the next look tries again.
      }
    }
    const first = window.setTimeout(() => void poll(), 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void poll();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const unread = alerts?.unread ?? 0;
  const label = unread > 0 ? `Alerts, ${unread >= 50 ? '50 or more' : unread} new` : 'Alerts';

  function opened(open: boolean) {
    if (!open || unread === 0) return;
    setAlerts((current) => current && { ...current, unread: 0 });
    startTransition(async () => {
      await markAlertsSeen();
    });
  }

  return (
    <DropdownMenu onOpenChange={opened}>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-touch" className="relative" aria-label={label} />
        }
      >
        <Bell aria-hidden />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute top-1 right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold text-primary-foreground tabular-nums"
          >
            {unread >= 50 ? '50+' : unread}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Alerts</DropdownMenuLabel>
          {(alerts?.items.length ?? 0) === 0 ? (
            <DropdownMenuItem disabled className="min-h-11 px-2">
              Nothing yet.
            </DropdownMenuItem>
          ) : (
            alerts!.items.map((item) => {
              const line = activityLine(item);
              const fresh =
                alerts!.seen_at !== null && Date.parse(item.at) > Date.parse(alerts!.seen_at);
              return (
                <DropdownMenuLinkItem
                  key={item.key}
                  href={line.href ?? '/super#activity'}
                  className="flex min-h-11 flex-col items-start gap-0.5 px-2 py-1.5"
                >
                  <span className="font-medium">
                    {line.title}
                    {fresh && <span className="sr-only"> (new)</span>}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {[describe(item), formatDateTime(item.at)].filter(Boolean).join(' · ')}
                  </span>
                </DropdownMenuLinkItem>
              );
            })
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem href="/super#activity" className="min-h-11 px-2">
          All activity
        </DropdownMenuLinkItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
