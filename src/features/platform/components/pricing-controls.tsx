'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { FEATURE_KEYS, FEATURE_LABELS } from '@/features/plans/plan-features';

import { endDeal, removeOverride, setDeal, setOverride } from '../offer-actions';
import {
  dealSchema,
  OVERRIDE_KIND_LABELS,
  OVERRIDE_KINDS,
  overrideLabel,
  overrideSchema,
  type DealInput,
  type OverrideInput,
  type OverrideRow,
} from '../offers';

const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm';
const BETA = '__beta';

export type PricedPlan = { code: string; name: string; monthlyPaise: number; yearlyPaise: number };

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
  description?: React.ReactNode;
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

/**
 * One restaurant's price (docs/SUPER_ADMIN_PLAN.md 14b, docs/DECISIONS.md
 * SA-77+): an offer code or a custom price, and going back to the list price.
 */
export function DealControls({
  restaurantId,
  plans,
  current,
  canEnd,
}: {
  restaurantId: string;
  plans: PricedPlan[];
  current: { planCode: string; cycle: 'monthly' | 'yearly' } | null;
  canEnd: boolean;
}) {
  const [open, setOpen] = useState<'set' | 'end' | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="touch" variant="outline" onClick={() => setOpen('set')}>
        Set a price
      </Button>
      {canEnd && (
        <Button size="touch" variant="outline" onClick={() => setOpen('end')}>
          Back to the list price
        </Button>
      )}

      <Dialog open={open === 'set'} onOpenChange={(value) => !value && setOpen(null)}>
        <DialogContent className="max-h-dvh overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set a price</DialogTitle>
            <DialogDescription>
              An offer code, or a price you agreed. Without autopay it applies now; on autopay, from
              the owner&apos;s next autopay, since Razorpay can&apos;t change a running one.
            </DialogDescription>
          </DialogHeader>
          {open === 'set' && (
            <DealForm
              restaurantId={restaurantId}
              plans={plans}
              current={current}
              onDone={() => setOpen(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={open === 'end'} onOpenChange={(value) => !value && setOpen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Back to the list price?</AlertDialogTitle>
            <AlertDialogDescription>
              The special price ends, and the one waiting for the owner&apos;s next autopay. A price
              a running autopay charges stays: cancel that autopay first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the price</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await endDeal(restaurantId);
                  if (result.ok) {
                    toast.success(
                      result.data.stillCharged
                        ? 'The waiting price ended; the running autopay keeps its price'
                        : 'Back to the list price',
                    );
                    setOpen(null);
                  } else toast.error(result.error);
                })
              }
            >
              End the price
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function DealForm({
  restaurantId,
  plans,
  current,
  onDone,
}: {
  restaurantId: string;
  plans: PricedPlan[];
  current: { planCode: string; cycle: 'monthly' | 'yearly' } | null;
  onDone: () => void;
}) {
  const ids = useId();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<DealInput>({
    resolver: zodResolver(dealSchema),
    defaultValues: {
      mode: 'offer',
      planCode: current?.planCode ?? plans[0]?.code ?? '',
      billingCycle: current?.cycle ?? 'monthly',
      offerCode: '',
      price: '',
      cycles: '',
      reason: '',
    },
  });
  const [mode, planCode, cycle] = useWatch({ control, name: ['mode', 'planCode', 'billingCycle'] });
  const plan = plans.find((row) => row.code === planCode);
  const list = plan ? (cycle === 'yearly' ? plan.yearlyPaise : plan.monthlyPaise) : null;

  const onSubmit = handleSubmit(async (values) => {
    const result = await setDeal(restaurantId, values);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
        setError(field as keyof DealInput, { message });
      }
      if (!result.fieldErrors) setError('root', { message: result.error });
      return;
    }
    toast.success(result.data.appliedNow ? 'Price set' : 'Price set for the owner’s next autopay');
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
          <legend className="mb-1 text-sm font-medium text-ink">Price from</legend>
          {(['offer', 'custom'] as const).map((value) => (
            <label key={value} className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
              <input type="radio" value={value} className="size-4" {...register('mode')} />
              {value === 'offer' ? 'An offer code' : 'A price we agreed'}
            </label>
          ))}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${ids}-plan`}>Plan</FieldLabel>
            <select id={`${ids}-plan`} className={SELECT_CLASS} {...register('planCode')}>
              {plans.map((row) => (
                <option key={row.code} value={row.code}>
                  {row.name}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-cycle`}>Billing</FieldLabel>
            <select id={`${ids}-cycle`} className={SELECT_CLASS} {...register('billingCycle')}>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </Field>
        </div>
        {list !== null && (
          <p className="text-sm text-ink-muted">
            List price <Money paise={list} fraction="auto" />{' '}
            {cycle === 'yearly' ? 'a year' : 'a month'} + GST.
          </p>
        )}
        {mode === 'offer' ? (
          <TextField
            id={`${ids}-code`}
            label="Offer code"
            autoComplete="off"
            className="h-11 uppercase md:h-9"
            error={errors.offerCode}
            {...register('offerCode')}
          />
        ) : (
          <>
            <TextField
              id={`${ids}-price`}
              label="Price before GST, in rupees"
              inputMode="numeric"
              error={errors.price}
              {...register('price')}
            />
            <TextField
              id={`${ids}-cycles`}
              label="For the first charges (optional)"
              inputMode="numeric"
              description="Empty: every charge. On autopay, the owner then sets up the full price."
              error={errors.cycles}
              {...register('cycles')}
            />
          </>
        )}
        <TextField
          id={`${ids}-reason`}
          label={mode === 'offer' ? 'Note (optional)' : 'Why'}
          autoComplete="off"
          error={errors.reason}
          {...register('reason')}
        />
      </FieldGroup>
      {errors.root && (
        <p role="alert" className="text-sm text-destructive">
          {errors.root.message}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" size="touch" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Set the price'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Adds a feature, a beta flag or more tables or staff for one restaurant. */
export function AddOverride({ restaurantId }: { restaurantId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="touch" variant="outline" onClick={() => setOpen(true)}>
        <Plus aria-hidden />
        Add an override
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add an override</DialogTitle>
            <DialogDescription>
              On top of the plan, for this restaurant only. One of the same kind replaces it.
            </DialogDescription>
          </DialogHeader>
          {open && <OverrideForm restaurantId={restaurantId} onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function OverrideForm({ restaurantId, onDone }: { restaurantId: string; onDone: () => void }) {
  const ids = useId();
  const [beta, setBeta] = useState(false);
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<OverrideInput>({
    resolver: zodResolver(overrideSchema),
    defaultValues: {
      kind: 'feature',
      feature: FEATURE_KEYS[0],
      value: '',
      expiresOn: '',
      reason: '',
    },
  });
  const [kind, feature] = useWatch({ control, name: ['kind', 'feature'] });

  const onSubmit = handleSubmit(async (values) => {
    const result = await setOverride(restaurantId, values);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
        setError(field as keyof OverrideInput, { message });
      }
      if (!result.fieldErrors) setError('root', { message: result.error });
      return;
    }
    toast.success('Override added');
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor={`${ids}-kind`}>What</FieldLabel>
          <select id={`${ids}-kind`} className={SELECT_CLASS} {...register('kind')}>
            {OVERRIDE_KINDS.map((value) => (
              <option key={value} value={value}>
                {OVERRIDE_KIND_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        {kind === 'feature' ? (
          <>
            <Field>
              <FieldLabel htmlFor={`${ids}-pick`}>Feature</FieldLabel>
              <select
                id={`${ids}-pick`}
                className={SELECT_CLASS}
                value={beta ? BETA : feature}
                onChange={(event) => {
                  const picked = event.target.value;
                  setBeta(picked === BETA);
                  setValue('feature', picked === BETA ? '' : picked);
                }}
              >
                {FEATURE_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {FEATURE_LABELS[key]}
                  </option>
                ))}
                <option value={BETA}>A beta flag…</option>
              </select>
            </Field>
            {beta ? (
              <TextField
                id={`${ids}-feature`}
                label="Beta flag key"
                autoComplete="off"
                description="Lower-case letters and underscores, e.g. beta_waitlist."
                error={errors.feature}
                {...register('feature')}
              />
            ) : (
              <FieldError errors={[errors.feature]} />
            )}
          </>
        ) : (
          <TextField
            id={`${ids}-value`}
            label={kind === 'max_tables' ? 'Tables' : 'Staff logins'}
            inputMode="numeric"
            description="Empty: no limit. Never below the plan's own."
            error={errors.value}
            {...register('value')}
          />
        )}
        <TextField
          id={`${ids}-expires`}
          label="Last day (optional)"
          type="date"
          description="After it, the plan's limits come back. Tables and staff over them stay on."
          error={errors.expiresOn}
          {...register('expiresOn')}
        />
        <TextField
          id={`${ids}-reason`}
          label="Why"
          autoComplete="off"
          error={errors.reason}
          {...register('reason')}
        />
      </FieldGroup>
      {errors.root && (
        <p role="alert" className="text-sm text-destructive">
          {errors.root.message}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" size="touch" disabled={isSubmitting}>
          {isSubmitting ? 'Adding…' : 'Add override'}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RemoveOverride({ override }: { override: OverrideRow }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const label = overrideLabel(override);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-11 md:size-8"
        aria-label={`Remove ${label}`}
        onClick={() => setOpen(true)}
      >
        <Trash2 aria-hidden />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The plan&apos;s own features and limits apply again. Tables and staff over the limit
              stay on.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await removeOverride(override.id);
                  if (result.ok) {
                    toast.success(`${label} removed`);
                    setOpen(false);
                  } else toast.error(result.error);
                })
              }
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
