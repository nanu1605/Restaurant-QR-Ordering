'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useId, useState } from 'react';
import { useForm, type Path } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

import { createLead, findLeadMatches } from '../actions';
import {
  HAND_CHANNELS,
  LEAD_STAGE_LABELS,
  leadChannelLabel,
  newLeadSchema,
  type LeadMatches,
  type NewLeadInput,
} from '../leads';

const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm';
const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';

/**
 * A lead the team adds by hand: a field visit, call, referral or message
 * (docs/DECISIONS.md SA-55). Warns when the mobile already has a restaurant
 * or a lead; saving still works.
 */
export function NewLeadForm({
  me,
  team,
}: {
  me: string;
  team: { user_id: string; email: string }[];
}) {
  const ids = useId();
  const [matches, setMatches] = useState<LeadMatches | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<NewLeadInput>({
    resolver: zodResolver(newLeadSchema),
    defaultValues: {
      name: '',
      restaurantName: '',
      city: '',
      phone: '',
      email: '',
      channel: '' as NewLeadInput['channel'],
      stage: 'contacted',
      message: '',
      assignee: me,
    },
  });

  async function checkPhone(phone: string) {
    const digits = phone.replace(/\D/g, '');
    setMatches(digits.length >= 10 ? await findLeadMatches(phone) : null);
  }

  const submit = handleSubmit(async (values) => {
    // On success the action opens the new lead; it returns only to say why not.
    const result = await createLead(values);
    if (result.ok) return;
    for (const [key, message] of Object.entries(result.fieldErrors ?? {})) {
      setError(key as Path<NewLeadInput>, { message });
    }
    if (!result.fieldErrors) setError('root', { message: result.error });
  });

  const text = (
    name: 'name' | 'restaurantName' | 'city' | 'phone' | 'email',
    label: string,
    options: { type?: string; inputMode?: 'tel' | 'email'; autoComplete?: string; max: number },
  ) => (
    <Field data-invalid={errors[name] ? true : undefined}>
      <FieldLabel htmlFor={`${ids}-${name}`}>{label}</FieldLabel>
      <Input
        id={`${ids}-${name}`}
        type={options.type ?? 'text'}
        inputMode={options.inputMode}
        autoComplete={options.autoComplete ?? 'off'}
        maxLength={options.max}
        aria-invalid={!!errors[name]}
        className="h-11 text-base md:h-9 md:text-sm"
        {...register(name, name === 'phone' ? { onBlur: (e) => checkPhone(e.target.value) } : {})}
      />
      <FieldError errors={[errors[name]]} />
    </Field>
  );

  const known = matches && (matches.restaurants.length > 0 || matches.leads.length > 0);

  return (
    <form onSubmit={submit} noValidate className="flex max-w-2xl flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {text('name', 'Their name', { max: 80 })}
        {text('restaurantName', 'Restaurant', { max: 120 })}
        {text('city', 'City', { max: 60 })}
        {text('phone', 'Mobile number', { type: 'tel', inputMode: 'tel', max: 20 })}
      </div>
      {known && (
        <div role="status" className="rounded-md border border-line bg-paper p-3 text-sm text-ink">
          <p className="font-medium">This mobile is already known:</p>
          <ul className="mt-1 list-disc pl-5">
            {matches.restaurants.map((restaurant) => (
              <li key={restaurant.id}>
                Restaurant{' '}
                <Link href={`/super/restaurants/${restaurant.id}`} className={linkClass}>
                  {restaurant.name}
                </Link>
                {restaurant.city && `, ${restaurant.city}`}
              </li>
            ))}
            {matches.leads.map((lead) => (
              <li key={lead.id}>
                Lead{' '}
                <Link href={`/super/leads/${lead.id}`} className={linkClass}>
                  {lead.name}, {lead.restaurant_name}
                </Link>{' '}
                ({LEAD_STAGE_LABELS[lead.stage]})
              </li>
            ))}
          </ul>
          <p className="mt-1 text-ink-muted">You can still add this lead.</p>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {text('email', 'Email (optional)', { type: 'email', inputMode: 'email', max: 254 })}
        <Field data-invalid={errors.channel ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-channel`}>How did they come?</FieldLabel>
          <select
            id={`${ids}-channel`}
            className={SELECT_CLASS}
            aria-invalid={errors.channel ? true : undefined}
            {...register('channel')}
          >
            <option value="" disabled>
              Choose one
            </option>
            {HAND_CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {leadChannelLabel(channel)}
              </option>
            ))}
          </select>
          <FieldError errors={[errors.channel]} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-stage`}>Stage</FieldLabel>
          <select id={`${ids}-stage`} className={SELECT_CLASS} {...register('stage')}>
            <option value="contacted">Contacted: we have spoken</option>
            <option value="new">New: still to call</option>
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-assignee`}>Assignee</FieldLabel>
          <select id={`${ids}-assignee`} className={SELECT_CLASS} {...register('assignee')}>
            <option value="">No one</option>
            {team.map((member) => (
              <option key={member.user_id} value={member.user_id}>
                {member.email}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field data-invalid={errors.message ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-message`}>What they need (optional)</FieldLabel>
        <Textarea
          id={`${ids}-message`}
          rows={3}
          maxLength={1000}
          aria-invalid={!!errors.message}
          {...register('message')}
        />
        <FieldDescription>Only the MenuMesh team sees it.</FieldDescription>
        <FieldError errors={[errors.message]} />
      </Field>
      {errors.root && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errors.root.message}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="touch" disabled={isSubmitting}>
          {isSubmitting ? 'Adding…' : 'Add lead'}
        </Button>
      </div>
    </form>
  );
}
