'use client';

import { Plus, Tag as TagIcon, Trash2 } from 'lucide-react';
import { useId, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { createTag, deleteTag, setRestaurantTags } from '../actions';
import { TAG_COLOUR_LABELS, TAG_COLOURS, type Tag, type TagColour } from '../platform';

import { TAG_SWATCHES } from './tag-badge';

const MAX_TAGS = 10;

/**
 * Choose a restaurant's tags, add a new one, or delete one everywhere
 * (docs/SUPER_ADMIN_PLAN.md 13a, docs/DECISIONS.md SA-39).
 */
export function TagsEditor({
  restaurantId,
  restaurantName,
  tags,
  chosen,
}: {
  restaurantId: string;
  restaurantName: string;
  /** Every tag. */
  tags: Tag[];
  /** This restaurant's tag ids. */
  chosen: string[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" className="h-11 md:h-8" onClick={() => setOpen(true)}>
        <TagIcon aria-hidden />
        {chosen.length === 0 ? 'Add tags' : 'Edit tags'}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Tags for {restaurantName}</DialogTitle>
            <DialogDescription>
              Up to {MAX_TAGS}. Only the MenuMesh team sees tags; the Restaurants list filters by
              them.
            </DialogDescription>
          </DialogHeader>
          {open && (
            <TagsForm
              restaurantId={restaurantId}
              tags={tags}
              chosen={chosen}
              onDone={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function TagsForm({
  restaurantId,
  tags: initialTags,
  chosen: initialChosen,
  onDone,
}: {
  restaurantId: string;
  tags: Tag[];
  chosen: string[];
  onDone: () => void;
}) {
  const id = useId();
  const [tags, setTags] = useState(initialTags);
  const [chosen, setChosen] = useState(new Set(initialChosen));
  const [name, setName] = useState('');
  const [colour, setColour] = useState<TagColour>('orange');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(tagId: string, on: boolean) {
    const next = new Set(chosen);
    if (on) next.add(tagId);
    else next.delete(tagId);
    setChosen(next);
  }

  function add() {
    startTransition(async () => {
      setError(null);
      const result = await createTag(name, colour);
      if (!result.ok) {
        setError(result.fieldErrors?.name ?? result.error);
        return;
      }
      const tag = { id: result.data, name: name.trim(), colour };
      setTags([...tags, tag].sort((a, b) => a.name.localeCompare(b.name)));
      if (chosen.size < MAX_TAGS) toggle(tag.id, true);
      setName('');
    });
  }

  function remove(tag: Tag) {
    startTransition(async () => {
      const result = await deleteTag(tag.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`Deleted ${tag.name}`);
      setTags(tags.filter((other) => other.id !== tag.id));
      toggle(tag.id, false);
      setDeleting(null);
      document.getElementById(`${id}-name`)?.focus();
    });
  }

  // Back to the tag's delete button once the question is answered Keep.
  function keep(tagId: string) {
    setDeleting(null);
    requestAnimationFrame(() => document.getElementById(`${id}-delete-${tagId}`)?.focus());
  }

  function save() {
    startTransition(async () => {
      const result = await setRestaurantTags(restaurantId, [...chosen]);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success('Tags saved');
      onDone();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {tags.length === 0 ? (
        <p className="text-sm text-ink-muted">No tags yet. Add the first one below.</p>
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium text-ink">Tags</legend>
          {tags.map((tag) =>
            deleting === tag.id ? (
              <div
                key={`${tag.id}-confirm`}
                role="group"
                aria-label={`Delete ${tag.name}`}
                aria-describedby={`${id}-confirm`}
                className="flex flex-wrap items-center gap-2 rounded-md border border-destructive p-2 text-sm text-ink"
              >
                <span id={`${id}-confirm`} className="flex-1">
                  Delete {tag.name} from every restaurant?
                </span>
                <Button
                  type="button"
                  variant="destructive"
                  className="h-11 md:h-8"
                  disabled={pending}
                  onClick={() => remove(tag)}
                >
                  Delete
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 md:h-8"
                  autoFocus
                  onClick={() => keep(tag.id)}
                >
                  Keep
                </Button>
              </div>
            ) : (
              <div key={tag.id} className="flex items-center justify-between gap-2">
                <label className="flex min-h-11 flex-1 items-center gap-2 text-sm text-ink md:min-h-8">
                  <input
                    type="checkbox"
                    className="size-4 accent-brand"
                    checked={chosen.has(tag.id)}
                    disabled={!chosen.has(tag.id) && chosen.size >= MAX_TAGS}
                    onChange={(event) => toggle(tag.id, event.target.checked)}
                  />
                  <span
                    aria-hidden
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: TAG_SWATCHES[tag.colour] }}
                  />
                  {tag.name}
                </label>
                <Button
                  id={`${id}-delete-${tag.id}`}
                  type="button"
                  variant="ghost"
                  size="icon-touch"
                  className="md:size-8"
                  aria-label={`Delete ${tag.name}`}
                  onClick={() => setDeleting(tag.id)}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            ),
          )}
        </fieldset>
      )}

      <fieldset className="flex flex-col gap-2 rounded-md border border-line p-3">
        <legend className="px-1 text-sm font-medium text-ink">New tag</legend>
        <label htmlFor={`${id}-name`} className="text-sm text-ink">
          Name
        </label>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={30}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (name.trim()) add();
            }
          }}
        />
        <fieldset className="flex flex-wrap gap-1">
          <legend className="mb-1 text-sm text-ink">Colour</legend>
          {TAG_COLOURS.map((option) => (
            <label
              key={option}
              className="flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm text-ink has-checked:bg-muted md:min-h-8"
            >
              <input
                type="radio"
                name={`${id}-colour`}
                value={option}
                className="size-4 accent-brand"
                checked={colour === option}
                onChange={() => setColour(option)}
              />
              <span
                aria-hidden
                className="size-2.5 rounded-full"
                style={{ backgroundColor: TAG_SWATCHES[option] }}
              />
              {TAG_COLOUR_LABELS[option]}
            </label>
          ))}
        </fieldset>
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="self-start"
          disabled={pending || !name.trim()}
          onClick={add}
        >
          <Plus aria-hidden />
          Add tag
        </Button>
      </fieldset>

      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" size="lg" onClick={onDone}>
          Cancel
        </Button>
        <Button type="button" size="lg" disabled={pending} onClick={save}>
          {pending ? 'Saving…' : 'Save tags'}
        </Button>
      </DialogFooter>
    </div>
  );
}
