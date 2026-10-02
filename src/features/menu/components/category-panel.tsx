'use client';

import { cn } from 'cn';
import {
  Eye,
  EyeOff,
  Languages,
  MoreHorizontal,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useOptimistic, useState, useTransition, type FormEvent } from 'react';
import { toast } from 'sonner';

import { DragHandle, SortableItem, SortableList } from '@/components/shared/sortable-list';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';

import { createCategory, reorderCategories, updateCategory } from '../actions';
import type { AdminCategory } from '../queries';

type CategoryPanelProps = {
  categories: AdminCategory[];
  itemCounts: Record<string, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (category: AdminCategory) => void;
  onSuggest: () => void;
  readOnly: boolean;
};

export function CategoryPanel({
  categories,
  itemCounts,
  selectedId,
  onSelect,
  onDelete,
  onSuggest,
  readOnly,
}: CategoryPanelProps) {
  const active = categories.filter((category) => category.isActive);
  const hidden = categories.filter((category) => !category.isActive);
  const [ordered, setOrdered] = useOptimistic(active);
  const [, startTransition] = useTransition();

  function reorder(next: AdminCategory[]) {
    startTransition(async () => {
      setOrdered(next);
      const result = await reorderCategories(next.map((category) => category.id));
      if (!result.ok) toast.error(result.error);
    });
  }

  function setVisible(category: AdminCategory, isActive: boolean) {
    startTransition(async () => {
      const result = await updateCategory(category.id, { isActive });
      if (!result.ok) toast.error(result.error);
      else
        toast.success(
          isActive ? `“${category.name}” is shown again` : `“${category.name}” is hidden`,
        );
    });
  }

  return (
    <section
      aria-labelledby="categories-heading"
      className="flex flex-col gap-3 self-start rounded-lg border border-line bg-surface p-3"
    >
      <h2 id="categories-heading" className="px-1 text-base font-semibold text-ink">
        Categories
      </h2>

      <AddCategoryForm disabled={readOnly} onCreated={onSelect} />

      {ordered.length === 0 ? (
        <p className="px-1 text-sm text-ink-muted">
          No categories yet. Add one above, or add a suggested set.
        </p>
      ) : (
        <SortableList
          items={ordered}
          onReorder={reorder}
          getLabel={(category) => category.name}
          disabled={readOnly}
        >
          {(category) => (
            <SortableItem key={category.id} id={category.id} disabled={readOnly}>
              {(handle) => (
                <CategoryRow
                  category={category}
                  count={itemCounts[category.id] ?? 0}
                  selected={category.id === selectedId}
                  onSelect={() => onSelect(category.id)}
                  onHide={() => setVisible(category, false)}
                  onDelete={() => onDelete(category)}
                  readOnly={readOnly}
                  handle={
                    <DragHandle
                      label={`Move ${category.name}`}
                      handle={handle}
                      disabled={readOnly}
                    />
                  }
                />
              )}
            </SortableItem>
          )}
        </SortableList>
      )}

      {hidden.length > 0 && (
        <details className="group rounded-md border border-dashed border-line px-2 py-1.5">
          <summary className="cursor-pointer px-1 py-1 text-sm font-medium text-ink-muted">
            Hidden ({hidden.length})
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {hidden.map((category) => (
              <li key={category.id} className="flex items-center gap-1 rounded-md px-1 py-1">
                <button
                  type="button"
                  onClick={() => onSelect(category.id)}
                  aria-current={category.id === selectedId ? 'true' : undefined}
                  className={cn(
                    'min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-sm text-ink-muted hover:bg-muted',
                    category.id === selectedId && 'bg-accent text-brand',
                  )}
                >
                  {category.name}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setVisible(category, true)}
                  disabled={readOnly}
                  aria-label={`Show ${category.name}`}
                >
                  <Eye aria-hidden /> Show
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onDelete(category)}
                  disabled={readOnly}
                  aria-label={`Delete ${category.name}`}
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <Button variant="outline" onClick={onSuggest} disabled={readOnly}>
        <Sparkles aria-hidden /> Add suggested categories
      </Button>
    </section>
  );
}

function AddCategoryForm({
  disabled,
  onCreated,
}: {
  disabled: boolean;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    startTransition(async () => {
      const result = await createCategory(trimmed);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName('');
      setError(null);
      toast.success(`Added “${trimmed}”`);
      onCreated(result.data.id);
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Input
          aria-label="New category name"
          placeholder="Add a category, e.g. Jain Special"
          value={name}
          maxLength={60}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          aria-invalid={error ? true : undefined}
          disabled={disabled}
          className="h-9"
        />
        <Button type="submit" size="lg" disabled={disabled || pending || name.trim() === ''}>
          <Plus aria-hidden /> Add
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

function CategoryRow({
  category,
  count,
  selected,
  onSelect,
  onHide,
  onDelete,
  readOnly,
  handle,
}: {
  category: AdminCategory;
  count: number;
  selected: boolean;
  onSelect: () => void;
  onHide: () => void;
  onDelete: () => void;
  readOnly: boolean;
  handle: React.ReactNode;
}) {
  // The inline field edits either the name or the optional Hindi name.
  const [editing, setEditing] = useState<'name' | 'nameHi' | null>(null);
  const [pending, startTransition] = useTransition();

  function save(value: string) {
    const field = editing;
    const text = value.trim();
    const unchanged =
      field === 'name' ? text === '' || text === category.name : text === (category.nameHi ?? '');
    if (!field || unchanged) {
      setEditing(null);
      return;
    }
    startTransition(async () => {
      const result = await updateCategory(
        category.id,
        field === 'name' ? { name: text } : { nameHi: text },
      );
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setEditing(null);
      toast.success(
        field === 'name'
          ? `Renamed to “${text}”`
          : text
            ? `Hindi name set to “${text}”`
            : 'Hindi name removed',
      );
    });
  }

  return (
    <div
      className={cn('flex items-center gap-1 rounded-md bg-surface pr-1', selected && 'bg-accent')}
    >
      {handle}
      {editing ? (
        <Input
          aria-label={
            editing === 'name' ? `Rename ${category.name}` : `Hindi name for ${category.name}`
          }
          defaultValue={editing === 'name' ? category.name : (category.nameHi ?? '')}
          lang={editing === 'nameHi' ? 'hi' : undefined}
          maxLength={60}
          autoFocus
          disabled={pending}
          className="h-9 flex-1"
          onKeyDown={(event) => {
            // Enter also picks a word in Hindi keyboards (IMEs); only a plain Enter saves.
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              save(event.currentTarget.value);
            } else if (event.key === 'Escape') {
              setEditing(null);
            }
          }}
          onBlur={(event) => save(event.currentTarget.value)}
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? 'true' : undefined}
          className={cn(
            'flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm text-ink hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            selected && 'font-semibold text-brand hover:bg-accent',
          )}
        >
          <span className="truncate">
            {category.name}
            {category.nameHi && (
              <>
                {' '}
                <span lang="hi" className="font-normal text-ink-muted">
                  {category.nameHi}
                </span>
              </>
            )}
          </span>
          <span className="shrink-0 text-xs text-ink-muted tabular-nums">{count}</span>
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${category.name}`}
              disabled={readOnly}
            />
          }
        >
          <MoreHorizontal aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={() => setEditing('name')}>
            <Pencil aria-hidden /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setEditing('nameHi')}>
            <Languages aria-hidden /> Hindi name
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onHide}>
            <EyeOff aria-hidden /> Hide
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 aria-hidden /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
