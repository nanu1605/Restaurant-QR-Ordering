import type { Lang } from './strings';

/**
 * The name a guest sees for a dish or category (docs/DECISIONS.md, "Hindi
 * names"): on the Hindi menu, the restaurant's Hindi name when it has one, with
 * the typed name kept as altName so a search in either script still finds it.
 */
export function localName(
  name: string,
  nameHi: string | null | undefined,
  lang: Lang,
): { name: string; altName?: string } {
  return lang === 'hi' && nameHi ? { name: nameHi, altName: name } : { name };
}
