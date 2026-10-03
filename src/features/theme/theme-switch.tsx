'use client';

import { cn } from 'cn';
import { Monitor, Moon, Sun, SunMoon } from 'lucide-react';
import { startTransition, useSyncExternalStore } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { setTheme } from './actions';
import { parseTheme, type Theme, THEME_LABELS, type ThemeLabels, THEMES } from './theme';

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/**
 * The theme on <html> (null until hydrated: the server can't see it), and a
 * setter that repaints at once, then saves the choice and re-renders.
 */
function useTheme(): [Theme | null, (theme: Theme) => void] {
  const theme = useSyncExternalStore(
    subscribe,
    () => parseTheme(document.documentElement.dataset.theme),
    () => null,
  );
  function change(next: Theme) {
    document.documentElement.dataset.theme = next;
    const data = new FormData();
    data.set('theme', next);
    startTransition(() => setTheme(data));
  }
  return [theme, change];
}

/** System / Light / Dark buttons. A plain form, so it also works before the page's JavaScript. */
export function ThemeSwitch({
  labels = THEME_LABELS,
  className,
}: {
  labels?: ThemeLabels;
  className?: string;
}) {
  const [theme, change] = useTheme();
  return (
    <form
      action={setTheme}
      role="group"
      aria-label={labels.group}
      className={cn(
        'inline-flex gap-0.5 rounded-lg border border-line bg-surface p-0.5',
        className,
      )}
    >
      {THEMES.map((value) => {
        const Icon = ICONS[value];
        return (
          <button
            key={value}
            type="submit"
            name="theme"
            value={value}
            aria-pressed={theme === null ? undefined : theme === value}
            onClick={(event) => {
              event.preventDefault();
              change(value);
            }}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-ink-muted transition-colors hover:text-ink aria-pressed:bg-muted aria-pressed:text-ink"
          >
            <Icon aria-hidden className="size-4" />
            {labels[value]}
          </button>
        );
      })}
    </form>
  );
}

/** The theme choice inside a dropdown menu. */
export function ThemeRadioGroup({ itemClassName }: { itemClassName?: string }) {
  const [theme, change] = useTheme();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{THEME_LABELS.group}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={theme ?? 'system'}
        onValueChange={(v) => change(parseTheme(v))}
      >
        {THEMES.map((value) => {
          const Icon = ICONS[value];
          return (
            <DropdownMenuRadioItem key={value} value={value} className={itemClassName}>
              <Icon aria-hidden />
              {THEME_LABELS[value]}
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}

/** A theme button for the website's top bar. */
export function ThemeMenu({ className }: { className?: string }) {
  const [theme] = useTheme();
  const Icon = theme ? ICONS[theme] : SunMoon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-touch"
            aria-label={THEME_LABELS.group}
            className={className}
          />
        }
      >
        <Icon aria-hidden className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <ThemeRadioGroup itemClassName="min-h-11" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
