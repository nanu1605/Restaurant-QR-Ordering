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
    // The admin panel, the only one reached from here in the browser, is English.
    return () => {
      document.documentElement.lang = 'en';
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
