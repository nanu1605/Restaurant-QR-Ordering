'use client';

import { useState } from 'react';

import type { AdminCategory, AdminMenuItem } from '../queries';

import { DeleteCategoryDialog, SuggestedCategoriesDialog } from './category-dialogs';
import { CategoryPanel } from './category-panel';
import { ItemFormDialog } from './item-form-dialog';
import { ItemsPanel } from './items-panel';

type MenuEditorProps = {
  categories: AdminCategory[];
  items: AdminMenuItem[];
  supabaseUrl: string;
  /** Read-only restaurants can still switch dishes in and out of stock. */
  readOnly: boolean;
};

/** Menu page (spec §13.3): categories on the left, the selected category's dishes on the right. */
export function MenuEditor({ categories, items, supabaseUrl, readOnly }: MenuEditorProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ item: AdminMenuItem | null } | null>(null);
  const [deleting, setDeleting] = useState<AdminCategory | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  // The selection falls back to the first visible category (e.g. after a delete).
  const selected =
    categories.find((category) => category.id === selectedId) ??
    categories.find((category) => category.isActive) ??
    categories[0] ??
    null;

  const itemCounts: Record<string, number> = {};
  for (const item of items) itemCounts[item.categoryId] = (itemCounts[item.categoryId] ?? 0) + 1;
  const categoryNames = Object.fromEntries(
    categories.map((category) => [category.id, category.name]),
  );

  return (
    <>
      <div className="grid items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <CategoryPanel
          categories={categories}
          itemCounts={itemCounts}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
          onDelete={setDeleting}
          onSuggest={() => setSuggesting(true)}
          readOnly={readOnly}
        />
        <ItemsPanel
          category={selected}
          items={items}
          categoryNames={categoryNames}
          supabaseUrl={supabaseUrl}
          readOnly={readOnly}
          onAdd={() => setEditing({ item: null })}
          onEdit={(item) => setEditing({ item })}
        />
      </div>

      <ItemFormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        item={editing?.item ?? null}
        categoryId={selected?.id ?? null}
        categories={categories}
        supabaseUrl={supabaseUrl}
      />
      <DeleteCategoryDialog
        category={deleting}
        itemCount={deleting ? (itemCounts[deleting.id] ?? 0) : 0}
        categories={categories}
        onClose={() => setDeleting(null)}
        onDeleted={() => setSelectedId(null)}
      />
      <SuggestedCategoriesDialog
        open={suggesting}
        onOpenChange={setSuggesting}
        existingNames={categories.map((category) => category.name)}
      />
    </>
  );
}
