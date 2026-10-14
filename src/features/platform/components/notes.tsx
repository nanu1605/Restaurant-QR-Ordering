'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Pin, PinOff } from 'lucide-react';
import { useId, useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

import { addNote, editNote, pinNote } from '../actions';
import { formatDateTime } from '../platform';
import { noteSchema, type NoteInput, type RestaurantNote } from '../restaurant-page';

/**
 * Writing a note on a restaurant (docs/DECISIONS.md SA-38). In a dialog it
 * closes when saved; on the Notes tab it empties for the next one.
 */
export function NoteForm({ restaurantId, onDone }: { restaurantId: string; onDone?: () => void }) {
  const id = useId();
  const [pinned, setPinned] = useState(false);
  const form = useForm<NoteInput>({
    resolver: zodResolver(noteSchema),
    defaultValues: { body: '' },
  });
  const { errors, isSubmitting } = form.formState;

  async function submit(values: NoteInput) {
    const result = await addNote(restaurantId, values, pinned);
    if (!result.ok) {
      form.setError(result.fieldErrors?.body ? 'body' : 'root', {
        message: result.fieldErrors?.body ?? result.error,
      });
      return;
    }
    toast.success(pinned ? 'Note pinned' : 'Note added');
    form.reset();
    setPinned(false);
    onDone?.();
  }

  return (
    <form onSubmit={form.handleSubmit(submit)} noValidate className="flex flex-col gap-3">
      <Field data-invalid={errors.body ? true : undefined}>
        <FieldLabel htmlFor={`${id}-body`}>Note</FieldLabel>
        <Textarea
          id={`${id}-body`}
          rows={4}
          maxLength={2000}
          aria-invalid={!!errors.body}
          {...form.register('body')}
        />
        <FieldDescription>Only the MenuMesh team sees notes.</FieldDescription>
        <FieldError errors={[errors.body]} />
      </Field>
      <label className="flex min-h-11 items-center gap-2 text-sm text-ink md:min-h-0">
        <input
          type="checkbox"
          className="size-4 accent-brand"
          checked={pinned}
          onChange={(event) => setPinned(event.target.checked)}
        />
        Pin it to the top of the page
      </label>
      {errors.root && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errors.root.message}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="touch" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save note'}
        </Button>
      </div>
    </form>
  );
}

/** One note: its text, who wrote it and when, Pin, and Edit for its author's first 15 minutes. */
export function NoteItem({ note }: { note: RestaurantNote }) {
  const [editing, setEditing] = useState(false);
  const [pinning, startPin] = useTransition();
  const editable = note.editable_until !== null;

  function togglePin() {
    startPin(async () => {
      const result = await pinNote(note.id, !note.pinned);
      if (result.ok) toast.success(note.pinned ? 'Note unpinned' : 'Note pinned');
      else toast.error(result.error);
    });
  }

  return (
    <li className="flex flex-col gap-2 px-3 py-3">
      {editing ? (
        <EditNoteForm note={note} onDone={() => setEditing(false)} />
      ) : (
        <p className="text-sm whitespace-pre-wrap text-ink">{note.body}</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-muted">
          {note.pinned && (
            <span className="mr-2 inline-flex items-center gap-1 font-medium text-ink">
              <Pin aria-hidden className="size-3" />
              Pinned
            </span>
          )}
          {note.author ?? 'A former team member'}, {formatDateTime(note.created_at)}
          {note.edited_at && ' (edited)'}
        </p>
        {!editing && (
          <div className="flex gap-2">
            {editable && (
              <Button variant="ghost" className="h-11 md:h-8" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <Button variant="ghost" className="h-11 md:h-8" disabled={pinning} onClick={togglePin}>
              {note.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
              {note.pinned ? 'Unpin' : 'Pin'}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

function EditNoteForm({ note, onDone }: { note: RestaurantNote; onDone: () => void }) {
  const id = useId();
  const form = useForm<NoteInput>({
    resolver: zodResolver(noteSchema),
    defaultValues: { body: note.body },
  });
  const { errors, isSubmitting } = form.formState;

  async function submit(values: NoteInput) {
    const result = await editNote(note.id, values);
    if (!result.ok) {
      form.setError(result.fieldErrors?.body ? 'body' : 'root', {
        message: result.fieldErrors?.body ?? result.error,
      });
      return;
    }
    toast.success('Note saved');
    onDone();
  }

  return (
    <form onSubmit={form.handleSubmit(submit)} noValidate className="flex flex-col gap-2">
      <Field data-invalid={errors.body ? true : undefined}>
        <FieldLabel htmlFor={`${id}-body`}>Edit note</FieldLabel>
        <Textarea
          id={`${id}-body`}
          rows={4}
          maxLength={2000}
          autoFocus
          aria-invalid={!!errors.body}
          {...form.register('body')}
        />
        {note.editable_until && (
          <FieldDescription>
            You can edit it until {formatDateTime(note.editable_until)}.
          </FieldDescription>
        )}
        <FieldError errors={[errors.body]} />
      </Field>
      {errors.root && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errors.root.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="touch" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="touch" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
