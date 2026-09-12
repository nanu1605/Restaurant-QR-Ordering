'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { addSuggestedCategories, deleteCategory, updateCategory } from '../actions';
import {
  CUISINE_LABELS,
  CUISINE_SETS,
  DEFAULT_CUISINE,
  missingCategories,
  type CuisineSet,
} from '../default-categories';
import type { AdminCategory } from '../queries';

/**
 * Deleting a category (spec §8.4): an empty one goes straight away; one with
 * dishes needs a category to move them to, or can be hidden instead.
 */
export function DeleteCategoryDialog({
  category,
  itemCount,
  categories,
  onClose,
  onDeleted,
}: {
  category: AdminCategory | null;
  itemCount: number;
  categories: AdminCategory[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const targets = categories.filter((other) => other.id !== category?.id);

  function close() {
    setMoveTo(null);
    onClose();
  }

  function remove() {
    if (!category) return;
    startTransition(async () => {
      const result = await deleteCategory(category.id, itemCount > 0 ? moveTo : null);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(
        result.data.moved > 0
          ? `Deleted “${category.name}” and moved ${result.data.moved} ${result.data.moved === 1 ? 'dish' : 'dishes'}`
          : `Deleted “${category.name}”`,
      );
      onDeleted();
      close();
    });
  }

  function hideInstead() {
    if (!category) return;
    startTransition(async () => {
      const result = await updateCategory(category.id, { isActive: false });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`“${category.name}” is hidden`);
      close();
    });
  }

  return (
    <Dialog open={category !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{category?.name}”?</DialogTitle>
          <DialogDescription>
            {itemCount === 0
              ? 'This category has no dishes. Deleting it cannot be undone.'
              : `This category has ${itemCount} ${itemCount === 1 ? 'dish' : 'dishes'}. Move them to another category first, or hide the category instead so nothing is lost.`}
          </DialogDescription>
        </DialogHeader>

        {itemCount > 0 && (
          <Field>
            <FieldLabel htmlFor="move-dishes-to">Move dishes to</FieldLabel>
            <Select
              items={targets.map((target) => ({ value: target.id, label: target.name }))}
              value={moveTo}
              onValueChange={(value) => setMoveTo(value)}
            >
              <SelectTrigger id="move-dishes-to" className="h-9 w-full">
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((target) => (
                  <SelectItem key={target.id} value={target.id}>
                    {target.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          {itemCount > 0 && category?.isActive && (
            <Button variant="secondary" onClick={hideInstead} disabled={pending}>
              Hide instead
            </Button>
          )}
          <Button
            variant="destructive"
            onClick={remove}
            disabled={pending || (itemCount > 0 && !moveTo)}
          >
            {itemCount > 0 ? 'Move dishes and delete' : 'Delete category'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Add suggested categories" (spec §13.3): pull in another default set. */
export function SuggestedCategoriesDialog({
  open,
  onOpenChange,
  existingNames,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingNames: string[];
}) {
  const [set, setSet] = useState<CuisineSet>(DEFAULT_CUISINE);
  const [pending, startTransition] = useTransition();
  const sets = CUISINE_SETS.filter((value) => value !== 'blank');
  const toAdd = missingCategories(set, existingNames);

  function add() {
    startTransition(async () => {
      const result = await addSuggestedCategories(set);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `Added ${result.data.added} ${result.data.added === 1 ? 'category' : 'categories'}`,
      );
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add suggested categories</DialogTitle>
          <DialogDescription>
            Pick a set. Categories you already have are skipped, and you can rename or hide any of
            them later.
          </DialogDescription>
        </DialogHeader>

        <Field>
          <FieldLabel htmlFor="category-set">Set</FieldLabel>
          <Select
            items={sets.map((value) => ({ value, label: CUISINE_LABELS[value] }))}
            value={set}
            onValueChange={(value) => value && setSet(value as CuisineSet)}
          >
            <SelectTrigger id="category-set" className="h-9 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sets.map((value) => (
                <SelectItem key={value} value={value}>
                  {CUISINE_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {toAdd.length === 0 ? (
          <p className="text-sm text-ink-muted">All of these are already on your menu.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-ink">Will be added</p>
            <ul className="flex flex-wrap gap-1.5">
              {toAdd.map((name) => (
                <li key={name} className="rounded-md bg-muted px-2 py-1 text-xs text-ink">
                  {name}
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={add} disabled={pending || toAdd.length === 0}>
            {toAdd.length === 0
              ? 'Nothing to add'
              : `Add ${toAdd.length} ${toAdd.length === 1 ? 'category' : 'categories'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
