'use client';

import { Minus, Plus } from 'lucide-react';
import type { Ref } from 'react';

import { Button } from '@/components/ui/button';

import { MAX_LINE_QUANTITY } from '../limits';

type QuantityStepperProps = {
  value: number;
  onChange: (next: number) => void;
  /** Used in the button labels: "One more Paneer Tikka". */
  itemName: string;
  /** 0 lets the minus button remove the dish. */
  min?: number;
  max?: number;
  /** The "One more" button, so focus can move there when the stepper appears. */
  incrementRef?: Ref<HTMLButtonElement>;
};

/** – 1 + with 44 px targets; the count is announced when it changes. */
export function QuantityStepper({
  value,
  onChange,
  itemName,
  min = 0,
  max = MAX_LINE_QUANTITY,
  incrementRef,
}: QuantityStepperProps) {
  const removes = min === 0 && value === 1;
  return (
    <div
      role="group"
      aria-label={`Quantity of ${itemName}`}
      className="inline-flex items-center rounded-lg border border-line bg-surface"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-touch"
        onClick={() => onChange(value - 1)}
        disabled={value <= min}
        aria-label={removes ? `Remove ${itemName}` : `One less ${itemName}`}
      >
        <Minus aria-hidden />
      </Button>
      <span aria-live="polite" className="min-w-7 text-center text-base font-semibold tabular-nums">
        {value}
      </span>
      <Button
        ref={incrementRef}
        type="button"
        variant="ghost"
        size="icon-touch"
        onClick={() => onChange(value + 1)}
        disabled={value >= max}
        aria-label={`One more ${itemName}`}
      >
        <Plus aria-hidden />
      </Button>
    </div>
  );
}
