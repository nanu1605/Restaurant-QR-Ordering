'use client';

import { createContext, use, useEffect, type ReactNode } from 'react';

import { LangProvider } from '@/features/ordering/components/lang-provider';
import type { Lang } from '@/features/ordering/strings';

import { STAFF_STRINGS, type StaffStrings } from './strings';

// Null outside the worker panel: /admin/live reuses its screens in English.
const StaffLangContext = createContext<Lang | null>(null);

/**
 * The worker panel in the login's language (docs/DECISIONS.md P11-15). The
 * customer options sheet and quantity stepper it reuses follow, and so does
 * <html lang>, for the menus, dialogs and toasts drawn outside the panel.
 */
export function StaffLangProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = lang;
    return () => {
      // Leaving for the admin panel (English, the only one reached from here in the browser):
      // Next.js has moved the URL by then. An error page replacing the panel keeps its language
      // (docs/DECISIONS.md VPS-12).
      if (!/^\/staff(?:\/|$)/.test(location.pathname)) document.documentElement.lang = 'en';
    };
  }, [lang]);
  return (
    <StaffLangContext value={lang}>
      <LangProvider lang={lang}>{children}</LangProvider>
    </StaffLangContext>
  );
}

/** The worker panel's language, or null outside it (the language switch shows only inside). */
export function useStaffLangChoice(): Lang | null {
  return use(StaffLangContext);
}

export function useStaffLang(): Lang {
  return use(StaffLangContext) ?? 'en';
}

/** The worker panel's words; English anywhere else. */
export function useStaffStrings(): StaffStrings {
  return STAFF_STRINGS[useStaffLang()];
}
