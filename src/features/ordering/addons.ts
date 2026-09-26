import type { CustomerAddonGroup, CustomerCategory, CustomerMenuItem } from './types';

/**
 * Add-on choices (docs/DECISIONS.md P9-4), the same rules the database checks
 * when an order is placed: every chosen option in stock and in one of the
 * dish's groups, and each group chosen from between minSelect and maxSelect
 * times. Shared by the options sheet, the cart and the staff picker.
 */

/** A dish that needs the options sheet: it has options or add-ons. */
export function hasChoices(item: Pick<CustomerMenuItem, 'variants' | 'addonGroups'>): boolean {
  return item.variants.length > 0 || item.addonGroups.length > 0;
}

/** "Choose 1", "Choose 2 to 3", "Optional, up to 3". */
export function groupRule(group: Pick<CustomerAddonGroup, 'minSelect' | 'maxSelect'>): string {
  const { minSelect: min, maxSelect: max } = group;
  if (min === 0) return max === 1 ? 'Optional' : `Optional, up to ${max}`;
  return min === max ? `Choose ${min}` : `Choose ${min} to ${max}`;
}

/** The group's required choices can be made with what is in stock. */
export function canChoose(group: CustomerAddonGroup): boolean {
  return group.addons.filter((addon) => addon.isAvailable).length >= group.minSelect;
}

/** Why these add-ons can't be ordered with the dish, or null when they can. */
export function selectionError(groups: CustomerAddonGroup[], addonIds: readonly string[]) {
  const offered = new Set(
    groups.flatMap((group) => group.addons.filter((a) => a.isAvailable).map((a) => a.id)),
  );
  if (addonIds.some((id) => !offered.has(id))) return 'A choice is no longer available.';
  for (const group of groups) {
    const chosen = group.addons.filter((addon) => addonIds.includes(addon.id)).length;
    if (chosen < group.minSelect) {
      return group.minSelect === group.maxSelect
        ? `Choose ${group.minSelect} from ${group.name}.`
        : `Choose at least ${group.minSelect} from ${group.name}.`;
    }
    if (chosen > group.maxSelect) return `Choose up to ${group.maxSelect} from ${group.name}.`;
  }
  return null;
}

/** A cart line the menu would still take: the dish in stock, its option and its add-ons. */
export function lineFits(
  item: CustomerMenuItem | undefined,
  variantId: string | null,
  addonIds: readonly string[] = [],
): boolean {
  if (!item || !item.isAvailable) return false;
  const optionOk = variantId
    ? item.variants.some((v) => v.id === variantId)
    : item.variants.length === 0;
  return optionOk && selectionError(item.addonGroups, addonIds) === null;
}

type OrderLine = { menuItemId: string; variantId: string | null; addonIds?: readonly string[] };

/**
 * The lines to take out after the database refused dishes (ITEM_UNAVAILABLE
 * names the dishes, not the lines): those of each refused dish that the fresh
 * menu no longer takes, so "Pizza" stays when only "Pizza + Olives" ran out.
 * When the menu can't tell (it changed back, or couldn't be read), every line
 * of that dish goes, as before add-ons.
 */
export function refusedLines(
  menu: CustomerCategory[],
  lines: readonly OrderLine[],
  refusedIds: readonly string[],
): number[] {
  const items = new Map(menu.flatMap((c) => c.items.map((item) => [item.id, item] as const)));
  return [...new Set(refusedIds)].flatMap((id) => {
    const ofDish = lines.flatMap((line, index) => (line.menuItemId === id ? [index] : []));
    const unfit = ofDish.filter(
      (index) => !lineFits(items.get(id), lines[index]!.variantId, lines[index]!.addonIds),
    );
    return unfit.length > 0 ? unfit : ofDish;
  });
}

/** The chosen add-ons in the dish's order (group, then option), as the kitchen sees them. */
export function chosenAddons(groups: CustomerAddonGroup[], addonIds: readonly string[]) {
  return groups.flatMap((group) => group.addons.filter((addon) => addonIds.includes(addon.id)));
}
