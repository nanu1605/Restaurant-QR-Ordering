'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';

import { MAX_REASON } from '../schemas';
import { useStaffStrings } from '../staff-lang';

const OTHER = '__other';

type ReasonDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** Common reasons to pick with one tap (spec §13.2); "Other…" types a new one. */
  presets?: readonly string[];
  confirmLabel: string;
  destructive?: boolean;
  /** Extra fields above the reason, e.g. how many to remove. */
  children?: ReactNode;
  /** Resolves true when done (the dialog closes), false to keep it open. */
  onConfirm: (reason: string) => Promise<boolean>;
};

/** Asks for a reason before an audit-relevant action (reject, remove, close). */
export function ReasonDialog({ open, onOpenChange, ...props }: ReasonDialogProps) {
  const t = useStaffStrings();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t.close} className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        {open && <ReasonForm {...props} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function ReasonForm({
  title,
  description,
  presets = [],
  confirmLabel,
  destructive = false,
  children,
  onConfirm,
  onDone,
}: Omit<ReasonDialogProps, 'open' | 'onOpenChange'> & { onDone: () => void }) {
  const ids = useId();
  const t = useStaffStrings();
  const [choice, setChoice] = useState(presets.length > 0 ? '' : OTHER);
  const [other, setOther] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const reason = (choice === OTHER ? other : choice).trim();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason) {
      setError(t.reason.required);
      return;
    }
    setPending(true);
    const done = await onConfirm(reason);
    setPending(false);
    if (done) onDone();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold text-ink">{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>

      {children}

      <fieldset className="flex flex-col gap-2">
        <legend id={`${ids}-legend`} className="mb-2 text-sm font-semibold text-ink">
          {t.reason.legend}
        </legend>
        {presets.length > 0 && (
          <RadioGroup
            aria-labelledby={`${ids}-legend`}
            value={choice}
            onValueChange={(value) => {
              setChoice(String(value));
              setError(null);
            }}
            className="gap-2"
          >
            {[...presets, OTHER].map((preset) => (
              <label
                key={preset}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-line px-3 text-base text-ink has-data-checked:border-2 has-data-checked:border-ring"
              >
                <RadioGroupItem value={preset} />
                {preset === OTHER ? t.reason.other : t.reason.text(preset)}
              </label>
            ))}
          </RadioGroup>
        )}
        {choice === OTHER && (
          <Textarea
            aria-label={presets.length > 0 ? t.reason.otherLabel : t.reason.legend}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${ids}-error` : undefined}
            value={other}
            onChange={(event) => {
              setOther(event.target.value);
              setError(null);
            }}
            maxLength={MAX_REASON}
            rows={2}
            autoFocus={presets.length > 0}
            className="text-base"
          />
        )}
        {error && (
          <p id={`${ids}-error`} role="alert" className="text-sm font-medium text-status-void">
            {error}
          </p>
        )}
      </fieldset>

      <DialogFooter>
        <Button type="button" variant="outline" size="touch" onClick={onDone} disabled={pending}>
          {t.reason.cancel}
        </Button>
        <Button
          type="submit"
          size="touch"
          variant={destructive ? 'destructive' : 'default'}
          disabled={pending}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
