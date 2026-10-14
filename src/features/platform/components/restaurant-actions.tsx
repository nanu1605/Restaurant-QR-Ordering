'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  Ban,
  CalendarPlus,
  ChevronDown,
  CircleStop,
  CreditCard,
  Headset,
  KeyRound,
  Link2,
  NotebookPen,
  RefreshCw,
  RotateCcw,
  Tags,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition, type ReactNode } from 'react';
import {
  useForm,
  useWatch,
  type FieldValues,
  type Path,
  type UseFormSetError,
} from 'react-hook-form';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { parsePriceInput } from '@/features/menu/schemas';
import { splitGst, withGst } from '@/features/subscriptions/gst';
import { StartSupportSessionForm } from '@/features/support/components/start-support-session';
import type { ActionResult } from '@/lib/action-result';
import { APP_NAME } from '@/lib/config';
import { formatINR } from '@/lib/money';

import {
  cancelRestaurantAutopay,
  changePlan,
  extendTrial,
  recordManualPayment,
  resetOwnerPassword,
  sendPaymentLink,
  suspendRestaurant,
  syncRazorpay,
  unsuspendRestaurant,
} from '../actions';
import { MANUAL_MODE_LABELS, MANUAL_MODES, type SubscriptionStatus } from '../platform';
import {
  changePlanSchema,
  extendTrialSchema,
  generatePassword,
  manualPaymentSchema,
  ownerPasswordSchema,
  paymentLinkSchema,
  periodEnd,
  suspendSchema,
  type ChangePlanInput,
  type ExtendTrialInput,
  type ManualPaymentInput,
  type OwnerPasswordInput,
  type PaymentLinkInput,
  type SuspendInput,
} from '../schemas';

import { NoteForm } from './notes';

const SELECT_CLASS =
  'h-9 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm';

type Dialogs =
  | 'trial'
  | 'plan'
  | 'payment'
  | 'link'
  | 'autopay'
  | 'suspend'
  | 'unsuspend'
  | 'note'
  | 'support'
  | null;

const ITEM_CLASS = 'min-h-11 px-2 md:min-h-9';

const TRIAL_HELP = "Days are added to the trial's end, or to today if it has already ended.";
const PAYMENT_HELP =
  'A payment received outside Razorpay. A subscription payment starts on the first day not yet covered and keeps the restaurant active until the last day (a period already covered is only recorded). A setup fee is only recorded.';
const LINK_HELP =
  "Razorpay emails or texts the link to the restaurant's email and phone, when it has them. A paid subscription link extends access from the first day not yet paid for; a setup fee is only recorded.";

/** What a payment link form starts with (paise). */
export type LinkDefaults = {
  planName: string;
  monthlyPaise: number;
  yearlyPaise: number;
  /** What the restaurant pays for setup, after the discount. */
  setupFeePaise: number;
  setupFeeDiscountPaise: number;
};

type RestaurantActionsProps = {
  restaurantId: string;
  restaurantName: string;
  status: 'active' | 'suspended';
  subscription: { status: SubscriptionStatus; planCode: string } | null;
  plans: { code: string; name: string }[];
  /** The first day a new payment would cover ('YYYY-MM-DD', India). */
  paymentStart: string;
  /** Null while the Razorpay keys aren't set. */
  razorpay: {
    subscriptionId: string | null;
    autopay: 'on' | 'ending' | 'off';
    linkDefaults: LinkDefaults;
  } | null;
  /**
   * The restaurant's support window (docs/DECISIONS.md SA-47): none open, open
   * and unused, this team member's, or someone else's.
   */
  support: { state: 'none' | 'open' | 'mine' | 'in_use'; lastName: string };
};

/**
 * Actions on one restaurant (spec §13.4, docs/DECISIONS.md P7-4), in one menu
 * on its page's header (docs/DECISIONS.md SA-34).
 */
export function RestaurantActions({
  restaurantId,
  restaurantName,
  status,
  subscription,
  plans,
  paymentStart,
  razorpay,
  support,
}: RestaurantActionsProps) {
  const router = useRouter();
  const [open, setOpen] = useState<Dialogs>(null);
  const close = () => setOpen(null);
  const [syncing, startSync] = useTransition();

  function sync() {
    startSync(async () => {
      const result = await syncRazorpay(restaurantId);
      if (result.ok) toast.success('Saved what Razorpay says');
      else toast.error(result.error);
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="touch" />}>
          Actions
          <ChevronDown aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          {subscription?.status === 'trialing' && (
            <DropdownMenuItem className={ITEM_CLASS} onClick={() => setOpen('trial')}>
              <CalendarPlus aria-hidden />
              Extend trial
            </DropdownMenuItem>
          )}
          {subscription && (
            <DropdownMenuItem className={ITEM_CLASS} onClick={() => setOpen('plan')}>
              <Tags aria-hidden />
              Change plan
            </DropdownMenuItem>
          )}
          {subscription && (
            <DropdownMenuItem className={ITEM_CLASS} onClick={() => setOpen('payment')}>
              <CreditCard aria-hidden />
              Record payment
            </DropdownMenuItem>
          )}
          {subscription && razorpay && (
            <DropdownMenuItem className={ITEM_CLASS} onClick={() => setOpen('link')}>
              <Link2 aria-hidden />
              Send payment link
            </DropdownMenuItem>
          )}
          {razorpay?.subscriptionId && (
            <DropdownMenuItem className={ITEM_CLASS} onClick={sync} disabled={syncing}>
              <RefreshCw aria-hidden />
              {syncing ? 'Syncing…' : 'Sync with Razorpay'}
            </DropdownMenuItem>
          )}
          {razorpay?.autopay === 'on' && (
            <DropdownMenuItem className={ITEM_CLASS} onClick={() => setOpen('autopay')}>
              <CircleStop aria-hidden />
              Cancel autopay
            </DropdownMenuItem>
          )}
          {subscription && <DropdownMenuSeparator />}
          <DropdownMenuItem className={ITEM_CLASS} onClick={() => setOpen('note')}>
            <NotebookPen aria-hidden />
            Add note
          </DropdownMenuItem>
          {support.state === 'mine' ? (
            <DropdownMenuItem className={ITEM_CLASS} onClick={() => router.push('/admin')}>
              <Headset aria-hidden />
              Open admin panel
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              className={ITEM_CLASS}
              disabled={support.state !== 'open'}
              onClick={() => setOpen('support')}
            >
              <Headset aria-hidden />
              Start support session
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {status === 'active' ? (
            <DropdownMenuItem
              variant="destructive"
              className={ITEM_CLASS}
              onClick={() => setOpen('suspend')}
            >
              <Ban aria-hidden />
              Suspend
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem className={ITEM_CLASS} onClick={() => setOpen('unsuspend')}>
              <RotateCcw aria-hidden />
              Unsuspend
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <FormDialog
        open={open === 'trial'}
        onClose={close}
        title="Extend trial"
        description={TRIAL_HELP}
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
        description={PAYMENT_HELP}
      >
        <ManualPaymentForm restaurantId={restaurantId} start={paymentStart} onDone={close} />
      </FormDialog>
      {razorpay && (
        <FormDialog
          open={open === 'link'}
          onClose={close}
          title="Send payment link"
          description={LINK_HELP}
        >
          <PaymentLinkForm
            restaurantId={restaurantId}
            defaults={razorpay.linkDefaults}
            onDone={close}
          />
        </FormDialog>
      )}
      <CancelAutopayDialog
        open={open === 'autopay'}
        onClose={close}
        restaurantId={restaurantId}
        restaurantName={restaurantName}
      />
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
      <FormDialog
        open={open === 'note'}
        onClose={close}
        title={`Add a note on ${restaurantName}`}
        description="Only the MenuMesh team sees notes. You can edit yours for 15 minutes."
      >
        <NoteForm restaurantId={restaurantId} onDone={close} />
      </FormDialog>
      <FormDialog
        open={open === 'support'}
        onClose={close}
        title={`Start a support session in ${restaurantName}`}
        description="You work in its admin panel as a manager until the owner's access ends. Bills, payments, live orders, tax and UPI settings stay the owner's, and the owner sees every change you make."
      >
        <StartSupportSessionForm restaurantId={restaurantId} defaultName={support.lastName} />
      </FormDialog>
    </>
  );
}

/**
 * The payment actions on a Dues row (docs/SUPER_ADMIN_PLAN.md 12c): the same
 * dialogs as the restaurant's page.
 */
export function DuesActions({
  restaurantId,
  restaurantName,
  canExtendTrial,
  paymentStart,
  linkDefaults,
  single = false,
}: {
  restaurantId: string;
  restaurantName: string;
  canExtendTrial: boolean;
  /** The first day a new payment would cover ('YYYY-MM-DD', India). */
  paymentStart: string;
  /** Null while the Razorpay keys aren't set. */
  linkDefaults: LinkDefaults | null;
  /** One action, for Home: a payment link, or recording a payment without Razorpay. */
  single?: boolean;
}) {
  const [open, setOpen] = useState<'trial' | 'payment' | 'link' | null>(null);
  const close = () => setOpen(null);
  const size = 'h-11 md:h-8';

  return (
    <>
      {linkDefaults && (
        <Button variant="outline" className={size} onClick={() => setOpen('link')}>
          <Link2 aria-hidden />
          Send payment link
        </Button>
      )}
      {!(single && linkDefaults) && (
        <Button variant="outline" className={size} onClick={() => setOpen('payment')}>
          <CreditCard aria-hidden />
          Record payment
        </Button>
      )}
      {canExtendTrial && !single && (
        <Button variant="outline" className={size} onClick={() => setOpen('trial')}>
          <CalendarPlus aria-hidden />
          Extend trial
        </Button>
      )}
      <FormDialog
        open={open === 'trial'}
        onClose={close}
        title={`Extend trial for ${restaurantName}`}
        description={TRIAL_HELP}
      >
        <ExtendTrialForm restaurantId={restaurantId} onDone={close} />
      </FormDialog>
      <FormDialog
        open={open === 'payment'}
        onClose={close}
        title={`Record payment for ${restaurantName}`}
        description={PAYMENT_HELP}
      >
        <ManualPaymentForm restaurantId={restaurantId} start={paymentStart} onDone={close} />
      </FormDialog>
      {linkDefaults && (
        <FormDialog
          open={open === 'link'}
          onClose={close}
          title={`Send payment link to ${restaurantName}`}
          description={LINK_HELP}
        >
          <PaymentLinkForm restaurantId={restaurantId} defaults={linkDefaults} onDone={close} />
        </FormDialog>
      )}
    </>
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {open && children}
      </DialogContent>
    </Dialog>
  );
}

function applyResult<T extends FieldValues, R>(
  result: ActionResult<R>,
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
  start,
  onDone,
}: {
  restaurantId: string;
  start: string;
  onDone: () => void;
}) {
  const ids = useId();
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    control,
    formState: { errors, isSubmitting },
  } = useForm<ManualPaymentInput>({
    resolver: zodResolver(manualPaymentSchema),
    defaultValues: {
      purpose: 'subscription',
      amount: '',
      mode: 'bank_transfer',
      billingCycle: 'monthly',
      periodStart: start,
      periodEnd: periodEnd(start, 'monthly'),
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

  const purpose = useWatch({ control, name: 'purpose' });
  // The team enters what was received; the split is shown as it will be stored.
  const amountPaise = parsePriceInput(useWatch({ control, name: 'amount' }) ?? '') ?? 0;
  const split = amountPaise > 0 ? splitGst(amountPaise) : null;

  const onSubmit = handleSubmit(async (values) => {
    const result = await recordManualPayment(restaurantId, values);
    if (!applyResult(result, setError)) return;
    if (values.purpose === 'setup_fee') {
      toast.success('Setup fee recorded');
    } else if (result.ok && !result.data.extended) {
      toast.success('Payment recorded. That period was already covered, so access is unchanged.');
    } else {
      toast.success('Payment recorded');
    }
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <Field data-invalid={errors.purpose ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-purpose`}>For</FieldLabel>
        <select id={`${ids}-purpose`} className={SELECT_CLASS} {...register('purpose')}>
          <option value="subscription">Subscription</option>
          <option value="setup_fee">Setup fee</option>
        </select>
        <FieldError errors={[errors.purpose]} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field data-invalid={errors.amount ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-amount`}>Amount received, with GST (₹)</FieldLabel>
          <Input
            id={`${ids}-amount`}
            inputMode="decimal"
            className="h-9"
            placeholder="1060.82"
            aria-describedby={split ? `${ids}-split` : undefined}
            {...register('amount')}
          />
          {split && (
            <FieldDescription id={`${ids}-split`} className="tabular-nums">
              {formatINR(split.basePaise)} + GST {formatINR(split.gstPaise)}
            </FieldDescription>
          )}
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
      {purpose !== 'setup_fee' && (
        <>
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
        </>
      )}
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

/** Rupees for a form field: 149900 → "1499". */
const rupees = (paise: number) => String(paise / 100);

/** The suggested amount: the fee plus GST, like autopay (docs/DECISIONS.md W-11). */
function linkAmount(defaults: LinkDefaults, purpose: string, months: number): string {
  if (purpose === 'setup_fee') return rupees(withGst(defaults.setupFeePaise));
  if (!Number.isInteger(months) || months < 1) return '';
  return rupees(
    withGst(
      months % 12 === 0 ? (months / 12) * defaults.yearlyPaise : months * defaults.monthlyPaise,
    ),
  );
}

function linkDescription(defaults: LinkDefaults, purpose: string, months: number): string {
  if (purpose === 'setup_fee') {
    const off = defaults.setupFeeDiscountPaise;
    return off > 0
      ? `${APP_NAME} setup fee, ${formatINR(off, { fraction: 'auto' })} off, with GST`
      : `${APP_NAME} setup fee, with GST`;
  }
  return `${APP_NAME} ${defaults.planName}, ${months} ${months === 1 ? 'month' : 'months'}, with GST`;
}

function PaymentLinkForm({
  restaurantId,
  defaults,
  onDone,
}: {
  restaurantId: string;
  defaults: LinkDefaults;
  onDone: () => void;
}) {
  const ids = useId();
  const [sent, setSent] = useState<{ shortUrl: string; sentTo: string[] } | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    control,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm<PaymentLinkInput>({
    resolver: zodResolver(paymentLinkSchema),
    defaultValues: {
      purpose: 'subscription',
      months: 1,
      amount: linkAmount(defaults, 'subscription', 1),
      description: linkDescription(defaults, 'subscription', 1),
    },
  });
  const purpose = useWatch({ control, name: 'purpose' });

  // Amount and description follow the purpose and months until someone edits them.
  const refill = () => {
    const { purpose: next, months } = getValues();
    if (!dirtyFields.amount) setValue('amount', linkAmount(defaults, next, Number(months)));
    if (!dirtyFields.description) {
      setValue('description', linkDescription(defaults, next, Number(months)));
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    const result = await sendPaymentLink(restaurantId, values);
    if (!applyResult(result, setError) || !result.ok) return;
    toast.success('Payment link created');
    setSent(result.data);
  });

  if (sent) return <SentLink url={sent.shortUrl} sentTo={sent.sentTo} onDone={onDone} />;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field data-invalid={errors.purpose ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-purpose`}>For</FieldLabel>
          <select
            id={`${ids}-purpose`}
            className={SELECT_CLASS}
            {...register('purpose', { onChange: refill })}
          >
            <option value="subscription">Subscription</option>
            <option value="setup_fee">Setup fee</option>
          </select>
          <FieldError errors={[errors.purpose]} />
        </Field>
        {purpose === 'subscription' && (
          <Field data-invalid={errors.months ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-months`}>Months</FieldLabel>
            <Input
              id={`${ids}-months`}
              type="number"
              min={1}
              max={24}
              className="h-9"
              {...register('months', { onChange: refill })}
            />
            <FieldError errors={[errors.months]} />
          </Field>
        )}
      </div>
      <Field data-invalid={errors.amount ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-amount`}>Amount (₹)</FieldLabel>
        <Input id={`${ids}-amount`} inputMode="decimal" className="h-9" {...register('amount')} />
        <FieldError errors={[errors.amount]} />
      </Field>
      <Field data-invalid={errors.description ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-description`}>Description</FieldLabel>
        <Input id={`${ids}-description`} className="h-9" {...register('description')} />
        <FieldDescription>Shown to the restaurant on the payment page.</FieldDescription>
        <FieldError errors={[errors.description]} />
      </Field>
      <FormFooter pending={isSubmitting} label="Send link" error={errors.root?.message} />
    </form>
  );
}

function SentLink({ url, sentTo, onDone }: { url: string; sentTo: string[]; onDone: () => void }) {
  const ids = useId();
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error("Couldn't copy. Select the link and copy it instead.");
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor={`${ids}-url`}>Payment link</FieldLabel>
        <div className="flex gap-2">
          <Input id={`${ids}-url`} readOnly value={url} className="h-9 font-mono" />
          <Button type="button" variant="outline" onClick={copy}>
            Copy
          </Button>
        </div>
        <FieldDescription>
          {sentTo.length > 0
            ? `Razorpay has sent it to ${sentTo.join(' and ')} too.`
            : 'The restaurant has no email or phone here, so nobody has it yet: copy the link and send it yourself.'}{' '}
          The payment shows here once it is paid.
        </FieldDescription>
      </Field>
      <DialogFooter>
        <Button type="button" size="lg" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

function CancelAutopayDialog({
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
      const result = await cancelRestaurantAutopay(restaurantId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Autopay cancelled');
      onClose();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel autopay for {restaurantName}?</AlertDialogTitle>
          <AlertDialogDescription>
            Once it has charged, it stops at the end of the paid period; set up during a trial, it
            stops now and the trial carries on. Razorpay can&apos;t undo this. The owner can
            subscribe again, for example to a new plan.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep autopay</AlertDialogCancel>
          <AlertDialogAction onClick={confirm} disabled={pending}>
            Cancel autopay
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
        description="This logs the owner out on every device. Tell them the new password; it isn't shown again."
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
