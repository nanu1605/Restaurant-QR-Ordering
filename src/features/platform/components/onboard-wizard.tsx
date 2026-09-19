'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { cn } from 'cn';
import { Check, Copy } from 'lucide-react';
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import { useForm, useWatch, type Path } from 'react-hook-form';
import { toast } from 'sonner';

import { Button, buttonVariants } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { CUISINE_LABELS, CUISINE_SETS, DEFAULT_CUISINE } from '@/features/menu/default-categories';
import { bpsToPercent, GST_RATES_BPS } from '@/features/settings/schemas';

import { onboardNewRestaurant, type OnboardHandover } from '../actions';
import {
  generatePassword,
  ONBOARD_STEPS,
  onboardSchema,
  suggestRestaurantCode,
  type OnboardFormInput,
} from '../schemas';

const SELECT_CLASS =
  'h-9 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm';

const GST_MODE_LABELS = {
  none: 'Not registered for GST',
  regular: 'Regular GST',
  composition: 'Composition scheme',
} as const;

type OnboardWizardProps = {
  plans: { code: string; name: string }[];
  defaultTrialDays: number;
  loginUrl: string;
};

/**
 * Onboard a restaurant (spec §13.4): details → owner login → tax → plan and
 * trial, then one save, then the owner's login details to hand over.
 */
export function OnboardWizard({ plans, defaultTrialDays, loginUrl }: OnboardWizardProps) {
  const ids = useId();
  const [step, setStep] = useState(0);
  const [handover, setHandover] = useState<
    (OnboardHandover & { password: string; name: string }) | null
  >(null);
  // The code follows the name until someone edits it.
  const [slugEdited, setSlugEdited] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // "Create restaurant" takes Next's place, so it waits a moment after the
  // last step appears: a double-click on Next must not also create.
  const [createReady, setCreateReady] = useState(true);

  const {
    register,
    control,
    handleSubmit,
    trigger,
    setError,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<OnboardFormInput>({
    resolver: zodResolver(onboardSchema),
    defaultValues: {
      name: '',
      slug: '',
      cuisine: DEFAULT_CUISINE,
      legalName: '',
      addressLine: '',
      city: '',
      state: '',
      pincode: '',
      phone: '',
      email: '',
      ownerName: '',
      ownerUsername: 'owner',
      ownerEmail: '',
      ownerPassword: generatePassword(),
      gstMode: 'none',
      gstRateBps: 500,
      pricesIncludeTax: false,
      plan: plans.some((plan) => plan.code === 'growth') ? 'growth' : (plans[0]?.code ?? ''),
      trialDays: defaultTrialDays,
    },
  });
  const gstMode = useWatch({ control, name: 'gstMode' });
  const watched = useWatch({ control }) as OnboardFormInput;
  const current = ONBOARD_STEPS[step]!;
  const last = step === ONBOARD_STEPS.length - 1;

  function goTo(next: number) {
    if (next === ONBOARD_STEPS.length - 1) {
      setCreateReady(false);
      setTimeout(() => setCreateReady(true), 600);
    }
    setStep(next);
    // Move focus to the new step's heading so keyboard and screen reader users follow.
    requestAnimationFrame(() => headingRef.current?.focus());
  }

  async function next() {
    if (await trigger(current.fields as unknown as Path<OnboardFormInput>[])) goTo(step + 1);
  }

  const create = async (values: OnboardFormInput) => {
    const result = await onboardNewRestaurant(values);
    if (!result.ok) {
      const fields = Object.entries(result.fieldErrors ?? {});
      for (const [field, message] of fields) {
        setError(field as Path<OnboardFormInput>, { message });
      }
      if (fields.length === 0) {
        setError('root', { message: result.error });
        return;
      }
      // Back to the step that has the problem.
      const [first] = fields[0]!;
      const errorStep = ONBOARD_STEPS.findIndex((candidate) =>
        (candidate.fields as readonly string[]).includes(first),
      );
      if (errorStep >= 0) goTo(errorStep);
      return;
    }
    setHandover({ ...result.data, password: values.ownerPassword, name: values.name });
    toast.success('Restaurant created');
  };

  if (handover) {
    return (
      <Handover
        handover={handover}
        loginUrl={loginUrl}
        onAnother={() => {
          reset();
          setValue('ownerPassword', generatePassword());
          setSlugEdited(false);
          setHandover(null);
          setStep(0);
        }}
      />
    );
  }

  const field = (
    name: Path<OnboardFormInput>,
    label: string,
    props: {
      description?: string;
      type?: string;
      inputMode?: 'numeric' | 'email' | 'tel';
      autoComplete?: string;
    } = {},
  ) => {
    const error = errors[name as keyof typeof errors];
    return (
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-${name}`}>{label}</FieldLabel>
        <Input
          id={`${ids}-${name}`}
          className="h-9"
          type={props.type ?? 'text'}
          inputMode={props.inputMode}
          autoComplete={props.autoComplete ?? 'off'}
          {...register(name)}
        />
        {props.description && <FieldDescription>{props.description}</FieldDescription>}
        <FieldError errors={[error as { message?: string } | undefined]} />
      </Field>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <ol aria-label="Steps" className="flex flex-wrap gap-2">
        {ONBOARD_STEPS.map((candidate, index) => (
          <li
            key={candidate.key}
            aria-current={index === step ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-full border px-3 py-1 text-sm',
              index === step
                ? 'border-brand bg-accent font-semibold text-brand'
                : 'border-line text-ink-muted',
            )}
          >
            <span aria-hidden>{index < step ? <Check className="size-3.5" /> : index + 1}</span>
            {candidate.title}
          </li>
        ))}
      </ol>

      <form
        onSubmit={
          last
            ? (event) => {
                if (!createReady) {
                  event.preventDefault();
                  return;
                }
                void handleSubmit(create)(event);
              }
            : (event) => {
                event.preventDefault();
                void next();
              }
        }
        noValidate
        className="flex max-w-2xl flex-col gap-5 rounded-lg border border-line bg-surface p-4 md:p-6"
      >
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-ink outline-none">
          {current.title}
        </h2>

        {current.key === 'details' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field data-invalid={errors.name ? true : undefined}>
                <FieldLabel htmlFor={`${ids}-name`}>Restaurant name</FieldLabel>
                <Input
                  id={`${ids}-name`}
                  className="h-9"
                  autoComplete="off"
                  {...register('name', {
                    onChange: (event: { target: { value: string } }) => {
                      if (!slugEdited) {
                        setValue('slug', suggestRestaurantCode(event.target.value));
                      }
                    },
                  })}
                />
                <FieldError errors={[errors.name]} />
              </Field>
            </div>
            <Field data-invalid={errors.slug ? true : undefined}>
              <FieldLabel htmlFor={`${ids}-slug`}>Restaurant code</FieldLabel>
              <Input
                id={`${ids}-slug`}
                className="h-9"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                {...register('slug', { onChange: () => setSlugEdited(true) })}
              />
              <FieldDescription>
                Staff type this to log in. It can&apos;t change later.
              </FieldDescription>
              <FieldError errors={[errors.slug]} />
            </Field>
            <Field data-invalid={errors.cuisine ? true : undefined}>
              <FieldLabel htmlFor={`${ids}-cuisine`}>Starting categories</FieldLabel>
              <select id={`${ids}-cuisine`} className={SELECT_CLASS} {...register('cuisine')}>
                {CUISINE_SETS.map((set) => (
                  <option key={set} value={set}>
                    {CUISINE_LABELS[set]}
                  </option>
                ))}
              </select>
              <FieldDescription>The owner can change them in Menu.</FieldDescription>
            </Field>
            {field('legalName', 'Legal name (optional)', {
              description: 'Printed on bills when set.',
            })}
            {field('phone', 'Phone (optional)', { type: 'tel', inputMode: 'tel' })}
            <div className="sm:col-span-2">{field('addressLine', 'Address (optional)')}</div>
            {field('city', 'City (optional)')}
            {field('state', 'State (optional)')}
            {field('pincode', 'Pincode (optional)', { inputMode: 'numeric' })}
            {field('email', 'Restaurant email (optional)', { type: 'email', inputMode: 'email' })}
          </div>
        )}

        {current.key === 'owner' && (
          <div className="grid gap-4 sm:grid-cols-2">
            {field('ownerName', "Owner's name")}
            {field('ownerUsername', 'Username', {
              description: 'With the restaurant code, this is how the owner logs in.',
            })}
            <div className="sm:col-span-2">
              {field('ownerEmail', 'Owner email (optional)', {
                type: 'email',
                inputMode: 'email',
                description: 'Lets the owner log in with their email too.',
              })}
            </div>
            <div className="sm:col-span-2">
              <Field data-invalid={errors.ownerPassword ? true : undefined}>
                <FieldLabel htmlFor={`${ids}-ownerPassword`}>Temporary password</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id={`${ids}-ownerPassword`}
                    className="h-9 font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    {...register('ownerPassword')}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      setValue('ownerPassword', generatePassword(), { shouldValidate: true })
                    }
                  >
                    Generate
                  </Button>
                </div>
                <FieldDescription>Shown again at the end to hand over.</FieldDescription>
                <FieldError errors={[errors.ownerPassword]} />
              </Field>
            </div>
          </div>
        )}

        {current.key === 'tax' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${ids}-gstMode`}>GST</FieldLabel>
              <select id={`${ids}-gstMode`} className={SELECT_CLASS} {...register('gstMode')}>
                {Object.entries(GST_MODE_LABELS).map(([mode, label]) => (
                  <option key={mode} value={mode}>
                    {label}
                  </option>
                ))}
              </select>
              <FieldDescription>The owner adds the GSTIN in Settings.</FieldDescription>
            </Field>
            {gstMode !== 'none' && (
              <>
                <Field data-invalid={errors.gstRateBps ? true : undefined}>
                  <FieldLabel htmlFor={`${ids}-gstRateBps`}>GST rate</FieldLabel>
                  <select
                    id={`${ids}-gstRateBps`}
                    className={SELECT_CLASS}
                    {...register('gstRateBps', { valueAsNumber: true })}
                  >
                    {GST_RATES_BPS.map((bps) => (
                      <option key={bps} value={bps}>
                        {bpsToPercent(bps)}%
                      </option>
                    ))}
                  </select>
                  <FieldError errors={[errors.gstRateBps]} />
                </Field>
                <label className="flex items-center gap-2 text-sm text-ink sm:col-span-2">
                  <input type="checkbox" className="size-4" {...register('pricesIncludeTax')} />
                  Menu prices already include GST
                </label>
              </>
            )}
          </div>
        )}

        {current.key === 'plan' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={errors.plan ? true : undefined}>
              <FieldLabel htmlFor={`${ids}-plan`}>Plan to trial</FieldLabel>
              <select id={`${ids}-plan`} className={SELECT_CLASS} {...register('plan')}>
                {plans.map((plan) => (
                  <option key={plan.code} value={plan.code}>
                    {plan.name}
                  </option>
                ))}
              </select>
              <FieldError errors={[errors.plan]} />
            </Field>
            {field('trialDays', 'Trial days', { type: 'number', inputMode: 'numeric' })}
            <Summary
              values={watched}
              planName={plans.find((plan) => plan.code === watched.plan)?.name}
            />
          </div>
        )}

        {errors.root?.message && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {errors.root.message}
          </p>
        )}

        <div className="flex flex-wrap justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={step === 0}
            onClick={() => goTo(step - 1)}
          >
            Back
          </Button>
          <Button type="submit" size="touch" disabled={isSubmitting || (last && !createReady)}>
            {last ? (isSubmitting ? 'Creating…' : 'Create restaurant') : 'Next'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Summary({ values, planName }: { values: OnboardFormInput; planName?: string }) {
  return (
    <dl
      aria-label="Summary"
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-muted p-3 text-sm sm:col-span-2"
    >
      <dt className="text-ink-muted">Restaurant</dt>
      <dd className="text-ink">
        {values.name} ({values.slug.trim().toLowerCase()})
      </dd>
      <dt className="text-ink-muted">Owner</dt>
      <dd className="text-ink">
        {values.ownerName}, username {values.ownerUsername}
      </dd>
      <dt className="text-ink-muted">GST</dt>
      <dd className="text-ink">{GST_MODE_LABELS[values.gstMode]}</dd>
      <dt className="text-ink-muted">Trial</dt>
      <dd className="text-ink">
        {planName ?? values.plan}, {String(values.trialDays)} days
      </dd>
    </dl>
  );
}

function Handover({
  handover,
  loginUrl,
  onAnother,
}: {
  handover: OnboardHandover & { password: string; name: string };
  loginUrl: string;
  onAnother: () => void;
}) {
  const lines = [
    `${handover.name}`,
    `Log in at ${loginUrl}`,
    `Restaurant code: ${handover.slug}`,
    `Username: ${handover.ownerUsername}`,
    ...(handover.ownerEmail ? [`Or email: ${handover.ownerEmail}`] : []),
    `Password: ${handover.password}`,
  ];

  async function copy() {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.success('Login details copied');
    } catch {
      toast.error("Couldn't copy. Select the details and copy them instead.");
    }
  }

  return (
    <section
      aria-labelledby="handover-title"
      className="flex max-w-xl flex-col gap-4 rounded-lg border-2 border-brand bg-surface p-4 md:p-6"
    >
      <h2 id="handover-title" className="text-lg font-semibold text-ink">
        {handover.name} is ready
      </h2>
      <p className="text-sm text-ink-muted">
        Give these login details to the owner. The password isn&apos;t shown again; you can set a
        new one from the restaurant page.
      </p>
      <dl aria-label="Owner login" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <dt className="text-ink-muted">Log in at</dt>
        <dd className="font-medium break-all text-ink">{loginUrl}</dd>
        <dt className="text-ink-muted">Restaurant code</dt>
        <dd className="font-mono font-medium text-ink">{handover.slug}</dd>
        <dt className="text-ink-muted">Username</dt>
        <dd className="font-mono font-medium text-ink">{handover.ownerUsername}</dd>
        {handover.ownerEmail && (
          <>
            <dt className="text-ink-muted">Or email</dt>
            <dd className="font-medium break-all text-ink">{handover.ownerEmail}</dd>
          </>
        )}
        <dt className="text-ink-muted">Password</dt>
        <dd className="font-mono font-medium text-ink">{handover.password}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="touch" onClick={copy}>
          <Copy aria-hidden />
          Copy login details
        </Button>
        <Link
          href={`/super/restaurants/${handover.restaurantId}`}
          className={buttonVariants({ variant: 'outline', size: 'touch' })}
        >
          Open restaurant
        </Link>
        <Button type="button" variant="ghost" size="touch" onClick={onAnother}>
          Onboard another
        </Button>
      </div>
    </section>
  );
}
