'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useId } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

import { startSupportSession } from '../access-actions';
import { staffNameSchema } from '../support-access';

const schema = z.object({ staffName: staffNameSchema });
type Values = z.infer<typeof schema>;

/** Starts a session in the restaurant's open window; on success, opens its admin panel. */
export function StartSupportSessionForm({
  restaurantId,
  defaultName,
}: {
  restaurantId: string;
  defaultName: string;
}) {
  const id = useId();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { staffName: defaultName },
  });
  const { errors, isSubmitting } = form.formState;

  async function submit(values: Values) {
    // On success the action goes to /admin; it returns only to say why not.
    const result = await startSupportSession(restaurantId, values.staffName);
    if (!result.ok) {
      form.setError(result.fieldErrors?.staffName ? 'staffName' : 'root', {
        message: result.fieldErrors?.staffName ?? result.error,
      });
    }
  }

  return (
    <form onSubmit={form.handleSubmit(submit)} noValidate className="flex flex-col gap-3">
      <Field data-invalid={errors.staffName ? true : undefined}>
        <FieldLabel htmlFor={`${id}-name`}>Your name</FieldLabel>
        <Input
          id={`${id}-name`}
          autoComplete="given-name"
          maxLength={40}
          className="h-11 text-base md:h-9"
          aria-invalid={!!errors.staffName}
          {...form.register('staffName')}
        />
        <FieldDescription>The restaurant sees this name, never your email.</FieldDescription>
        <FieldError errors={[errors.staffName]} />
      </Field>
      {errors.root && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errors.root.message}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="touch" disabled={isSubmitting}>
          {isSubmitting ? 'Starting…' : 'Start session'}
        </Button>
      </div>
    </form>
  );
}
