'use client';

import { ArrowLeftRight, ChevronDown, CircleUser, Download, LifeBuoy, LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOptimistic, useRef, useSyncExternalStore, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LANG_NAMES, type Lang } from '@/features/ordering/strings';
import { useStaffLangChoice, useStaffStrings } from '@/features/orders/staff-lang';
import { setMyLanguage } from '@/features/staff/actions';
import { ThemeRadioGroup } from '@/features/theme/theme-switch';

const ITEM = 'min-h-11 px-2';

type InstallPrompt = Event & { prompt: () => Promise<unknown> };

// Chrome offers the install once per page load, perhaps before React hydrates, so it is kept
// from the moment this module loads.
let installPrompt: InstallPrompt | null = null;
const installListeners = new Set<() => void>();
function setInstallPrompt(prompt: InstallPrompt | null) {
  installPrompt = prompt;
  installListeners.forEach((listener) => listener());
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    setInstallPrompt(event as InstallPrompt);
  });
  window.addEventListener('appinstalled', () => setInstallPrompt(null));
}

/**
 * How this device can install the panel (docs/DECISIONS.md B-7): the browser's own prompt, or
 * Safari's Share → Add to Home Screen on an iPhone or iPad. Nothing once it is installed.
 */
function useInstall(installable: boolean): 'prompt' | 'safari' | null {
  return useSyncExternalStore(
    (onChange) => {
      installListeners.add(onChange);
      return () => installListeners.delete(onChange);
    },
    () => {
      if (!installable) return null;
      if (installPrompt) return 'prompt';
      const { standalone } = navigator as Navigator & { standalone?: boolean };
      // Apps' own in-app browsers leave "Safari/" out and can't add to the Home Screen.
      return standalone === false && /Safari\//.test(navigator.userAgent) ? 'safari' : null;
    },
    () => null,
  );
}

function install(how: 'prompt' | 'safari', safariSteps: string) {
  if (how === 'safari') {
    // It stays until closed, while the steps are followed.
    toast(safariSteps, { duration: Infinity });
    return;
  }
  // A prompt can only be shown once.
  installPrompt?.prompt().catch(() => {});
  setInstallPrompt(null);
}

type AccountMenuProps = {
  userName: string;
  roleLabel: string;
  /** Link to another panel the user can open. */
  switchTo?: { href: string; label: string };
  /** The panel has the install manifest (the staff and admin panels). */
  installable?: boolean;
  /** Get help's page (the admin panel); the page it is opened on goes along. */
  help?: string;
};

/**
 * The worker panel's language (docs/DECISIONS.md P11-15), saved on the login.
 * The panel draws again in it once saved; until then the choice shows at once.
 */
function LanguageRadioGroup({ lang }: { lang: Lang }) {
  const t = useStaffStrings();
  const [shown, setShown] = useOptimistic(lang);
  const [, startTransition] = useTransition();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{t.account.language}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={shown}
        onValueChange={(value) => {
          const next: Lang = value === 'hi' ? 'hi' : 'en';
          // Against what shows, so a quick change back is saved too (in order).
          if (next === shown) return;
          startTransition(async () => {
            setShown(next);
            const result = await setMyLanguage(next).catch(() => null);
            if (!result?.ok) toast.error(result ? t.refusal(result) : t.network);
          });
        }}
      >
        {(['en', 'hi'] as const).map((value) => (
          <DropdownMenuRadioItem key={value} value={value} lang={value} className={ITEM}>
            {LANG_NAMES[value]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}

/**
 * Who is signed in, the other panel, the theme, installing the app and Log out, in one menu.
 * Inside the worker panel it is in the panel's language and offers that language too.
 */
export function AccountMenu({
  userName,
  roleLabel,
  switchTo,
  installable = false,
  help,
}: AccountMenuProps) {
  const logout = useRef<HTMLFormElement>(null);
  const pathname = usePathname();
  const canInstall = useInstall(installable);
  const t = useStaffStrings();
  const staffLang = useStaffLangChoice();
  return (
    <>
      <form ref={logout} action="/logout" method="post" hidden />
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" className="h-11 gap-2 px-2.5" />}>
          <CircleUser aria-hidden className="size-6 sm:hidden" />
          {/* On phones only the icon shows; the name still labels the button. */}
          <span className="sr-only text-right sm:not-sr-only sm:block">
            <span className="block text-sm font-medium text-ink">{userName}</span>
            <span className="block text-xs font-normal text-ink-muted">{roleLabel}</span>
          </span>
          <ChevronDown aria-hidden className="hidden size-4 text-ink-muted sm:block" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-medium text-ink">{userName}</p>
            <p className="text-xs text-ink-muted">{roleLabel}</p>
          </div>
          <DropdownMenuSeparator />
          {switchTo && (
            <>
              <DropdownMenuLinkItem
                closeOnClick
                render={<Link href={switchTo.href} />}
                className={ITEM}
              >
                <ArrowLeftRight aria-hidden />
                {switchTo.label}
              </DropdownMenuLinkItem>
              <DropdownMenuSeparator />
            </>
          )}
          {help && (
            <>
              <DropdownMenuLinkItem
                closeOnClick
                render={<Link href={`${help}?from=${encodeURIComponent(pathname)}`} />}
                className={ITEM}
              >
                <LifeBuoy aria-hidden />
                Get help
              </DropdownMenuLinkItem>
              <DropdownMenuSeparator />
            </>
          )}
          {staffLang && (
            <>
              <LanguageRadioGroup lang={staffLang} />
              <DropdownMenuSeparator />
            </>
          )}
          <ThemeRadioGroup labels={t.account.theme} itemClassName={ITEM} />
          <DropdownMenuSeparator />
          {canInstall && (
            <DropdownMenuItem
              className={ITEM}
              onClick={() => install(canInstall, t.account.installSafari)}
            >
              <Download aria-hidden />
              {t.account.install}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className={ITEM} onClick={() => logout.current?.requestSubmit()}>
            <LogOut aria-hidden />
            {t.account.logOut}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
