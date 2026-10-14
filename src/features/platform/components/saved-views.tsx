'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { BookmarkPlus, X } from 'lucide-react';
import { useId, useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

import { deleteView, saveView } from '../actions';
import { savedViewSchema, type SavedViewInput } from '../schemas';

/** Saves the list's current filters, sort and columns (docs/DECISIONS.md SA-24). */
export function SaveViewButton({ query }: { query: string }) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<SavedViewInput>({
    resolver: zodResolver(savedViewSchema),
    defaultValues: { name: '', shared: false },
  });

  const onSubmit = handleSubmit(async (values) => {
    const result = await saveView(query, values);
    if (!result.ok) {
      setError('name', { message: result.fieldErrors?.name ?? result.error });
      return;
    }
    toast.success('View saved');
    reset();
    setOpen(false);
  });

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <BookmarkPlus aria-hidden />
        Save view
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save this view</DialogTitle>
            <DialogDescription>
              Keeps the filters, sort and columns. The same name again replaces a view.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
            <Field data-invalid={errors.name ? true : undefined}>
              <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
              <Input id={`${ids}-name`} className="h-9" {...register('name')} />
              <FieldError errors={[errors.name]} />
            </Field>
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
              <input type="checkbox" className="size-4 accent-brand" {...register('shared')} />
              Share with the team
            </label>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" size="lg" />}>
                Cancel
              </DialogClose>
              <Button type="submit" size="lg" disabled={isSubmitting}>
                {isSubmitting ? 'Saving…' : 'Save view'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Deletes one of the admin's own views, once confirmed: a shared one goes for everyone. */
export function DeleteViewButton({
  viewId,
  name,
  shared,
}: {
  viewId: string;
  name: string;
  shared: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete view ${name}`}
        onClick={() => setOpen(true)}
      >
        <X aria-hidden />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the view {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {shared
                ? 'It is shared, so it goes for the whole team too.'
                : 'Only the saved view goes; no restaurant changes.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await deleteView(viewId);
                  if (!result.ok) {
                    toast.error(result.error);
                    return;
                  }
                  setOpen(false);
                  toast.success('View deleted');
                })
              }
            >
              Delete view
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
