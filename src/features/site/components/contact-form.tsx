'use client';

import { CircleCheck } from 'lucide-react';
import { useActionState, useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import { attributionField } from '@/features/analytics/attribution';

import { submitLead, type LeadFormState } from '../actions';
import type { SiteContent, SiteLang } from '../content';
import { TurnstileWidget } from './turnstile-widget';

type State = { result: LeadFormState; round: number };
type Words = SiteContent['form'] & SiteContent['contact']['form'];

export const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** "Book a demo" (docs/DECISIONS.md W-6): stored as a lead for the platform team. */
export function ContactForm({
  t,
  lang,
  siteKey,
  plans,
  defaultPlan,
}: {
  t: Words;
  lang: SiteLang;
  siteKey: string;
  plans: Array<{ code: string; name: string }>;
  defaultPlan?: string;
}) {
  const [{ result, round }, action, pending] = useActionState(
    async (previous: State, formData: FormData): Promise<State> => ({
      result: await submitLead(previous.result, attributionField(formData)),
      round: previous.round + 1,
    }),
    { result: null, round: 0 },
  );
  const [checked, setChecked] = useState(false);
  const thanks = useRef<HTMLHeadingElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const done = result?.ok === true;

  useEffect(() => {
    if (done) thanks.current?.focus();
  }, [done]);

  // After a refusal, focus the first field to fix (its message is linked to it).
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [result]);

  if (done) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-2xl border border-status-served/40 bg-surface p-6 sm:p-8">
        <CircleCheck aria-hidden className="size-8 text-status-served" />
        <h2 ref={thanks} tabIndex={-1} className="text-xl font-bold text-ink outline-none">
          {t.thanks}
        </h2>
        <p className="text-base text-ink-muted">{t.thanksBody}</p>
      </div>
    );
  }

  const failed = result?.ok === false ? result : null;
  const value = (field: keyof NonNullable<typeof failed>['values']) => failed?.values[field] ?? '';
  const error = (field: keyof NonNullable<typeof failed>['values']) => failed?.fieldErrors?.[field];

  return (
    <form
      ref={form}
      action={action}
      noValidate
      aria-label={t.label}
      className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-4 sm:p-8"
    >
      <input type="hidden" name="lang" value={lang} />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field
          name="name"
          label={t.name}
          autoComplete="name"
          defaultValue={value('name')}
          error={error('name')}
        />
        <Field
          name="restaurantName"
          label={t.restaurantName}
          autoComplete="organization"
          defaultValue={value('restaurantName')}
          error={error('restaurantName')}
        />
        <Field
          name="city"
          label={t.city}
          autoComplete="address-level2"
          defaultValue={value('city')}
          error={error('city')}
        />
        <Field
          name="phone"
          label={t.phone}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          defaultValue={value('phone')}
          error={error('phone')}
        />
        <Field
          name="email"
          label={t.email}
          type="email"
          autoComplete="email"
          defaultValue={value('email')}
          error={error('email')}
        />
        <PlanSelect
          t={t}
          plans={plans}
          defaultValue={failed ? value('planCode') : (defaultPlan ?? '')}
        />
      </div>
      <MessageField t={t} defaultValue={value('message')} error={error('message')} />
      {/* Each submit renders a fresh check: tokens work once, and the form resets. */}
      <TurnstileWidget t={t} lang={lang} siteKey={siteKey} round={round} onReady={setChecked} />
      {failed && (failed.error || failed.fieldErrors) && (
        <p role="alert" className="text-sm font-medium text-status-void">
          {failed.error ?? t.checkFields}
        </p>
      )}
      <Button
        type="submit"
        size="touch"
        disabled={pending || !checked}
        className="sm:self-start sm:px-8"
      >
        {pending ? t.sending : t.submit}
      </Button>
      <p className="text-sm text-ink-muted">{checked ? t.privacy : t.waitForCheck}</p>
    </form>
  );
}

type FieldProps = Omit<React.ComponentProps<'input'>, 'id' | 'name'> & {
  name: string;
  label: string;
  hint?: string;
  error?: string;
};

export function Field({ name, label, hint, error, ...inputProps }: FieldProps) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ');
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {/* A new default (the values sent back after a refusal) remounts the input. */}
      <Input
        key={String(inputProps.defaultValue ?? '')}
        id={id}
        name={name}
        className="h-11 text-base"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...inputProps}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm text-status-void">
          {error}
        </p>
      )}
    </div>
  );
}

function PlanSelect({
  t,
  plans,
  defaultValue,
}: {
  t: Words;
  plans: Array<{ code: string; name: string }>;
  defaultValue: string;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{t.plan}</Label>
      <select
        key={defaultValue}
        id={id}
        name="planCode"
        defaultValue={defaultValue}
        className={SELECT_CLASS}
      >
        <option value="">{t.noPlan}</option>
        {plans.map((plan) => (
          <option key={plan.code} value={plan.code}>
            {plan.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function MessageField({
  t,
  defaultValue,
  error,
}: {
  t: Words;
  defaultValue: string;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{t.message}</Label>
      <Textarea
        key={defaultValue}
        id={id}
        name="message"
        rows={4}
        maxLength={1000}
        defaultValue={defaultValue}
        placeholder={t.messageHint}
        className="min-h-28 text-base md:text-base"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <p id={`${id}-error`} className="text-sm text-status-void">
          {error}
        </p>
      )}
    </div>
  );
}
