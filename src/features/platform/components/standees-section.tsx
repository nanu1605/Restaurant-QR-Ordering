'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useId, useState, useTransition } from 'react';
import { useForm, type FieldError as FormFieldError } from 'react-hook-form';
import { toast } from 'sonner';

import { Money } from '@/components/shared/money';
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
import { Textarea } from '@/components/ui/textarea';

import { formatDate } from '../platform';
import { markStandeeStep, saveStandees } from '../standee-actions';
import {
  NEXT_STEP_LABELS,
  nextStep,
  STANDEE_STATUS_LABELS,
  standeeForm,
  standeeSchema,
  type StandeeDetail,
  type StandeeInput,
  type StandeeStatus,
} from '../standees';
import { Facts, Section } from './restaurant-sections';

const noon = (day: string | null) => (day ? `${day}T12:00:00+05:30` : null);

/**
 * A restaurant's standees on its page (docs/DECISIONS.md SA-84, SA-85): the
 * steps with their days, vendor, cost for money roles, and the setup fee.
 */
export function StandeesSection({
  restaurantId,
  detail,
  today,
  can,
}: {
  restaurantId: string;
  detail: StandeeDetail;
  today: string;
  can: { manage: boolean; record: boolean; money: boolean };
}) {
  const [open, setOpen] = useState(false);
  const record = detail.standees;
  // Money roles set the cost once the record is made (SA-85).
  const canEdit = can.manage || (can.record && record !== null);
  const fee = detail.setup_fee;

  return (
    <Section
      title="Standees"
      action={
        canEdit && (
          <Button variant="outline" size="touch" onClick={() => setOpen(true)}>
            {record ? 'Change' : 'Add'}
          </Button>
        )
      }
    >
      <Facts
        label="Standees"
        facts={[
          ['Status', record ? STANDEE_STATUS_LABELS[record.status] : 'Not started'],
          [
            'How many',
            record ? record.quantity : `One per active table (${detail.tables_active} now)`,
          ],
          ...(record
            ? ([
                ['Printed', formatDate(noon(record.printed_on))],
                ['Dispatched', formatDate(noon(record.dispatched_on))],
                ['Delivered', formatDate(noon(record.delivered_on))],
                ['Installed', formatDate(noon(record.installed_on))],
                ['Vendor', record.vendor ?? '—'],
              ] as [string, React.ReactNode][])
            : []),
          ...(record && can.money
            ? ([
                [
                  'Cost',
                  record.cost_paise === null ? (
                    '—'
                  ) : (
                    <Money paise={record.cost_paise} fraction="auto" />
                  ),
                ],
              ] as [string, React.ReactNode][])
            : []),
          [
            'Setup fee',
            fee ? (
              <>
                Paid {formatDate(fee.paid_at)}
                {fee.amount_paise !== null && (
                  <>
                    {' '}
                    (<Money paise={fee.amount_paise} fraction="auto" />)
                  </>
                )}
              </>
            ) : (
              'Not paid'
            ),
          ],
          ...(record?.notes
            ? ([
                [
                  'Notes',
                  <span key="notes" className="whitespace-pre-line">
                    {record.notes}
                  </span>,
                ],
              ] as [string, React.ReactNode][])
            : []),
        ]}
      />
      {can.manage && (
        <StepButton restaurantId={restaurantId} status={record?.status ?? 'not_started'} />
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-dvh overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Standees</DialogTitle>
            <DialogDescription>
              Each step&apos;s day (India). Clearing a day takes the status back.
            </DialogDescription>
          </DialogHeader>
          {open && (
            <StandeeForm
              restaurantId={restaurantId}
              defaults={standeeForm(detail, today)}
              can={can}
              onDone={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </Section>
  );
}

/** Marks the next step today: one click from the tracker or the page. */
export function StepButton({
  restaurantId,
  status,
  name,
}: {
  restaurantId: string;
  status: StandeeStatus | 'not_started';
  /** For the button's accessible name in a list. */
  name?: string;
}) {
  const [pending, startTransition] = useTransition();
  const step = nextStep(status);
  if (!step) return null;
  const label = NEXT_STEP_LABELS[step];
  return (
    <Button
      variant="outline"
      size="touch"
      className="self-start"
      disabled={pending}
      aria-label={name ? `${label}: ${name}` : undefined}
      onClick={() =>
        startTransition(async () => {
          const result = await markStandeeStep(restaurantId, step);
          if (result.ok)
            toast.success(
              step === 'start' ? 'Standees to print' : `${label.replace('Mark ', '')} today`,
            );
          else toast.error(result.error);
        })
      }
    >
      {step === 'start' ? 'Start: to print' : `${label} today`}
    </Button>
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

function StandeeForm({
  restaurantId,
  defaults,
  can,
  onDone,
}: {
  restaurantId: string;
  defaults: StandeeInput;
  can: { manage: boolean; record: boolean };
  onDone: () => void;
}) {
  const ids = useId();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<StandeeInput>({ resolver: zodResolver(standeeSchema), defaultValues: defaults });

  const onSubmit = handleSubmit(async (values) => {
    const result = await saveStandees(restaurantId, values);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
        setError(field as keyof StandeeInput, { message });
      }
      if (!result.fieldErrors) setError('root', { message: result.error });
      return;
    }
    toast.success('Standees saved');
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        {can.manage && (
          <>
            <TextField
              id={`${ids}-quantity`}
              label="How many"
              inputMode="numeric"
              error={errors.quantity}
              {...register('quantity')}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id={`${ids}-printed`}
                label="Printed on"
                type="date"
                max={defaults.today}
                error={errors.printedOn}
                {...register('printedOn')}
              />
              <TextField
                id={`${ids}-dispatched`}
                label="Dispatched on"
                type="date"
                max={defaults.today}
                error={errors.dispatchedOn}
                {...register('dispatchedOn')}
              />
              <TextField
                id={`${ids}-delivered`}
                label="Delivered on"
                type="date"
                max={defaults.today}
                description="Completes the QR step of onboarding."
                error={errors.deliveredOn}
                {...register('deliveredOn')}
              />
              <TextField
                id={`${ids}-installed`}
                label="Installed on"
                type="date"
                max={defaults.today}
                error={errors.installedOn}
                {...register('installedOn')}
              />
            </div>
            <TextField
              id={`${ids}-vendor`}
              label="Vendor (optional)"
              autoComplete="off"
              error={errors.vendor}
              {...register('vendor')}
            />
            <Field data-invalid={errors.notes ? true : undefined}>
              <FieldLabel htmlFor={`${ids}-notes`}>Notes (optional)</FieldLabel>
              <Textarea
                id={`${ids}-notes`}
                rows={3}
                aria-invalid={errors.notes ? true : undefined}
                {...register('notes')}
              />
              <FieldError errors={[errors.notes]} />
            </Field>
          </>
        )}
        {can.record && (
          <TextField
            id={`${ids}-cost`}
            label="Cost in rupees (optional)"
            inputMode="decimal"
            description="What MenuMesh paid for them; only money roles see it."
            error={errors.cost}
            {...register('cost')}
          />
        )}
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
