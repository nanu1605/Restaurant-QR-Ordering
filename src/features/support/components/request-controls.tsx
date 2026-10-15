'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ChevronDown } from 'lucide-react';
import { useId, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

import type { ActionResult } from '@/lib/action-result';

import { updateSupportRequest } from '../inbox-actions';
import {
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABELS,
  SUPPORT_STATUS_LABELS,
  SUPPORT_STATUSES,
  supportNoteSchema,
  type SupportNoteInput,
  type SupportPriority,
  type SupportStatus,
} from '../support';

const NONE = 'none';

/** One setting, as a menu of choices; saved when chosen. */
export function ChoiceMenu({
  label,
  value,
  options,
  onChoose,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChoose: (value: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [pending, startTransition] = useTransition();
  const shown = options.find(([option]) => option === value)?.[1] ?? value;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className="h-11 max-w-full md:h-8" />}>
        <span className="truncate">
          {pending ? `Saving the ${label.toLowerCase()}…` : `${label}: ${shown}`}
        </span>
        <ChevronDown aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next: string) => {
              if (next === value) return;
              startTransition(async () => {
                const result = await onChoose(next);
                if (result.ok) toast.success(`${label} saved`);
                else toast.error(result.error);
              });
            }}
          >
            {options.map(([option, text]) => (
              <DropdownMenuRadioItem
                key={option}
                value={option}
                closeOnClick
                className="min-h-11 md:min-h-9"
              >
                {text}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Status, priority and who is on it (docs/DECISIONS.md SA-43). */
export function RequestControls({
  requestId,
  status,
  priority,
  assigneeId,
  team,
}: {
  requestId: string;
  status: SupportStatus;
  priority: SupportPriority;
  assigneeId: string | null;
  team: { user_id: string; email: string }[];
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <ChoiceMenu
        label="Status"
        value={status}
        options={SUPPORT_STATUSES.map((value) => [value, SUPPORT_STATUS_LABELS[value]])}
        onChoose={(next) => updateSupportRequest(requestId, { status: next as SupportStatus })}
      />
      <ChoiceMenu
        label="Priority"
        value={priority}
        options={SUPPORT_PRIORITIES.map((value) => [value, SUPPORT_PRIORITY_LABELS[value]])}
        onChoose={(next) => updateSupportRequest(requestId, { priority: next as SupportPriority })}
      />
      <ChoiceMenu
        label="Assignee"
        value={assigneeId ?? NONE}
        options={[
          [NONE, 'No one'],
          // A former team member still shows until someone else takes it.
          ...(assigneeId && !team.some((member) => member.user_id === assigneeId)
            ? [[assigneeId, 'A former team member'] as [string, string]]
            : []),
          ...team.map((member): [string, string] => [member.user_id, member.email]),
        ]}
        onChoose={(next) =>
          updateSupportRequest(requestId, { assignee: next === NONE ? null : next })
        }
      />
    </div>
  );
}

/**
 * An internal note; never shown to the restaurant. `save` is the server action
 * bound to what the note is on (a request, a lead).
 */
export function NoteForm({ save }: { save: (input: SupportNoteInput) => Promise<ActionResult> }) {
  const id = useId();
  const form = useForm<SupportNoteInput>({
    resolver: zodResolver(supportNoteSchema),
    defaultValues: { body: '' },
  });
  const { errors, isSubmitting } = form.formState;

  async function submit(values: SupportNoteInput) {
    const result = await save(values);
    if (!result.ok) {
      form.setError(result.fieldErrors?.body ? 'body' : 'root', {
        message: result.fieldErrors?.body ?? result.error,
      });
      return;
    }
    toast.success('Note added');
    form.reset();
  }

  return (
    <form onSubmit={form.handleSubmit(submit)} noValidate className="flex flex-col gap-3">
      <Field data-invalid={errors.body ? true : undefined}>
        <FieldLabel htmlFor={`${id}-body`}>Internal note</FieldLabel>
        <Textarea
          id={`${id}-body`}
          rows={3}
          maxLength={2000}
          aria-invalid={!!errors.body}
          {...form.register('body')}
        />
        <FieldDescription>Only the MenuMesh team sees it, never the restaurant.</FieldDescription>
        <FieldError errors={[errors.body]} />
      </Field>
      {errors.root && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errors.root.message}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="touch" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Add note'}
        </Button>
      </div>
    </form>
  );
}
