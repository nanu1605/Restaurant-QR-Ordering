'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
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
import { Input } from '@/components/ui/input';
import { useOffline } from '@/features/live/live-provider';
import { isUnrecognizedAction } from '@/features/new-version/stale';
import { upgradeHint } from '@/features/plans/plan-features';
import { paiseToDecimalString } from '@/lib/money';

import { recordPayment } from '../actions';
import { PAYMENT_MODE_LABELS, type PaymentMode } from '../bill';
import {
  cashChange,
  checkPayments,
  MAX_PAYMENT_ROWS,
  MAX_REFERENCE,
  type PaymentFormRow,
  rupeesInput,
} from '../schemas';

const MODES: PaymentMode[] = ['cash', 'upi', 'card', 'other'];

/**
 * After a payment or a void the button that opened the dialog is gone, so
 * keyboard focus goes to the bill's status line instead of the page start.
 */
export function focusBillStatus() {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => document.getElementById('bill-status')?.focus()),
  );
}

type RecordPaymentDialogProps = {
  billId: string;
  invoiceNumber: string;
  grandTotalPaise: number;
  splitPayments: boolean;
};

/**
 * Record payment (spec §13.3): mode buttons, the amount prefilled with the
 * total, an optional reference, split rows on plans with split payments, and
 * a change calculator for cash (not stored).
 */
export function RecordPaymentDialog(props: RecordPaymentDialogProps) {
  const [open, setOpen] = useState(false);
  const offline = useOffline();
  return (
    <>
      <Button size="touch" disabled={offline} onClick={() => setOpen(true)}>
        Record payment
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          {open && <PaymentForm {...props} onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function PaymentForm({
  billId,
  invoiceNumber,
  grandTotalPaise,
  splitPayments,
  onDone,
}: RecordPaymentDialogProps & { onDone: () => void }) {
  const ids = useId();
  const [rows, setRows] = useState<PaymentFormRow[]>([
    { mode: 'cash', amount: paiseToDecimalString(grandTotalPaise), reference: '' },
  ]);
  const [received, setReceived] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const check = checkPayments(rows, grandTotalPaise);
  const remaining = grandTotalPaise - check.paidPaise;
  const cashRow = rows.length === 1 && rows[0]!.mode === 'cash' ? rows[0]! : null;
  const cashDue = cashRow ? rupeesInput(cashRow.amount) : null;
  const receivedPaise = rupeesInput(received);
  const change = cashDue === null ? null : cashChange(receivedPaise, cashDue);

  function update(index: number, patch: Partial<PaymentFormRow>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    setError(null);
  }

  function addRow() {
    setRows((current) => {
      const paid = checkPayments(current, grandTotalPaise).paidPaise;
      const left = Math.max(0, grandTotalPaise - paid);
      return [...current, { mode: 'upi', amount: paiseToDecimalString(left), reference: '' }];
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setPending(true);
    let result: Awaited<ReturnType<typeof recordPayment>>;
    try {
      result = await recordPayment({
        billId,
        payments: rows.map((row) => ({
          mode: row.mode,
          amountPaise: rupeesInput(row.amount)!,
          reference: row.reference,
        })),
      });
    } catch (error) {
      setPending(false);
      // An older build: the refresh notice explains (docs/DECISIONS.md VPS-8).
      if (!isUnrecognizedAction(error)) {
        setError('Couldn’t reach the server. Check the connection and try again.');
      }
      return;
    }
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success(`Payment recorded for ${invoiceNumber}`);
    onDone();
    focusBillStatus();
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold text-ink">Record payment</DialogTitle>
        <DialogDescription>
          {invoiceNumber} · Total <Money paise={grandTotalPaise} className="font-semibold" />
        </DialogDescription>
      </DialogHeader>

      {rows.map((row, index) => {
        const label = rows.length > 1 ? `Payment ${index + 1}` : 'Payment';
        return (
          <fieldset key={index} className="flex flex-col gap-3 rounded-lg border border-line p-3">
            <legend className="px-1 text-sm font-semibold text-ink">{label}</legend>
            <div role="group" aria-label={`${label} mode`} className="flex flex-wrap gap-2">
              {MODES.map((mode) => (
                <Button
                  key={mode}
                  type="button"
                  size="touch"
                  variant={row.mode === mode ? 'default' : 'outline'}
                  aria-pressed={row.mode === mode}
                  onClick={() => update(index, { mode })}
                >
                  {PAYMENT_MODE_LABELS[mode]}
                </Button>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm font-medium text-ink">
                Amount (₹)
                <Input
                  inputMode="decimal"
                  value={row.amount}
                  onChange={(event) => update(index, { amount: event.target.value })}
                  className="h-11 text-base tabular-nums"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium text-ink">
                Reference (optional)
                <Input
                  value={row.reference}
                  onChange={(event) => update(index, { reference: event.target.value })}
                  maxLength={MAX_REFERENCE}
                  placeholder={row.mode === 'upi' ? 'UPI transaction ID' : ''}
                  className="h-11 text-base"
                />
              </label>
            </div>
            {rows.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="touch"
                className="self-start"
                onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
              >
                <Trash2 aria-hidden /> Remove {label.toLowerCase()}
              </Button>
            )}
          </fieldset>
        );
      })}

      {splitPayments ? (
        rows.length < MAX_PAYMENT_ROWS && (
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={addRow}
            className="self-start"
          >
            <Plus aria-hidden /> Split payment
          </Button>
        )
      ) : (
        <p className="text-sm text-ink-muted">Split payment: {upgradeHint('split_payments')}.</p>
      )}

      {rows.length > 1 && (
        <p aria-live="polite" className="text-base text-ink">
          {remaining === 0 ? (
            'Payments add up to the total.'
          ) : remaining > 0 ? (
            <>
              Still to pay: <Money paise={remaining} className="font-semibold" />
            </>
          ) : (
            <>
              Over the total by <Money paise={-remaining} className="font-semibold" />
            </>
          )}
        </p>
      )}

      {cashRow && (
        <div className="flex flex-col gap-2 rounded-lg bg-muted p-3">
          <label htmlFor={`${ids}-received`} className="text-sm font-medium text-ink">
            Cash received (₹)
          </label>
          <Input
            id={`${ids}-received`}
            inputMode="decimal"
            value={received}
            onChange={(event) => setReceived(event.target.value)}
            className="h-11 bg-surface text-base tabular-nums"
          />
          <p aria-live="polite" className="text-base text-ink">
            {change !== null ? (
              <>
                Change to return: <Money paise={change} className="text-lg font-bold" />
              </>
            ) : receivedPaise !== null && cashDue !== null ? (
              <>
                Short by <Money paise={cashDue - receivedPaise} className="text-lg font-bold" />
              </>
            ) : (
              'Enter the cash handed over to see the change.'
            )}
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm font-medium text-status-void">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" size="touch" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" size="touch" disabled={pending}>
          Record payment
        </Button>
      </DialogFooter>
    </form>
  );
}
