'use client';

import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { searchPlatform } from '../actions';
import type { SearchResults } from '../platform';

type Item = { href: string; label: string; detail: string };
type Group = { title: string; items: Item[] };

const RECENT_KEY = 'menumesh-super-search-recent';

// Recent picks are a per-browser convenience: any failure just means none.
function readRecent(): Item[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as Item[]).slice(0, 6) : [];
  } catch {
    return [];
  }
}

function remember(item: Item) {
  try {
    const rest = readRecent().filter((recent) => recent.href !== item.href);
    localStorage.setItem(RECENT_KEY, JSON.stringify([item, ...rest].slice(0, 6)));
  } catch {
    // Storage off: nothing to remember.
  }
}

function groups(results: SearchResults): Group[] {
  return [
    {
      title: 'Restaurants',
      items: results.restaurants.map((r) => ({
        href: `/super/restaurants/${r.restaurant_id}`,
        label: r.name,
        detail: r.match ?? [r.slug, r.city].filter(Boolean).join(', '),
      })),
    },
    {
      title: 'Payments',
      items: results.payments.map((p) => ({
        href: `/super/restaurants/${p.restaurant_id}#section-payments`,
        label: p.ref,
        detail: `${p.kind === 'payment' ? 'Payment' : 'Autopay subscription'}, ${p.name}`,
      })),
    },
    {
      title: 'Leads',
      items: results.leads.map((l) => ({
        href: `/super/leads?lead=${l.lead_id}`,
        label: l.name,
        detail: [l.restaurant_name, l.phone].filter(Boolean).join(', '),
      })),
    },
  ].filter((group) => group.items.length > 0);
}

/**
 * Search across the panel (docs/SUPER_ADMIN_PLAN.md 12d, docs/DECISIONS.md
 * SA-25): Ctrl+K or the button opens it; arrows move, Enter opens.
 */
export function SuperSearch() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <Button
        variant="outline"
        className="h-11 gap-2 px-3 md:h-9"
        aria-label="Search restaurants, phones and payments"
        aria-keyshortcuts="Control+K Meta+K"
        onClick={() => setOpen(true)}
      >
        <Search aria-hidden />
        <span className="hidden md:inline">Search</span>
        <kbd className="hidden rounded border border-line px-1 font-sans text-xs text-ink-muted md:inline">
          Ctrl K
        </kbd>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[10%] translate-y-0 gap-3 p-3 sm:max-w-xl">
          <DialogTitle className="sr-only">Search</DialogTitle>
          {open && <SearchPanel onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function SearchPanel({ onDone }: { onDone: () => void }) {
  const ids = useId();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ q: string; groups: Group[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [recent] = useState(readRecent);
  const latest = useRef('');

  const text = q.trim();
  useEffect(() => {
    latest.current = text;
    if (text.length < 2) return;
    const timer = setTimeout(async () => {
      const result = await searchPlatform(text);
      if (latest.current !== text) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setFound({ q: text, groups: groups(result.data) });
      setActive(0);
    }, 200);
    return () => clearTimeout(timer);
  }, [text]);

  const shown: Group[] =
    text.length < 2
      ? recent.length > 0
        ? [{ title: 'Recent', items: recent }]
        : []
      : found?.q === text
        ? found.groups
        : [];
  const items = shown.flatMap((group) => group.items);
  const optionId = (index: number) => `${ids}-option-${index}`;

  function go(item: Item) {
    remember(item);
    onDone();
    router.push(item.href);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + step + items.length) % items.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[active];
      if (item) go(item);
    }
  }

  const status =
    text.length < 2
      ? recent.length > 0
        ? null
        : 'Type a name, code, phone, GSTIN, FSSAI number, email or Razorpay ID.'
      : error
        ? error
        : found?.q !== text
          ? 'Searching…'
          : items.length === 0
            ? 'Nothing found.'
            : null;

  const starts = shown.map((_, g) =>
    shown.slice(0, g).reduce((count, group) => count + group.items.length, 0),
  );
  return (
    <div className="flex flex-col gap-3">
      <Input
        autoFocus
        role="combobox"
        aria-label="Search"
        aria-expanded={items.length > 0}
        aria-controls={`${ids}-list`}
        aria-autocomplete="list"
        aria-activedescendant={items.length > 0 ? optionId(active) : undefined}
        placeholder="Restaurants, phones, GSTIN, payments, leads"
        value={q}
        onChange={(event) => setQ(event.target.value)}
        onKeyDown={onKeyDown}
        className="h-11 text-base"
      />
      <p role="status" className="text-sm text-ink-muted empty:hidden">
        {status}
      </p>
      <div
        id={`${ids}-list`}
        role="listbox"
        aria-label="Results"
        className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto"
      >
        {shown.map((group, g) => (
          <div key={group.title} role="group" aria-labelledby={`${ids}-${group.title}`}>
            <p
              id={`${ids}-${group.title}`}
              className="px-2 pb-1 text-xs font-semibold tracking-wide text-ink-muted uppercase"
            >
              {group.title}
            </p>
            {group.items.map((item, i) => {
              const mine = starts[g] + i;
              return (
                <div
                  key={item.href + item.label}
                  id={optionId(mine)}
                  role="option"
                  aria-selected={mine === active}
                  onMouseMove={() => setActive(mine)}
                  onClick={() => go(item)}
                  className="flex min-h-11 cursor-pointer flex-col justify-center rounded-md px-2 py-1.5 aria-selected:bg-accent"
                >
                  <span className="text-sm font-medium text-ink">{item.label}</span>
                  {item.detail && <span className="text-xs text-ink-muted">{item.detail}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
