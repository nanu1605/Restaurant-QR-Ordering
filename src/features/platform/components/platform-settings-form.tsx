'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useId } from 'react';
import { useForm, type Path } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { formatPriceInput } from '@/features/menu/schemas';

import { updatePlatformSettings } from '../actions';
import type { PlatformSettings } from '../queries';
import { platformSettingsSchema, type PlatformSettingsInput } from '../schemas';
import { discountLastDay } from '../setup-fee';

/**
 * Trial and grace days, the setup fee and its discount, and support contacts
 * (docs/DECISIONS.md SA-4, SA-5). The database audits what changed.
 */
export function PlatformSettingsForm({ settings }: { settings: PlatformSettings }) {
  const ids = useId();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
    reset,
  } = useForm<PlatformSettingsInput>({
    resolver: zodResolver(platformSettingsSchema),
    values: {
      trialDays: settings.trial_days,
      graceDays: settings.grace_days,
      setupFee: formatPriceInput(settings.setup_fee_paise),
      setupFeeDiscount: formatPriceInput(settings.setup_fee_discount_paise),
      discountLastDay: settings.setup_fee_discount_ends_at
        ? discountLastDay(settings.setup_fee_discount_ends_at)
        : '',
      supportPhone: settings.support_phone ?? '',
      supportEmail: settings.support_email ?? '',
    },
    resetOptions: { keepDirtyValues: true },
  });

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) =>
    handleSubmit(async (values) => {
      const result = await updatePlatformSettings(values);
      if (!result.ok) {
        for (const [key, message] of Object.entries(result.fieldErrors ?? {})) {
          setError(key as Path<PlatformSettingsInput>, { message });
        }
        if (!result.fieldErrors) setError('root', { message: result.error });
        return;
      }
      reset(values);
      toast.success('Settings saved');
    })(event);

  const input = (
    name: Path<PlatformSettingsInput>,
    label: string,
    options: {
      description?: string;
      inputMode?: 'decimal' | 'numeric' | 'email' | 'tel';
      type?: string;
    } = {},
  ) => {
    const error = errors[name];
    return (
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-${name}`}>{label}</FieldLabel>
        <Input
          id={`${ids}-${name}`}
          className="h-9"
          type={options.type}
          inputMode={options.inputMode}
          autoComplete="off"
          spellCheck={false}
          {...register(name)}
        />
        {options.description && <FieldDescription>{options.description}</FieldDescription>}
        <FieldError errors={[error]} />
      </Field>
    );
  };

  const group = (title: string, children: React.ReactNode) => (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <legend className="px-1 text-base font-semibold text-ink">{title}</legend>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </fieldset>
  );

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {group(
        'Trials and grace',
        <>
          {input('trialDays', 'Trial days', {
            inputMode: 'numeric',
            description: 'For new trials. Existing trials keep their end date.',
          })}
          {input('graceDays', 'Grace days after a failed payment', {
            inputMode: 'numeric',
            description: 'For payments that fail from now on.',
          })}
        </>,
      )}
      {group(
        'Setup fee',
        <>
          {input('setupFee', 'Setup fee (₹)', { inputMode: 'decimal', description: 'Before GST.' })}
          {input('setupFeeDiscount', 'Launch discount (₹)', {
            inputMode: 'decimal',
            description: '0 for none. The website shows the usual fee struck through.',
          })}
          {input('discountLastDay', 'Last day of the offer', {
            type: 'date',
            description:
              'Optional. After this day (India time) the website and new payment links show the full fee.',
          })}
        </>,
      )}
      {group(
        'Support contact',
        <>
          {input('supportEmail', 'Support email', {
            inputMode: 'email',
            description: 'Demo requests are emailed here.',
          })}
          {input('supportPhone', 'Support phone', {
            inputMode: 'tel',
            description: 'Not shown on the website yet.',
          })}
        </>,
      )}
      {errors.root?.message && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errors.root.message}
        </p>
      )}
      <div>
        <Button type="submit" size="touch" disabled={isSubmitting || !isDirty}>
          {isSubmitting ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </form>
  );
}
