'use client';

import { cn } from 'cn';
import { Check, ImageIcon, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { memo, useId, useMemo, useReducer, useState, useTransition, type Dispatch } from 'react';
import { toast } from 'sonner';

import { FoodTypeMark } from '@/components/shared/food-type-mark';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { normalizeCategoryName } from '@/features/menu/default-categories';
import { formatPriceInput, parsePriceInput } from '@/features/menu/schemas';

import { commitMenuImport, discardMenuImport, saveImportDraft } from '../actions';
import type { MenuIndex } from '../merge';
import {
  draftCounts,
  duplicateNames,
  isIncluded,
  itemFlags,
  ITEM_FLAGS,
  MAX_VARIANTS,
  type Draft,
  type DraftCategory,
  type DraftItem,
  type ItemAction,
  type ItemFlag,
} from '../draft';

/**
 * The review screen (spec §20A.4): nothing reaches the menu until the owner
 * confirms. Risky rows come first, every field is editable, and the commit is
 * one transaction (§20A.5).
 */

type ReviewAction =
  | { type: 'item'; category: string; key: string; patch: Partial<DraftItem>; review?: boolean }
  | { type: 'category'; category: string; patch: Partial<DraftCategory> }
  | { type: 'move'; category: string; key: string; to: string; newName?: string }
  | { type: 'delete'; category: string; key: string }
  | { type: 'merge'; category: string; into: string };

function reviewReducer(draft: Draft, action: ReviewAction): Draft {
  switch (action.type) {
    case 'item':
      return {
        ...draft,
        categories: draft.categories.map((category) =>
          category.key !== action.category
            ? category
            : {
                ...category,
                items: category.items.map((item) =>
                  item.key !== action.key
                    ? item
                    : {
                        ...item,
                        ...action.patch,
                        reviewed: action.review === false ? item.reviewed : true,
                      },
                ),
              },
        ),
      };
    case 'category':
      return {
        ...draft,
        categories: draft.categories.map((category) =>
          category.key === action.category ? { ...category, ...action.patch } : category,
        ),
      };
    case 'move': {
      const item = draft.categories
        .find((category) => category.key === action.category)
        ?.items.find((row) => row.key === action.key);
      if (!item || action.to === action.category) return draft;
      // Moving into a category that is on the menu but not in this draft adds
      // it to the draft first (spec §20A.4: existing plus extracted).
      if (action.newName !== undefined) {
        draft = {
          ...draft,
          categories: [
            ...draft.categories,
            { key: action.to, name: action.newName, skip: false, show_hidden: false, items: [] },
          ],
        };
      }
      return {
        ...draft,
        categories: draft.categories.map((category) =>
          category.key === action.category
            ? { ...category, items: category.items.filter((row) => row.key !== action.key) }
            : category.key === action.to
              ? {
                  ...category,
                  items: [
                    ...category.items,
                    {
                      ...item,
                      existing_item_id: null,
                      action: item.action === 'update_price' ? 'import' : item.action,
                    },
                  ],
                }
              : category,
        ),
      };
    }
    case 'delete':
      return {
        ...draft,
        categories: draft.categories.map((category) =>
          category.key === action.category
            ? { ...category, items: category.items.filter((row) => row.key !== action.key) }
            : category,
        ),
      };
    case 'merge': {
      const from = draft.categories.find((category) => category.key === action.category);
      if (!from || action.into === action.category) return draft;
      return {
        ...draft,
        categories: draft.categories
          .filter((category) => category.key !== action.category)
          .map((category) =>
            category.key === action.into
              ? { ...category, items: [...category.items, ...from.items] }
              : category,
          ),
      };
    }
  }
}

const FOOD_CHOICES = [
  { value: 'veg', label: 'Veg' },
  { value: 'non_veg', label: 'Non-veg' },
  { value: 'egg', label: 'Egg' },
] as const;

const SELECT_CLASS =
  'h-8 rounded-lg border border-input bg-surface px-2 text-sm text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

type ReviewScreenProps = {
  importId: string;
  source: 'photo' | 'csv';
  initialDraft: Draft;
  /** The menu as it is now: for suggestions, hidden categories and matches. */
  menu: MenuIndex;
  /** Page photo links by page number (photo imports). */
  pageUrls: Record<number, string>;
  failedPages: Array<{ index: number; error: string }>;
  /** Where to go after discarding. */
  startHref: string;
};

export function ReviewScreen({
  importId,
  source,
  initialDraft,
  menu,
  pageUrls,
  failedPages,
  startHref,
}: ReviewScreenProps) {
  const router = useRouter();
  const ids = useId();
  const [draft, dispatch] = useReducer(reviewReducer, initialDraft);
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [foodTypesChecked, setFoodTypesChecked] = useState(false);
  const [viewingPage, setViewingPage] = useState<number | null>(null);

  const duplicates = useMemo(() => duplicateNames(draft), [draft]);

  // "Already in menu" is worked out again on every edit: renaming a row or
  // moving it to another category changes what it matches (spec §20A.4).
  const byCategory = useMemo(() => {
    const index = new Map<string, Map<string, { id: string; hasVariants: boolean }>>();
    for (const category of menu) {
      index.set(
        normalizeCategoryName(category.name),
        new Map(
          category.items.map((item) => [
            normalizeCategoryName(item.name),
            { id: item.id, hasVariants: item.hasVariants },
          ]),
        ),
      );
    }
    return index;
  }, [menu]);
  const matches = useMemo(() => {
    const found = new Map<string, { id: string; hasVariants: boolean }>();
    for (const category of draft.categories) {
      const dishes = byCategory.get(normalizeCategoryName(category.name));
      if (!dishes) continue;
      for (const item of category.items) {
        const match = dishes.get(normalizeCategoryName(item.name));
        if (match) found.set(item.key, match);
      }
    }
    return found;
  }, [draft, byCategory]);

  const counts = useMemo(() => draftCounts(draft, new Set(matches.keys())), [draft, matches]);
  const flagsByKey = useMemo(() => {
    const flags = new Map<string, ItemFlag[]>();
    for (const category of draft.categories) {
      for (const item of category.items) {
        flags.set(
          item.key,
          isIncluded(category, item) ? itemFlags(item, duplicates, matches.has(item.key)) : [],
        );
      }
    }
    return flags;
  }, [draft, duplicates, matches]);

  // "Needs a check" is on by default. Rows stay listed while they are being
  // fixed; the list is taken again when the filter is switched on.
  const [onlyFlagged, setOnlyFlagged] = useState(counts.needsCheck > 0);
  const [flaggedWhenFiltered, setFlaggedWhenFiltered] = useState(
    () => new Set([...flagsByKey].filter(([, flags]) => flags.length > 0).map(([key]) => key)),
  );
  function toggleFilter(next: boolean) {
    setOnlyFlagged(next);
    if (next) {
      setFlaggedWhenFiltered(
        new Set([...flagsByKey].filter(([, flags]) => flags.length > 0).map(([key]) => key)),
      );
    }
  }

  const hidden = useMemo(
    () =>
      new Set(
        menu.filter((category) => !category.isActive).map((c) => normalizeCategoryName(c.name)),
      ),
    [menu],
  );
  // Where a row can be moved: the draft's categories plus the menu's own
  // (spec §20A.4). Picking one of the menu's adds it to the draft.
  const categoryOptions = useMemo((): CategoryOption[] => {
    const inDraft = new Set(draft.categories.map((c) => normalizeCategoryName(c.name)));
    return [
      ...draft.categories.map((category) => ({
        key: category.key,
        name: category.name,
        isNew: false,
      })),
      ...menu
        .filter((category) => !inDraft.has(normalizeCategoryName(category.name)))
        .map((category, index) => ({
          key: `menu-${index}-${normalizeCategoryName(category.name)}`,
          name: category.name,
          isNew: true,
        })),
    ];
  }, [draft.categories, menu]);

  const blockingRows = useMemo(() => {
    const rows: string[] = [];
    for (const category of draft.categories) {
      for (const item of category.items) {
        const flags = flagsByKey.get(item.key) ?? [];
        if (flags.some((flag) => ITEM_FLAGS[flag].hard && flag !== 'food_type_unknown')) {
          rows.push(item.name || 'A dish without a name');
        }
      }
    }
    return rows;
  }, [draft.categories, flagsByKey]);
  const badCategory = draft.categories.some(
    (category) =>
      !category.skip &&
      category.items.some((item) => item.action === 'import') &&
      (category.name.trim() === '' || category.name.trim().length > 60),
  );
  const canImport =
    counts.items > 0 && blockingRows.length === 0 && !badCategory && counts.items <= 500;

  // What the server is sent: the rows carry the match they have right now, so
  // a renamed or moved row never updates the price of a dish it no longer matches.
  const payload = useMemo(
    (): Draft => ({
      ...draft,
      categories: draft.categories.map((category) => ({
        ...category,
        items: category.items.map((item) => {
          const match = matches.get(item.key) ?? null;
          const canUpdate = match !== null && match.hasVariants === item.variants.length > 0;
          return {
            ...item,
            existing_item_id: match?.id ?? null,
            action: item.action === 'update_price' && !canUpdate ? 'import' : item.action,
          };
        }),
      })),
    }),
    [draft, matches],
  );

  function save() {
    startTransition(async () => {
      const result = await saveImportDraft(importId, payload);
      if (result.ok) toast.success('Draft saved. Open it again from Import menu to finish.');
      else toast.error(result.error);
    });
  }

  function commit() {
    startTransition(async () => {
      const result = await commitMenuImport(importId, payload, foodTypesChecked);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setConfirming(false);
      router.refresh();
    });
  }

  function discard() {
    startTransition(async () => {
      const result = await discardMenuImport(importId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.push(startHref);
    });
  }

  const importLabel = [
    counts.newItems > 0 &&
      `Import ${counts.newItems} ${counts.newItems === 1 ? 'dish' : 'dishes'} into ${counts.categories} ${counts.categories === 1 ? 'category' : 'categories'}`,
    counts.priceUpdates > 0 &&
      `${counts.newItems > 0 ? 'update' : 'Update'} ${counts.priceUpdates} ${counts.priceUpdates === 1 ? 'price' : 'prices'}`,
  ]
    .filter(Boolean)
    .join(' and ');

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label="Summary"
        className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
      >
        <p className="flex items-start gap-2 text-sm font-medium text-ink">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-status-preparing" />
          {source === 'photo'
            ? 'Check this before importing. Prices read from photos are often wrong.'
            : 'Check this before importing.'}
        </p>
        <p className="text-sm text-ink-muted" data-testid="review-counts">
          {draft.categories.length} {draft.categories.length === 1 ? 'category' : 'categories'}{' '}
          found, {draft.categories.reduce((sum, c) => sum + c.items.length, 0)} dishes found,{' '}
          {counts.needsCheck} {counts.needsCheck === 1 ? 'needs' : 'need'} a check.
        </p>
        {failedPages.map((page) => (
          <p key={page.index} role="alert" className="text-sm text-destructive">
            Page {page.index} could not be read: {page.error}
          </p>
        ))}
        {draft.page_notes.map((note) => (
          <p key={note.page} className="text-sm text-ink-muted">
            Page {note.page}: {note.notes}
          </p>
        ))}
        <label className="flex items-center gap-2 self-start text-sm text-ink">
          <Checkbox
            checked={onlyFlagged}
            onCheckedChange={(checked) => toggleFilter(checked === true)}
          />
          Needs a check ({counts.needsCheck})
        </label>
      </section>

      <datalist id={`${ids}-categories`}>
        {[...new Set([...menu.map((c) => c.name), ...draft.categories.map((c) => c.name)])].map(
          (name) => (
            <option key={name} value={name} />
          ),
        )}
      </datalist>

      {draft.categories.map((category) => {
        const rows = category.items.filter(
          (item) =>
            !onlyFlagged ||
            (flagsByKey.get(item.key)?.length ?? 0) > 0 ||
            flaggedWhenFiltered.has(item.key),
        );
        if (onlyFlagged && rows.length === 0) return null;
        return (
          <CategorySection
            key={category.key}
            category={category}
            rows={rows}
            flagsByKey={flagsByKey}
            matches={matches}
            isHidden={hidden.has(normalizeCategoryName(category.name))}
            categoryOptions={categoryOptions}
            datalistId={`${ids}-categories`}
            pageUrls={pageUrls}
            onViewPage={setViewingPage}
            dispatch={dispatch}
          />
        );
      })}
      {onlyFlagged && counts.needsCheck === 0 && (
        <p className="rounded-lg border border-line bg-surface p-4 text-sm text-ink-muted">
          Nothing left to check. Turn off “Needs a check” to see every row.
        </p>
      )}

      <div className="sticky bottom-0 z-20 rounded-lg border border-line bg-surface/95 px-4 py-3 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={!canImport || pending}
            onClick={() => {
              setFoodTypesChecked(false);
              setConfirming(true);
            }}
          >
            {importLabel || 'Nothing to import'}
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={save}>
            Save draft and finish later
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => setDiscarding(true)}
          >
            Discard import
          </Button>
          {!canImport && counts.items > 0 && (
            <p className="text-sm text-destructive" role="status">
              {blockingRows.length > 0
                ? `Fix or skip ${blockingRows.length} ${blockingRows.length === 1 ? 'row' : 'rows'} first: ${blockingRows.slice(0, 3).join(', ')}${blockingRows.length > 3 ? '…' : ''}.`
                : badCategory
                  ? 'Give every category a name of up to 60 characters.'
                  : 'An import can add at most 500 dishes. Skip some rows.'}
            </p>
          )}
        </div>
      </div>

      <AlertDialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{importLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              New dishes go on the menu straight away, ready to order. New categories go after the
              ones you have.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {counts.unknownFoodType > 0 && (
            <label className="flex items-start gap-3 rounded-lg border border-line p-3 text-sm text-ink">
              <Checkbox
                checked={foodTypesChecked}
                onCheckedChange={(checked) => setFoodTypesChecked(checked === true)}
                className="mt-0.5"
              />
              <span>
                I checked the veg and non-veg marks.{' '}
                {counts.unknownFoodType === 1
                  ? '1 dish without a mark is imported as veg.'
                  : `${counts.unknownFoodType} dishes without a mark are imported as veg.`}
              </span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Back to the list</AlertDialogCancel>
            <AlertDialogAction
              onClick={commit}
              disabled={pending || (counts.unknownFoodType > 0 && !foodTypesChecked)}
            >
              {pending ? 'Importing…' : 'Import'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={discarding} onOpenChange={(open) => !open && setDiscarding(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this import?</AlertDialogTitle>
            <AlertDialogDescription>
              Nothing from it has reached the menu, and nothing will. The draft stays listed under
              Recent imports, and its photos are deleted within a week.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={discard} disabled={pending}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={viewingPage !== null} onOpenChange={(open) => !open && setViewingPage(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Page {viewingPage}</DialogTitle>
          </DialogHeader>
          {viewingPage !== null && pageUrls[viewingPage] && (
            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link
            <img
              src={pageUrls[viewingPage]}
              alt={`Menu page ${viewingPage}`}
              className="max-h-[75vh] w-full rounded-md object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

type MenuMatch = { id: string; hasVariants: boolean };

/** A category a row can move into: one of the draft's, or one from the menu. */
type CategoryOption = { key: string; name: string; isNew: boolean };

type CategorySectionProps = {
  category: DraftCategory;
  rows: DraftItem[];
  flagsByKey: Map<string, ItemFlag[]>;
  matches: Map<string, MenuMatch>;
  isHidden: boolean;
  categoryOptions: CategoryOption[];
  datalistId: string;
  pageUrls: Record<number, string>;
  onViewPage: (page: number) => void;
  dispatch: Dispatch<ReviewAction>;
};

function CategorySection({
  category,
  rows,
  flagsByKey,
  matches,
  isHidden,
  categoryOptions,
  datalistId,
  pageUrls,
  onViewPage,
  dispatch,
}: CategorySectionProps) {
  const headingId = useId();
  const others = categoryOptions.filter((option) => option.key !== category.key);
  // Merging moves every row at once, so only the draft's own categories.
  const mergeInto = others.filter((option) => !option.isNew);
  const name = category.name.trim();

  // Rows grouped by the page they came from, so the photo sits beside them.
  const groups: Array<{ page: number | null; items: DraftItem[] }> = [];
  for (const item of rows) {
    const last = groups.at(-1);
    if (last && last.page === item.page) last.items.push(item);
    else groups.push({ page: item.page, items: [item] });
  }

  return (
    <section
      aria-labelledby={headingId}
      data-category={category.name}
      className={cn(
        'flex flex-col gap-3 rounded-lg border border-line bg-surface p-4',
        category.skip && 'opacity-60',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="sr-only">
          {category.name || 'Unnamed category'}
        </h2>
        <Input
          aria-label="Category name"
          value={category.name}
          list={datalistId}
          maxLength={80}
          aria-invalid={name === '' || name.length > 60 ? true : undefined}
          className="h-9 max-w-xs text-base font-semibold"
          onChange={(event) =>
            dispatch({
              type: 'category',
              category: category.key,
              patch: { name: event.target.value },
            })
          }
        />
        <span className="text-sm text-ink-muted">
          {category.items.length} {category.items.length === 1 ? 'dish' : 'dishes'}
        </span>
        <label className="flex items-center gap-2 text-sm text-ink">
          <Checkbox
            checked={category.skip}
            onCheckedChange={(checked) =>
              dispatch({
                type: 'category',
                category: category.key,
                patch: { skip: checked === true },
              })
            }
          />
          Skip this category
        </label>
        {mergeInto.length > 0 && (
          <select
            aria-label={`Merge ${category.name || 'category'} into`}
            className={SELECT_CLASS}
            value=""
            onChange={(event) =>
              event.target.value &&
              dispatch({ type: 'merge', category: category.key, into: event.target.value })
            }
          >
            <option value="">Merge into…</option>
            {mergeInto.map((option) => (
              <option key={option.key} value={option.key}>
                {option.name || 'Unnamed category'}
              </option>
            ))}
          </select>
        )}
      </div>

      {isHidden && !category.skip && (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted px-3 py-2 text-sm text-ink">
          <span>
            {category.name} is hidden on the menu, so these dishes won’t show until it is shown
            again.
          </span>
          <label className="flex items-center gap-2 font-medium">
            <Checkbox
              checked={category.show_hidden}
              onCheckedChange={(checked) =>
                dispatch({
                  type: 'category',
                  category: category.key,
                  patch: { show_hidden: checked === true },
                })
              }
            />
            Show it again
          </label>
        </div>
      )}

      {!category.skip &&
        groups.map((group, index) => (
          <div
            key={`${group.page}-${index}`}
            className="flex flex-col gap-2 sm:flex-row sm:items-start"
          >
            {group.page !== null && (
              <button
                type="button"
                className="flex shrink-0 items-center gap-2 self-start rounded-md border border-line p-1 text-xs text-ink-muted hover:bg-muted sm:flex-col"
                onClick={() => onViewPage(group.page!)}
                aria-label={`Show page ${group.page}`}
              >
                {pageUrls[group.page] ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link
                  <img
                    src={pageUrls[group.page]}
                    alt=""
                    className="h-20 w-14 rounded object-cover sm:h-28 sm:w-20"
                  />
                ) : (
                  <ImageIcon aria-hidden className="size-6" />
                )}
                Page {group.page}
              </button>
            )}
            <ul className="flex min-w-0 flex-1 flex-col divide-y divide-line">
              {group.items.map((item) => (
                <ItemRow
                  key={item.key}
                  categoryKey={category.key}
                  item={item}
                  flags={flagsByKey.get(item.key) ?? []}
                  match={matches.get(item.key) ?? null}
                  others={others}
                  dispatch={dispatch}
                />
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}

type ItemRowProps = {
  categoryKey: string;
  item: DraftItem;
  flags: ItemFlag[];
  /** The dish with this name in this category on the menu, if there is one. */
  match: MenuMatch | null;
  others: CategoryOption[];
  dispatch: Dispatch<ReviewAction>;
};

const ItemRow = memo(function ItemRow({
  categoryKey,
  item,
  flags,
  match,
  others,
  dispatch,
}: ItemRowProps) {
  const label = item.name || 'dish';
  const update = (patch: Partial<DraftItem>) =>
    dispatch({ type: 'item', category: categoryKey, key: item.key, patch });
  const soft = flags.filter((flag) => !ITEM_FLAGS[flag].hard);
  const skipped = item.action === 'skip';

  return (
    <li
      data-row={item.name}
      data-flagged={flags.length > 0 || undefined}
      className={cn('flex flex-col gap-2 py-3 first:pt-0 last:pb-0', skipped && 'opacity-60')}
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <Input
            aria-label={`Name of ${label}`}
            value={item.name}
            maxLength={120}
            aria-invalid={flags.includes('name_invalid') || undefined}
            className="h-8"
            onChange={(event) => update({ name: event.target.value })}
          />
          <Input
            aria-label={`Description of ${label}`}
            placeholder="Description (optional)"
            value={item.description ?? ''}
            maxLength={300}
            className="h-7 text-xs"
            onChange={(event) => update({ description: event.target.value || null })}
          />
        </div>

        <div
          role="group"
          aria-label={`Food type of ${label}`}
          className={cn(
            'flex items-center gap-1 rounded-lg p-0.5',
            item.food_type === 'unknown' && 'ring-2 ring-status-preparing',
          )}
        >
          {FOOD_CHOICES.map((choice) => (
            <Button
              key={choice.value}
              type="button"
              size="sm"
              variant={item.food_type === choice.value ? 'secondary' : 'ghost'}
              aria-pressed={item.food_type === choice.value}
              onClick={() => update({ food_type: choice.value })}
            >
              <span aria-hidden className="contents">
                <FoodTypeMark type={choice.value} size="sm" />
              </span>
              {choice.label}
            </Button>
          ))}
        </div>

        <PriceEditor item={item} label={label} update={update} />

        <div className="flex flex-wrap items-center gap-1">
          {match && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-ink">
              Already in menu
            </span>
          )}
          <select
            aria-label={`What to do with ${label}`}
            className={SELECT_CLASS}
            value={item.action}
            onChange={(event) => update({ action: event.target.value as ItemAction })}
          >
            <option value="import">{match ? 'Add as a new dish' : 'Import'}</option>
            {/* Only when the row and the dish have the same shape: the
                database refuses a price update that changes the options. */}
            {match && match.hasVariants === item.variants.length > 0 && (
              <option value="update_price">Update price instead</option>
            )}
            <option value="skip">Skip</option>
          </select>
          {others.length > 0 && (
            <select
              aria-label={`Move ${label} to`}
              className={SELECT_CLASS}
              value=""
              onChange={(event) => {
                const option = others.find((other) => other.key === event.target.value);
                if (!option) return;
                dispatch({
                  type: 'move',
                  category: categoryKey,
                  key: item.key,
                  to: option.key,
                  ...(option.isNew ? { newName: option.name } : {}),
                });
              }}
            >
              <option value="">Move to…</option>
              {others.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.name || 'Unnamed category'}
                </option>
              ))}
            </select>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${label}`}
            onClick={() => dispatch({ type: 'delete', category: categoryKey, key: item.key })}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      </div>

      {(flags.length > 0 || item.notes) && !skipped && (
        <div className="flex flex-wrap items-center gap-1.5">
          {flags.map((flag) => (
            <span
              key={flag}
              data-flag={flag}
              className={cn(
                'rounded-full px-2 py-0.5 text-xs font-medium',
                ITEM_FLAGS[flag].hard
                  ? 'bg-status-void/10 text-status-void'
                  : 'bg-status-preparing/15 text-ink',
              )}
            >
              {ITEM_FLAGS[flag].label}
            </span>
          ))}
          {item.notes && <span className="text-xs text-ink-muted">Note: {item.notes}</span>}
          {soft.length > 0 && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => update({})}
              aria-label={`${label} looks right`}
            >
              <Check aria-hidden />
              Looks right
            </Button>
          )}
        </div>
      )}
    </li>
  );
});

function PriceEditor({
  item,
  label,
  update,
}: {
  item: DraftItem;
  label: string;
  update: (patch: Partial<DraftItem>) => void;
}) {
  if (item.variants.length === 0) {
    return (
      <div className="flex items-center gap-1">
        <PriceInput
          label={`Price of ${label}`}
          paise={item.price_paise}
          onChange={(price_paise) => update({ price_paise })}
        />
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() =>
            update({
              variants: [
                { name: 'Half', price_paise: item.price_paise },
                { name: 'Full', price_paise: null },
              ],
              price_paise: null,
            })
          }
        >
          <Plus aria-hidden />
          Options
        </Button>
      </div>
    );
  }

  const setVariant = (index: number, patch: Partial<DraftItem['variants'][number]>) =>
    update({
      variants: item.variants.map((variant, i) =>
        i === index ? { ...variant, ...patch } : variant,
      ),
    });

  return (
    <div role="group" aria-label={`Options of ${label}`} className="flex flex-col gap-1">
      {item.variants.map((variant, index) => (
        <div key={index} className="flex items-center gap-1">
          <Input
            aria-label={`Option ${index + 1} of ${label}`}
            value={variant.name}
            maxLength={40}
            className="h-8 w-24"
            onChange={(event) => setVariant(index, { name: event.target.value })}
          />
          <PriceInput
            label={`Price of ${label}, ${variant.name || `option ${index + 1}`}`}
            paise={variant.price_paise}
            onChange={(price_paise) => setVariant(index, { price_paise })}
          />
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove option ${variant.name || index + 1} of ${label}`}
            onClick={() => {
              const variants = item.variants.filter((_, i) => i !== index);
              update(
                variants.length === 0
                  ? { variants, price_paise: variant.price_paise }
                  : { variants },
              );
            }}
          >
            <X aria-hidden />
          </Button>
        </div>
      ))}
      {item.variants.length < MAX_VARIANTS && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="self-start"
          onClick={() => update({ variants: [...item.variants, { name: '', price_paise: null }] })}
        >
          <Plus aria-hidden />
          Add option
        </Button>
      )}
    </div>
  );
}

/** Rupees as typed; the draft keeps paise, or null while the text isn't a price. */
function PriceInput({
  label,
  paise,
  onChange,
}: {
  label: string;
  paise: number | null;
  onChange: (paise: number | null) => void;
}) {
  const [text, setText] = useState(paise === null ? '' : formatPriceInput(paise));
  const [lastPaise, setLastPaise] = useState(paise);
  // Follow a price changed elsewhere (e.g. options turned into a single price).
  if (paise !== lastPaise) {
    setLastPaise(paise);
    if (paise !== parsePriceInput(text)) setText(paise === null ? '' : formatPriceInput(paise));
  }
  const invalid = text.trim() !== '' && parsePriceInput(text) === null;

  return (
    <div className="flex items-center">
      <span aria-hidden className="pr-1 text-sm text-ink-muted">
        ₹
      </span>
      <Input
        aria-label={label}
        inputMode="decimal"
        value={text}
        aria-invalid={invalid || paise === null || undefined}
        className="h-8 w-24 tabular-nums"
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          const parsed = value.trim() === '' ? null : parsePriceInput(value);
          setLastPaise(parsed);
          onChange(parsed);
        }}
      />
    </div>
  );
}
