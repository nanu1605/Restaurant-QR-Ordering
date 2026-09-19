'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Ban, CalendarPlus, CreditCard, KeyRound, RotateCcw, Tags } from 'lucide-react';
import { useId, useState, useTransition, type ReactNode } from 'react';
import { useForm, type FieldValues, type Path, type UseFormSetError } from 'react-hook-form';
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
import type { ActionResult } from '@/lib/action-result';

import {
  changePlan,
  extendTrial,
  recordManualPayment,
  resetOwnerPassword,
  suspendRestaurant,
  unsuspendRestaurant,
} from '../actions';
import { MANUAL_MODE_LABELS, MANUAL_MODES, type SubscriptionStatus } from '../platform';
import {
  changePlanSchema,
  extendTrialSchema,
  generatePassword,
  manualPaymentSchema,
  ownerPasswordSchema,
  periodEnd,
  suspendSchema,
  type ChangePlanInput,
  type ExtendTrialInput,
  type ManualPaymentInput,
  type OwnerPasswordInput,
  type SuspendInput,
} from '../schemas';

const SELECT_CLASS =
  'h-9 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm';

type Dialogs = 'trial' | 'plan' | 'payment' | 'suspend' | 'unsuspend' | null;

type RestaurantActionsProps = {
  restaurantId: string;
  restaurantName: string;
  status: 'active' | 'suspended';
  subscription: { status: SubscriptionStatus; planCode: string } | null;
  plans: { code: string; name: string }[];
  /** Today in India, 'YYYY-MM-DD', for the payment period. */
  today: string;
};

/** Actions on one restaurant (spec §13.4, docs/DECISIONS.md P7-4). */
export function RestaurantActions({
  restaurantId,
  restaurantName,
  status,
  subscription,
  plans,
  today,
}: RestaurantActionsProps) {
  const [open, setOpen] = useState<Dialogs>(null);
  const close = () => setOpen(null);

  return (
    <div className="flex flex-wrap gap-2">
      {subscription?.status === 'trialing' && (
        <Button variant="outline" size="touch" onClick={() => setOpen('trial')}>
          <CalendarPlus aria-hidden />
          Extend trial
        </Button>
      )}
      {subscription && (
        <Button variant="outline" size="touch" onClick={() => setOpen('plan')}>
          <Tags aria-hidden />
          Change plan
        </Button>
      )}
      {subscription && (
        <Button variant="outline" size="touch" onClick={() => setOpen('payment')}>
          <CreditCard aria-hidden />
          Record payment
        </Button>
      )}
      {status === 'active' ? (
        <Button variant="destructive" size="touch" onClick={() => setOpen('suspend')}>
          <Ban aria-hidden />
          Suspend
        </Button>
      ) : (
        <Button variant="outline" size="touch" onClick={() => setOpen('unsuspend')}>
          <RotateCcw aria-hidden />
          Unsuspend
        </Button>
      )}

      <FormDialog
        open={open === 'trial'}
        onClose={close}
        title="Extend trial"
        description="Days are added to the trial's end, or to today if it has already ended."
      >
        <ExtendTrialForm restaurantId={restaurantId} onDone={close} />
      </FormDialog>
      <FormDialog
        open={open === 'plan'}
        onClose={close}
        title="Change plan"
        description="The status and dates stay. A smaller plan never switches off existing tables or staff; it only stops new ones over the limit."
      >
        <ChangePlanForm
          restaurantId={restaurantId}
          current={subscription?.planCode ?? ''}
          plans={plans}
          onDone={close}
        />
      </FormDialog>
      <FormDialog
        open={open === 'payment'}
        onClose={close}
        title="Record payment"
        description="A payment received outside Razorpay. The subscription becomes active until the last day of the period."
      >
        <ManualPaymentForm restaurantId={restaurantId} today={today} onDone={close} />
      </FormDialog>
      <FormDialog
        open={open === 'suspend'}
        onClose={close}
        title={`Suspend ${restaurantName}?`}
        description="Customers can't order and no new tables open. Tables already eating can still be billed. Everything stays visible to the restaurant."
      >
        <SuspendForm restaurantId={restaurantId} onDone={close} />
      </FormDialog>
      <UnsuspendDialog
        open={open === 'unsuspend'}
        onClose={close}
        restaurantId={restaurantId}
        restaurantName={restaurantName}
      />
    </div>
  );
}

function FormDialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {open && children}
      </DialogContent>
    </Dialog>
  );
}

function applyResult<T extends FieldValues>(
  result: ActionResult,
  setError: UseFormSetError<T>,
): boolean {
  if (result.ok) return true;
  for (const [key, message] of Object.entries(result.fieldErrors ?? {})) {
    setError(key as Path<T>, { message });
  }
  if (!result.fieldErrors) setError('root' as Path<T>, { message: result.error });
  return false;
}

function FormFooter({
  pending,
  label,
  error,
}: {
  pending: boolean;
  label: string;
  error?: string;
}) {
  return (
    <>
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" size="lg" />}>
          Cancel
        </DialogClose>
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? 'Saving…' : label}
        </Button>
      </DialogFooter>
    </>
  );
}

function ExtendTrialForm({ restaurantId, onDone }: { restaurantId: string; onDone: () => void }) {
  const ids = useId();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ExtendTrialInput>({
    resolver: zodResolver(extendTrialSchema),
    defaultValues: { days: 7 },
  });

  const onSubmit = handleSubmit(async (values) => {
    if (!applyResult(await extendTrial(restaurantId, values), setError)) return;
    toast.success('Trial extended');
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <Field data-invalid={errors.days ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-days`}>Days to add</FieldLabel>
        <Input
          id={`${ids}-days`}
          type="number"
          min={1}
          max={90}
          className="h-9"
          {...register('days')}
        />
        <FieldDescription>1 to 90 days.</FieldDescription>
        <FieldError errors={[errors.days]} />
      </Field>
      <FormFooter pending={isSubmitting} label="Extend trial" error={errors.root?.message} />
    </form>
  );
}

function ChangePlanForm({
  restaurantId,
  current,
  plans,
  onDone,
}: {
  restaurantId: string;
  current: string;
  plans: { code: string; name: string }[];
  onDone: () => void;
}) {
  const ids = useId();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChangePlanInput>({
    resolver: zodResolver(changePlanSchema),
    defaultValues: { planCode: current },
  });

  const onSubmit = handleSubmit(async (values) => {
    if (!applyResult(await changePlan(restaurantId, values), setError)) return;
    toast.success('Plan changed');
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <Field data-invalid={errors.planCode ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-plan`}>Plan</FieldLabel>
        <select id={`${ids}-plan`} className={SELECT_CLASS} {...register('planCode')}>
          {plans.map((plan) => (
            <option key={plan.code} value={plan.code}>
              {plan.name}
            </option>
          ))}
        </select>
        <FieldError errors={[errors.planCode]} />
      </Field>
      <FormFooter pending={isSubmitting} label="Change plan" error={errors.root?.message} />
    </form>
  );
}

function ManualPaymentForm({
  restaurantId,
  today,
  onDone,
}: {
  restaurantId: string;
  today: string;
  onDone: () => void;
}) {
  const ids = useId();
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<ManualPaymentInput>({
    resolver: zodResolver(manualPaymentSchema),
    defaultValues: {
      amount: '',
      mode: 'bank_transfer',
      billingCycle: 'monthly',
      periodStart: today,
      periodEnd: periodEnd(today, 'monthly'),
      notes: '',
    },
  });

  // The last day follows the first day and the cycle until someone edits it.
  const [endEdited, setEndEdited] = useState(false);
  const refillEnd = () => {
    const { periodStart, billingCycle } = getValues();
    if (!endEdited && /^\d{4}-\d{2}-\d{2}$/.test(periodStart)) {
      setValue('periodEnd', periodEnd(periodStart, billingCycle));
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    if (!applyResult(await recordManualPayment(restaurantId, values), setError)) return;
    toast.success('Payment recorded');
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field data-invalid={errors.amount ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-amount`}>Amount (₹)</FieldLabel>
          <Input
            id={`${ids}-amount`}
            inputMode="decimal"
            className="h-9"
            placeholder="899"
            {...register('amount')}
          />
          <FieldError errors={[errors.amount]} />
        </Field>
        <Field data-invalid={errors.mode ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-mode`}>Paid by</FieldLabel>
          <select id={`${ids}-mode`} className={SELECT_CLASS} {...register('mode')}>
            {MANUAL_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {MANUAL_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
          <FieldError errors={[errors.mode]} />
        </Field>
      </div>
      <Field data-invalid={errors.billingCycle ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-cycle`}>Billing cycle</FieldLabel>
        <select
          id={`${ids}-cycle`}
          className={SELECT_CLASS}
          {...register('billingCycle', { onChange: refillEnd })}
        >
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </select>
        <FieldError errors={[errors.billingCycle]} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field data-invalid={errors.periodStart ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-start`}>First day</FieldLabel>
          <Input
            id={`${ids}-start`}
            type="date"
            className="h-9"
            {...register('periodStart', { onChange: refillEnd })}
          />
          <FieldError errors={[errors.periodStart]} />
        </Field>
        <Field data-invalid={errors.periodEnd ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-end`}>Last day</FieldLabel>
          <Input
            id={`${ids}-end`}
            type="date"
            className="h-9"
            {...register('periodEnd', { onChange: () => setEndEdited(true) })}
          />
          <FieldError errors={[errors.periodEnd]} />
        </Field>
      </div>
      <Field data-invalid={errors.notes ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-notes`}>Notes</FieldLabel>
        <Textarea
          id={`${ids}-notes`}
          rows={2}
          placeholder="UTR or cheque number"
          {...register('notes')}
        />
        <FieldError errors={[errors.notes]} />
      </Field>
      <FormFooter pending={isSubmitting} label="Record payment" error={errors.root?.message} />
    </form>
  );
}

function SuspendForm({ restaurantId, onDone }: { restaurantId: string; onDone: () => void }) {
  const ids = useId();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SuspendInput>({
    resolver: zodResolver(suspendSchema),
    defaultValues: { reason: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    if (!applyResult(await suspendRestaurant(restaurantId, values), setError)) return;
    toast.success('Restaurant suspended');
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <Field data-invalid={errors.reason ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-reason`}>Reason</FieldLabel>
        <Textarea id={`${ids}-reason`} rows={2} {...register('reason')} />
        <FieldDescription>Kept in the audit log.</FieldDescription>
        <FieldError errors={[errors.reason]} />
      </Field>
      <FormFooter pending={isSubmitting} label="Suspend" error={errors.root?.message} />
    </form>
  );
}

function UnsuspendDialog({
  open,
  onClose,
  restaurantId,
  restaurantName,
}: {
  open: boolean;
  onClose: () => void;
  restaurantId: string;
  restaurantName: string;
}) {
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = await unsuspendRestaurant(restaurantId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${restaurantName} is active again`);
      onClose();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unsuspend {restaurantName}?</AlertDialogTitle>
          <AlertDialogDescription>
            Customers can order again, as long as the trial or subscription is still running.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirm} disabled={pending}>
            Unsuspend
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Sets a new password for an owner; shown once so it can be handed over. */
export function OwnerPasswordButton({
  memberId,
  ownerName,
}: {
  memberId: string;
  ownerName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <KeyRound aria-hidden />
        Reset password
      </Button>
      <FormDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`New password for ${ownerName}`}
        description="The owner's other devices stay logged in. Tell them the new password; it isn't shown again."
      >
        <OwnerPasswordForm memberId={memberId} onDone={() => setOpen(false)} />
      </FormDialog>
    </>
  );
}

function OwnerPasswordForm({ memberId, onDone }: { memberId: string; onDone: () => void }) {
  const ids = useId();
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<OwnerPasswordInput>({
    resolver: zodResolver(ownerPasswordSchema),
    defaultValues: { password: generatePassword() },
  });

  const onSubmit = handleSubmit(async (values) => {
    if (!applyResult(await resetOwnerPassword(memberId, values), setError)) return;
    toast.success('New password set');
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <Field data-invalid={errors.password ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-password`}>New password</FieldLabel>
        <div className="flex gap-2">
          <Input
            id={`${ids}-password`}
            className="h-9 font-mono"
            autoComplete="off"
            spellCheck={false}
            {...register('password')}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => setValue('password', generatePassword(), { shouldValidate: true })}
          >
            Generate
          </Button>
        </div>
        <FieldDescription>At least 8 characters.</FieldDescription>
        <FieldError errors={[errors.password]} />
      </Field>
      <FormFooter pending={isSubmitting} label="Set password" error={errors.root?.message} />
    </form>
  );
}
