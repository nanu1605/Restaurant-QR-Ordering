'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { createContext, startTransition, use, useSyncExternalStore } from 'react';

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

/** The theme from the cookie, as the root layout rendered it. */
const CookieTheme = createContext<Theme>('system');

export function ThemeProvider({ theme, children }: { theme: Theme; children: React.ReactNode }) {
  return <CookieTheme value={theme}>{children}</CookieTheme>;
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/**
 * The theme on <html> (the cookie's while server rendering), and a setter
 * that repaints at once, then saves the choice; if saving fails (offline),
 * the page goes back to the theme it had.
 */
function useTheme(): [Theme, (theme: Theme) => void] {
  const rendered = use(CookieTheme);
  const theme = useSyncExternalStore(
    subscribe,
    () => parseTheme(document.documentElement.dataset.theme),
    () => rendered,
  );
  function change(next: Theme) {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = next;
    const data = new FormData();
    data.set('theme', next);
    startTransition(async () => {
      try {
        await setTheme(data);
      } catch {
        if (previous) root.dataset.theme = previous;
      }
    });
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
    <form action={setTheme} className={className}>
      <div
        role="group"
        aria-label={labels.group}
        className="inline-flex gap-0.5 rounded-lg border border-line bg-surface p-0.5"
      >
        {THEMES.map((value) => {
          const Icon = ICONS[value];
          return (
            <button
              key={value}
              type="submit"
              name="theme"
              value={value}
              aria-pressed={theme === value}
              onClick={(event) => {
                event.preventDefault();
                change(value);
              }}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-ink-muted transition-colors not-aria-pressed:hover:text-ink aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:ring-1 aria-pressed:ring-brand aria-pressed:ring-inset"
            >
              <Icon aria-hidden className="size-4" />
              {labels[value]}
            </button>
          );
        })}
      </div>
    </form>
  );
}

/** The theme choice inside a dropdown menu. */
export function ThemeRadioGroup({
  labels = THEME_LABELS,
  itemClassName,
}: {
  labels?: ThemeLabels;
  itemClassName?: string;
}) {
  const [theme, change] = useTheme();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{labels.group}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={theme} onValueChange={(v) => change(parseTheme(v))}>
        {THEMES.map((value) => {
          const Icon = ICONS[value];
          return (
            <DropdownMenuRadioItem key={value} value={value} className={itemClassName}>
              <Icon aria-hidden />
              {labels[value]}
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}

/** A theme button for the website's top bar. */
export function ThemeMenu({
  labels = THEME_LABELS,
  className,
}: {
  labels?: ThemeLabels;
  className?: string;
}) {
  const [theme] = useTheme();
  const Icon = ICONS[theme];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-touch"
            aria-label={labels.group}
            className={className}
          />
        }
      >
        <Icon aria-hidden className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <ThemeRadioGroup labels={labels} itemClassName="min-h-11" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
