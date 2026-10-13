'use client';

import { createContext, type ReactNode, use } from 'react';

import { type Lang, STRINGS, type Strings } from '../strings';

// English unless a panel says otherwise: the worker panel reuses the options
// sheet and the quantity stepper, in its login's language (P11-15).
const LangContext = createContext<Lang>('en');

export function LangProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <LangContext value={lang}>{children}</LangContext>;
}

/** The customer panel's words in the phone's language. */
export function useStrings(): Strings {
  return STRINGS[use(LangContext)];
}
