'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { useForm, type Path } from 'react-hook-form';
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
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatDate } from '@/features/platform/platform';

import { closeRestaurant, reopenRestaurant } from '../actions';
import { closeAccountSchema, type CloseAccountInput, type Closure } from '../closure';

/**
 * Closing an account, and reopening it during the hold (docs/SUPER_ADMIN_PLAN.md
 * 14e, docs/DECISIONS.md SA-94+).
 */
export function CloseAccountCard({
  restaurantId,
  name,
  slug,
  closure,
}: {
  restaurantId: string;
  name: string;
  slug: string;
  closure: Closure | null;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const state = !closure ? 'open' : closure.removed_at ? 'removed' : 'closed';
  const shown = useRef(state);

  // Closing or reopening removes the button focus would go back to.
  useEffect(() => {
    if (shown.current === state) return;
    shown.current = state;
    heading.current?.focus();
  }, [state]);

  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 md:p-6"
    >
      <h2
        ref={heading}
        id={`${ids}-title`}
        tabIndex={-1}
        className="text-base font-semibold text-ink outline-none"
      >
        {closure ? 'Closed account' : 'Close account'}
      </h2>

      {!closure && (
        <>
          <ul className="flex max-w-prose list-disc flex-col gap-1 pl-5 text-sm text-ink">
            <li>Logins stop at once and autopay is cancelled. Paid time isn’t refunded.</li>
            <li>Its QR codes stop working. The team can still see everything here.</li>
            <li>
              It can be reopened for 30 days. Then logins, names, phones, emails, the storefront
              photo, support requests and notes are removed for good.
            </li>
            <li>Bills, payments, orders, its legal name, GSTIN and address stay.</li>
          </ul>
          <div>
            <Button variant="destructive" size="touch" onClick={() => setOpen(true)}>
              Close account…
            </Button>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Close {name}?</DialogTitle>
                <DialogDescription>
                  The owner is emailed, if there’s an address on file. Download their data first if
                  they want a copy; the team can still do it during the 30 days.
                </DialogDescription>
              </DialogHeader>
              {open && (
                <CloseForm
                  restaurantId={restaurantId}
                  slug={slug}
                  onDone={(emailed) => {
                    setOpen(false);
                    if (emailed) toast.success(`${name} is closed`);
                    // Stays until dismissed: the owner hears it from the team instead.
                    else
                      toast.warning(`${name} is closed, but no email went out. Tell the owner.`, {
                        duration: Infinity,
                      });
                  }}
                />
              )}
            </DialogContent>
          </Dialog>
        </>
      )}

      {closure && closure.removed_at && (
        <p className="max-w-prose text-sm text-ink">
          Its personal data was removed on {formatDate(closure.removed_at)}, so it can’t be
          reopened. Its financial records stay.
        </p>
      )}

      {closure && !closure.removed_at && (
        <>
          <p className="max-w-prose text-sm text-ink">
            Closed on {formatDate(closure.closed_at)}
            {closure.closed_by ? ` by ${closure.closed_by}` : ''}. It can be reopened until the end
            of {formatDate(closure.removal_due_at)}. Then its personal data is removed for good.
          </p>
          <p className="max-w-prose text-sm text-ink-muted">
            Reopening turns its logins and QR codes back on. Autopay stays off: the owner sets it up
            again.
          </p>
          <div>
            <ReopenButton restaurantId={restaurantId} name={name} />
          </div>
        </>
      )}
    </section>
  );
}

function CloseForm({
  restaurantId,
  slug,
  onDone,
}: {
  restaurantId: string;
  slug: string;
  onDone: (emailed: boolean) => void;
}) {
  const ids = useId();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CloseAccountInput>({
    resolver: zodResolver(closeAccountSchema),
    defaultValues: { reason: '', code: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    const result = await closeRestaurant(restaurantId, values);
    if (result.ok) {
      onDone(result.data.emailed);
      return;
    }
    if (result.fieldErrors) {
      for (const [key, message] of Object.entries(result.fieldErrors)) {
        setError(key as Path<CloseAccountInput>, { message });
      }
    } else {
      setError('root', { message: result.error });
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <Field data-invalid={errors.reason ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-reason`}>Reason</FieldLabel>
        <Textarea id={`${ids}-reason`} rows={2} {...register('reason')} />
        <FieldDescription>
          Kept in the audit log until the personal data is removed.
        </FieldDescription>
        <FieldError errors={[errors.reason]} />
      </Field>
      <Field data-invalid={errors.code ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-code`}>Restaurant code</FieldLabel>
        <Input
          id={`${ids}-code`}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          {...register('code')}
        />
        <FieldDescription>
          Type <span className="font-mono text-ink">{slug}</span> to confirm.
        </FieldDescription>
        <FieldError errors={[errors.code]} />
      </Field>
      {errors.root?.message && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errors.root.message}
        </p>
      )}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" size="lg" />}>
          Cancel
        </DialogClose>
        <Button type="submit" variant="destructive" size="lg" disabled={isSubmitting}>
          {isSubmitting ? 'Closing…' : 'Close account'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ReopenButton({ restaurantId, name }: { restaurantId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = await reopenRestaurant(restaurantId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`Reopened ${name}`);
      setOpen(false);
    });
  }

  return (
    <>
      <Button size="touch" onClick={() => setOpen(true)}>
        Reopen account
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reopen {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its logins and QR codes work again, as long as the trial or subscription is still
              running. If it was suspended before closing, it goes back to suspended.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirm} disabled={pending}>
              Reopen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
