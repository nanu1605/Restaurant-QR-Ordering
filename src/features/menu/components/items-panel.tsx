'use client';

import { cn } from 'cn';
import { Eye, EyeOff, ImageIcon, Pencil, Plus, Search, UtensilsCrossed } from 'lucide-react';
import Image from 'next/image';
import { useOptimistic, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/shared/empty-state';
import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { DragHandle, SortableItem, SortableList } from '@/components/shared/sortable-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { formatINR } from '@/lib/money';

import { reorderItems, setItemAvailability, updateMenuItem } from '../actions';
import { publicImageUrl } from '../images';
import type { AdminCategory, AdminMenuItem } from '../queries';
import { formatPriceInput, parsePriceInput } from '../schemas';

type ItemsPanelProps = {
  category: AdminCategory | null;
  items: AdminMenuItem[];
  categoryNames: Record<string, string>;
  supabaseUrl: string;
  readOnly: boolean;
  onAdd: () => void;
  onEdit: (item: AdminMenuItem) => void;
};

export function ItemsPanel({
  category,
  items,
  categoryNames,
  supabaseUrl,
  readOnly,
  onAdd,
  onEdit,
}: ItemsPanelProps) {
  const [query, setQuery] = useState('');
  const search = query.trim().toLowerCase();

  const inCategory = category ? items.filter((item) => item.categoryId === category.id) : [];
  const active = inCategory.filter((item) => item.isActive);
  const hidden = inCategory.filter((item) => !item.isActive);
  const [ordered, setOrdered] = useOptimistic(active);
  const [, startTransition] = useTransition();

  function reorder(next: AdminMenuItem[]) {
    if (!category) return;
    startTransition(async () => {
      setOrdered(next);
      const result = await reorderItems(
        category.id,
        next.map((item) => item.id),
      );
      if (!result.ok) toast.error(result.error);
    });
  }

  const rowProps = { supabaseUrl, readOnly, onEdit };

  return (
    <section
      aria-labelledby="items-heading"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="items-heading" className="mr-auto px-1 text-base font-semibold text-ink">
          {search ? 'Search results' : (category?.name ?? 'Dishes')}
          {!search && category && !category.isActive && (
            <span className="ml-2 text-sm font-normal text-ink-muted">(hidden category)</span>
          )}
        </h2>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-muted"
          />
          <Input
            type="search"
            aria-label="Search dishes"
            placeholder="Search all dishes"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 w-56 pl-8"
          />
        </div>
        <Button size="lg" onClick={onAdd} disabled={readOnly || !category}>
          <Plus aria-hidden /> Add dish
        </Button>
      </div>

      {search ? (
        <SearchResults
          items={items.filter((item) => item.name.toLowerCase().includes(search))}
          categoryNames={categoryNames}
          {...rowProps}
        />
      ) : !category ? (
        <EmptyState
          icon={UtensilsCrossed}
          title="Add a category first"
          description="Dishes live in categories. Add one on the left, e.g. Starters."
        />
      ) : inCategory.length === 0 ? (
        <EmptyState
          icon={UtensilsCrossed}
          title={`No dishes in ${category.name} yet`}
          description="Add a dish with its price, food type and photo."
          action={
            <Button onClick={onAdd} disabled={readOnly}>
              <Plus aria-hidden /> Add dish
            </Button>
          }
        />
      ) : (
        <>
          <SortableList
            items={ordered}
            onReorder={reorder}
            getLabel={(item) => item.name}
            disabled={readOnly}
          >
            {(item) => (
              <SortableItem key={item.id} id={item.id} disabled={readOnly}>
                {(handle) => (
                  <ItemRow
                    item={item}
                    handle={
                      <DragHandle label={`Move ${item.name}`} handle={handle} disabled={readOnly} />
                    }
                    {...rowProps}
                  />
                )}
              </SortableItem>
            )}
          </SortableList>
          {hidden.length > 0 && (
            <details className="rounded-md border border-dashed border-line px-2 py-1.5">
              <summary className="cursor-pointer px-1 py-1 text-sm font-medium text-ink-muted">
                Hidden dishes ({hidden.length})
              </summary>
              <ul className="mt-1 flex flex-col gap-1">
                {hidden.map((item) => (
                  <li key={item.id}>
                    <ItemRow item={item} {...rowProps} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function SearchResults({
  items,
  categoryNames,
  ...rowProps
}: {
  items: AdminMenuItem[];
  categoryNames: Record<string, string>;
  supabaseUrl: string;
  readOnly: boolean;
  onEdit: (item: AdminMenuItem) => void;
}) {
  if (items.length === 0) {
    return <p className="px-1 py-6 text-center text-sm text-ink-muted">No dishes match.</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item.id}>
          <ItemRow item={item} categoryName={categoryNames[item.categoryId]} {...rowProps} />
        </li>
      ))}
    </ul>
  );
}

function ItemRow({
  item,
  categoryName,
  handle,
  supabaseUrl,
  readOnly,
  onEdit,
}: {
  item: AdminMenuItem;
  categoryName?: string;
  handle?: React.ReactNode;
  supabaseUrl: string;
  readOnly: boolean;
  onEdit: (item: AdminMenuItem) => void;
}) {
  const [available, setAvailable] = useOptimistic(item.isAvailable);
  const [pending, startTransition] = useTransition();

  function toggleAvailable(next: boolean) {
    startTransition(async () => {
      setAvailable(next);
      const result = await setItemAvailability(item.id, next);
      if (!result.ok) toast.error(result.error);
    });
  }

  function setVisible(isActive: boolean) {
    startTransition(async () => {
      const result = await updateMenuItem(item.id, { isActive });
      if (!result.ok) toast.error(result.error);
      else
        toast.success(isActive ? `“${item.name}” is back on the menu` : `“${item.name}” is hidden`);
    });
  }

  return (
    // On narrow screens the price and controls wrap under the dish name.
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line bg-surface p-2',
        !item.isActive && 'bg-paper',
      )}
      aria-busy={pending || undefined}
    >
      {handle ?? <span aria-hidden className="w-7 shrink-0" />}
      <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
        {item.imagePath ? (
          <Image
            src={publicImageUrl(supabaseUrl, 'menu-images', item.imagePath, item.updatedAt)}
            alt=""
            width={48}
            height={48}
            unoptimized
            className="size-12 object-cover"
          />
        ) : (
          <ImageIcon aria-hidden className="size-5 text-ink-muted" />
        )}
      </div>

      <div className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <FoodTypeMark type={item.foodType} size="sm" />
          <span className="truncate text-sm font-medium text-ink">{item.name}</span>
        </div>
        <p className="truncate text-xs text-ink-muted">
          {categoryName ? `${categoryName} · ` : ''}
          {item.variants.length > 0
            ? `${item.variants.length} options: ${item.variants.map((variant) => variant.name).join(', ')}`
            : (item.description ?? '')}
        </p>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div className="w-28 shrink-0 text-right">
          {item.variants.length > 0 ? (
            <span className="text-sm text-ink tabular-nums">
              from {formatINR(item.pricePaise, { fraction: 'auto' })}
            </span>
          ) : (
            <QuickPrice item={item} disabled={readOnly} />
          )}
        </div>

        {item.isActive && (
          <div className="flex shrink-0 items-center gap-2 text-xs text-ink-muted">
            <Switch
              checked={available}
              onCheckedChange={toggleAvailable}
              aria-label={`${item.name} in stock`}
            />
            {/* The switch state already tells screen readers; this is for sighted users. */}
            <span aria-hidden className="hidden w-16 sm:inline">
              {available ? 'In stock' : 'Sold out'}
            </span>
          </div>
        )}

        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onEdit(item)}
            disabled={readOnly}
            aria-label={`Edit ${item.name}`}
          >
            <Pencil aria-hidden />
          </Button>
          {item.isActive ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setVisible(false)}
              disabled={readOnly || pending}
              aria-label={`Hide ${item.name}`}
            >
              <EyeOff aria-hidden />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setVisible(true)}
              disabled={readOnly || pending}
              aria-label={`Show ${item.name} again`}
            >
              <Eye aria-hidden /> Show again
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function QuickPrice({ item, disabled }: { item: AdminMenuItem; disabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const price = formatINR(item.pricePaise, { fraction: 'auto' });

  function save(text: string) {
    const paise = parsePriceInput(text);
    if (paise === null) {
      toast.error('Enter a price in rupees, e.g. 280 or 280.50.');
      return;
    }
    if (paise === item.pricePaise) {
      setEditing(false);
      return;
    }
    startTransition(async () => {
      const result = await updateMenuItem(item.id, { pricePaise: paise });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setEditing(false);
      toast.success(`${item.name}: ${formatINR(paise, { fraction: 'auto' })}`);
    });
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        disabled={disabled}
        aria-label={`Change price of ${item.name} (now ${price})`}
        className="rounded-md px-2 py-1 text-sm text-ink tabular-nums hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:hover:bg-transparent"
      >
        {price}
      </button>
    );
  }

  return (
    <Input
      aria-label={`Price of ${item.name} in rupees`}
      defaultValue={formatPriceInput(item.pricePaise)}
      inputMode="decimal"
      autoFocus
      disabled={pending}
      className="ml-auto h-8 w-24 text-right tabular-nums"
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          save(event.currentTarget.value);
        } else if (event.key === 'Escape') {
          setEditing(false);
        }
      }}
      onBlur={(event) => save(event.currentTarget.value)}
    />
  );
}
