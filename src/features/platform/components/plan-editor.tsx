'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useId } from 'react';
import { useForm, type Path } from 'react-hook-form';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { formatPriceInput } from '@/features/menu/schemas';
import { FEATURE_KEYS } from '@/features/plans/plan-features';

import { updatePlan } from '../actions';
import { FEATURE_LABELS, type Plan } from '../platform';
import { planFormSchema, type PlanFormInput } from '../schemas';

/**
 * One plan's prices, limits, features and Razorpay ids (spec §13.4 Plans,
 * docs/DECISIONS.md P7-10). Lower limits never switch off existing tables or
 * staff; they only stop new ones.
 */
export function PlanEditor({ plan }: { plan: Plan }) {
  const ids = useId();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
    reset,
  } = useForm<PlanFormInput>({
    resolver: zodResolver(planFormSchema),
    values: {
      name: plan.name,
      priceMonthly: formatPriceInput(plan.price_monthly_paise),
      priceYearly: formatPriceInput(plan.price_yearly_paise),
      maxTables: plan.max_tables === null ? '' : String(plan.max_tables),
      maxStaff: plan.max_staff === null ? '' : String(plan.max_staff),
      features: Object.fromEntries(
        FEATURE_KEYS.map((key) => [key, plan.features[key] === true]),
      ) as PlanFormInput['features'],
      razorpayMonthly: plan.razorpay_plan_id_monthly ?? '',
      razorpayYearly: plan.razorpay_plan_id_yearly ?? '',
      isActive: plan.is_active,
      sortOrder: plan.sort_order,
    },
    resetOptions: { keepDirtyValues: true },
  });

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) =>
    handleSubmit(async (values) => {
      const result = await updatePlan(plan.id, values);
      if (!result.ok) {
        for (const [key, message] of Object.entries(result.fieldErrors ?? {})) {
          setError(key as Path<PlanFormInput>, { message });
        }
        if (!result.fieldErrors) setError('root', { message: result.error });
        return;
      }
      reset(values);
      toast.success(`${values.name} saved`);
    })(event);

  const input = (
    name: Path<PlanFormInput>,
    label: string,
    description?: string,
    inputMode?: 'decimal' | 'numeric',
  ) => {
    const error = name
      .split('.')
      .reduce<unknown>(
        (value, key) => (value as Record<string, unknown> | undefined)?.[key],
        errors,
      ) as { message?: string } | undefined;
    return (
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-${name}`}>{label}</FieldLabel>
        <Input
          id={`${ids}-${name}`}
          className="h-9"
          inputMode={inputMode}
          autoComplete="off"
          spellCheck={false}
          {...register(name)}
        />
        {description && <FieldDescription>{description}</FieldDescription>}
        <FieldError errors={[error]} />
      </Field>
    );
  };

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-labelledby={`${ids}-title`}
      data-plan={plan.code}
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${ids}-title`} className="text-base font-semibold text-ink">
          {plan.name}
        </h2>
        <Badge variant="outline">{plan.code}</Badge>
        {!plan.is_active && <Badge variant="destructive">Switched off</Badge>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {input('name', 'Name')}
        {input('priceMonthly', 'Monthly price (₹)', undefined, 'decimal')}
        {input('priceYearly', 'Yearly price (₹)', undefined, 'decimal')}
        {input('maxTables', 'Table limit', 'Empty = unlimited.', 'numeric')}
        {input('maxStaff', 'Staff login limit', 'Besides the owner. Empty = unlimited.', 'numeric')}
        {input('sortOrder', 'Order on the plans page', undefined, 'numeric')}
        {input('razorpayMonthly', 'Razorpay plan id (monthly)', 'Set up with Razorpay in Phase 8.')}
        {input('razorpayYearly', 'Razorpay plan id (yearly)')}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-ink">Features</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURE_KEYS.map((key) => (
            <label key={key} className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" className="size-4" {...register(`features.${key}`)} />
              {FEATURE_LABELS[key]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" className="size-4" {...register('isActive')} />
        Active: can be chosen for new trials and plan changes
      </label>
      {errors.root?.message && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errors.root.message}
        </p>
      )}
      <div>
        <Button type="submit" size="touch" disabled={isSubmitting || !isDirty}>
          {isSubmitting ? 'Saving…' : `Save ${plan.name}`}
        </Button>
      </div>
    </form>
  );
}
