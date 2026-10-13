import { useId } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type FieldProps = Omit<React.ComponentProps<'input'>, 'id'> & {
  name: string;
  label: string;
  error?: string;
};

/** A labelled input with its error, linked for screen readers. */
export function Field({ name, label, error, ...inputProps }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {/* A new default (the values sent back after a failed login) remounts the
          input: Base UI warns when an uncontrolled default changes in place. */}
      <Input
        key={String(inputProps.defaultValue ?? '')}
        id={id}
        name={name}
        className="h-11 text-base"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...inputProps}
      />
      {error && (
        <p id={errorId} className="text-sm text-status-void">
          {error}
        </p>
      )}
    </div>
  );
}
