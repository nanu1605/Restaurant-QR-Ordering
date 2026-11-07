'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { MoreHorizontal, Pencil, Plus, Ban } from 'lucide-react';
import { useId, useState, useTransition } from 'react';
import { useForm, useWatch, type FieldError as FormFieldError } from 'react-hook-form';
import { toast } from 'sonner';

import { Money } from '@/components/shared/money';
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
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { createOffer, editOffer, endOffer } from '../offer-actions';
import {
  discountLabel,
  offerEditSchema,
  offerSchema,
  offerStatus,
  offerTerms,
  type OfferEditInput,
  type OfferInput,
  type OfferRow,
} from '../offers';
import { formatDate } from '../platform';
import { discountLastDay } from '../setup-fee';

const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm';

const STATUS_LABELS = { live: 'Live', scheduled: 'Starts later', ended: 'Ended' } as const;

type Plan = { code: string; name: string };
type Dialogs =
  { kind: 'new' } | { kind: 'edit'; offer: OfferRow } | { kind: 'end'; offer: OfferRow } | null;

/**
 * Offer codes (docs/SUPER_ADMIN_PLAN.md 14b, docs/DECISIONS.md SA-77+): what
 * each takes off, for which plans, and how often it was used.
 */
export function OffersManager({ offers, plans }: { offers: OfferRow[]; plans: Plan[] }) {
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [pending, startTransition] = useTransition();
  const close = () => setDialog(null);
  const planNames = Object.fromEntries(plans.map((plan) => [plan.code, plan.name]));

  return (
    <>
      <div className="flex justify-end">
        <Button size="touch" onClick={() => setDialog({ kind: 'new' })}>
          <Plus aria-hidden />
          New offer
        </Button>
      </div>

      {offers.length === 0 ? (
        <p className="text-sm text-ink-muted">No offers yet.</p>
      ) : (
        <Table label="Offers">
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Discount</TableHead>
              <TableHead>For</TableHead>
              <TableHead>Valid</TableHead>
              <TableHead>Used</TableHead>
              <TableHead>Taken off</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {offers.map((offer) => {
              const status = offerStatus(offer);
              return (
                <TableRow key={offer.id}>
                  <TableCell>
                    <span className="font-mono font-semibold text-ink">{offer.code}</span>
                    {offer.description && (
                      <span className="block max-w-56 truncate text-xs text-ink-muted">
                        {offer.description}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{discountLabel(offer)}</TableCell>
                  <TableCell className="text-sm">{offerTerms(offer, planNames)}</TableCell>
                  <TableCell className="text-sm">
                    {formatDate(offer.valid_from)} –{' '}
                    {offer.valid_until ? formatDate(discountLastDay(offer.valid_until)) : 'no end'}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {offer.used}
                    {offer.max_redemptions !== null && ` of ${offer.max_redemptions}`}
                  </TableCell>
                  <TableCell>
                    <Money paise={offer.discount_paise} fraction="auto" />
                  </TableCell>
                  <TableCell>{STATUS_LABELS[status]}</TableCell>
                  <TableCell>
                    {!offer.ended_at && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-11 md:size-8"
                              aria-label={`Actions for ${offer.code}`}
                            />
                          }
                        >
                          <MoreHorizontal aria-hidden />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setDialog({ kind: 'edit', offer })}>
                            <Pencil aria-hidden /> Change
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setDialog({ kind: 'end', offer })}
                          >
                            <Ban aria-hidden /> End offer
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Dialog open={dialog?.kind === 'new'} onOpenChange={(open) => !open && close()}>
        <DialogContent className="max-h-dvh overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New offer</DialogTitle>
            <DialogDescription>
              Owners enter the code when they set up autopay, or Finance applies it for one
              restaurant. Its terms can&apos;t change later: end it and make another.
            </DialogDescription>
          </DialogHeader>
          {dialog?.kind === 'new' && <OfferForm plans={plans} onDone={close} />}
        </DialogContent>
      </Dialog>

      <Dialog open={dialog?.kind === 'edit'} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === 'edit' ? `Change ${dialog.offer.code}` : 'Change offer'}
            </DialogTitle>
            <DialogDescription>Its description, last day and most uses.</DialogDescription>
          </DialogHeader>
          {dialog?.kind === 'edit' && <EditOfferForm offer={dialog.offer} onDone={close} />}
        </DialogContent>
      </Dialog>

      <AlertDialog open={dialog?.kind === 'end'} onOpenChange={(open) => !open && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              End {dialog?.kind === 'end' ? dialog.offer.code : 'the offer'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Nobody new can use it. Restaurants already paying its price keep it until their
              autopay ends.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => {
                if (dialog?.kind !== 'end') return;
                const { offer } = dialog;
                startTransition(async () => {
                  const result = await endOffer(offer.id);
                  if (result.ok) {
                    toast.success(`${offer.code} ended`);
                    close();
                  } else toast.error(result.error);
                });
              }}
            >
              End offer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function TextField({
  id,
  label,
  error,
  description,
  ...input
}: React.ComponentProps<typeof Input> & {
  id: string;
  label: string;
  error?: FormFieldError;
  description?: string;
}) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        className="h-11 md:h-9"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...input}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      <FieldError id={`${id}-error`} errors={[error]} />
    </Field>
  );
}

function OfferForm({ plans, onDone }: { plans: Plan[]; onDone: () => void }) {
  const ids = useId();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<OfferInput>({
    resolver: zodResolver(offerSchema),
    defaultValues: {
      code: '',
      description: '',
      discountKind: 'percent',
      discount: '',
      planCodes: [],
      cycles: [],
      durationCycles: '',
      validFrom: '',
      validUntil: '',
      maxRedemptions: '',
      newOnly: false,
    },
  });
  const kind = useWatch({ control, name: 'discountKind' });

  const onSubmit = handleSubmit(async (values) => {
    const result = await createOffer(values);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
        setError(field as keyof OfferInput, { message });
      }
      if (!result.fieldErrors) setError('root', { message: result.error });
      return;
    }
    toast.success(`Offer ${values.code.trim().toUpperCase()} created`);
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <TextField
          id={`${ids}-code`}
          label="Code"
          autoComplete="off"
          className="h-11 uppercase md:h-9"
          error={errors.code}
          {...register('code')}
        />
        <TextField
          id={`${ids}-description`}
          label="Description (optional)"
          autoComplete="off"
          error={errors.description}
          {...register('description')}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${ids}-kind`}>Discount</FieldLabel>
            <select id={`${ids}-kind`} className={SELECT_CLASS} {...register('discountKind')}>
              <option value="percent">Percent off</option>
              <option value="flat">Rupees off each charge</option>
            </select>
          </Field>
          <TextField
            id={`${ids}-discount`}
            label={kind === 'percent' ? 'Percent' : 'Rupees'}
            inputMode="numeric"
            error={errors.discount}
            {...register('discount')}
          />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-ink">Plans (none ticked: all)</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {plans.map((plan) => (
              <label
                key={plan.code}
                className="flex min-h-11 items-center gap-2 text-sm md:min-h-0"
              >
                <input
                  type="checkbox"
                  value={plan.code}
                  className="size-4 accent-brand"
                  {...register('planCodes')}
                />
                {plan.name}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-ink">Cycles (none ticked: both)</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {(['monthly', 'yearly'] as const).map((cycle) => (
              <label key={cycle} className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
                <input
                  type="checkbox"
                  value={cycle}
                  className="size-4 accent-brand"
                  {...register('cycles')}
                />
                {cycle === 'monthly' ? 'Monthly' : 'Yearly'}
              </label>
            ))}
          </div>
        </fieldset>
        <TextField
          id={`${ids}-duration`}
          label="For the first charges (optional)"
          inputMode="numeric"
          description="Empty: every charge of that autopay. After these, the owner sets up autopay at the full price."
          error={errors.durationCycles}
          {...register('durationCycles')}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id={`${ids}-from`}
            label="First day (optional)"
            type="date"
            error={errors.validFrom}
            {...register('validFrom')}
          />
          <TextField
            id={`${ids}-until`}
            label="Last day (optional)"
            type="date"
            error={errors.validUntil}
            {...register('validUntil')}
          />
        </div>
        <TextField
          id={`${ids}-max`}
          label="Most uses (optional)"
          inputMode="numeric"
          error={errors.maxRedemptions}
          {...register('maxRedemptions')}
        />
        <label className="flex min-h-11 items-center gap-2 text-sm text-ink md:min-h-0">
          <input type="checkbox" className="size-4 accent-brand" {...register('newOnly')} />
          Only restaurants that haven&apos;t paid yet
        </label>
      </FieldGroup>
      {errors.root && (
        <p role="alert" className="text-sm text-destructive">
          {errors.root.message}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" size="touch" disabled={isSubmitting}>
          {isSubmitting ? 'Creating…' : 'Create offer'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditOfferForm({ offer, onDone }: { offer: OfferRow; onDone: () => void }) {
  const ids = useId();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<OfferEditInput>({
    resolver: zodResolver(offerEditSchema),
    defaultValues: {
      description: offer.description ?? '',
      validUntil: offer.valid_until ? discountLastDay(offer.valid_until) : '',
      maxRedemptions: offer.max_redemptions === null ? '' : String(offer.max_redemptions),
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    const result = await editOffer(offer.id, values);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
        setError(field as keyof OfferEditInput, { message });
      }
      if (!result.fieldErrors) setError('root', { message: result.error });
      return;
    }
    toast.success(`Saved ${offer.code}`);
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <TextField
          id={`${ids}-description`}
          label="Description (optional)"
          autoComplete="off"
          error={errors.description}
          {...register('description')}
        />
        <TextField
          id={`${ids}-until`}
          label="Last day (optional)"
          type="date"
          error={errors.validUntil}
          {...register('validUntil')}
        />
        <TextField
          id={`${ids}-max`}
          label="Most uses (optional)"
          inputMode="numeric"
          error={errors.maxRedemptions}
          {...register('maxRedemptions')}
        />
      </FieldGroup>
      {errors.root && (
        <p role="alert" className="text-sm text-destructive">
          {errors.root.message}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" size="touch" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}
