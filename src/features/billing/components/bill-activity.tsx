import { cn } from 'cn';

import { Money } from '@/components/shared/money';
import { formatBillDate, formatClockTime } from '@/features/ordering/format';

import { type AuditEntry, type BillDetail, PAYMENT_MODE_LABELS } from '../bill';

const STATUS_STYLES = {
  unpaid: 'border-attention text-attention',
  paid: 'border-status-served bg-status-served text-white',
  void: 'border-status-void bg-status-void text-white',
} as const;

const STATUS_LABELS = { unpaid: 'Unpaid', paid: 'Paid', void: 'Void' } as const;

/** Unpaid / Paid / Void, as text and colour (spec §16 colour is never the only signal). */
export function BillStatusBadge({
  status,
  paymentStatus,
  className,
}: {
  status: BillDetail['bill']['status'];
  paymentStatus: BillDetail['bill']['paymentStatus'];
  className?: string;
}) {
  const key = status === 'void' ? 'void' : paymentStatus;
  return (
    <span
      className={cn(
        'inline-flex h-8 items-center rounded-full border-2 px-3 text-base font-semibold',
        STATUS_STYLES[key],
        className,
      )}
    >
      {STATUS_LABELS[key]}
    </span>
  );
}

/** Payments on the bill, newest last; void ones struck through. */
export function BillPayments({ detail }: { detail: BillDetail }) {
  const { bill, payments, print } = detail;
  return (
    <section
      aria-labelledby="bill-payments"
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
    >
      <h2 id="bill-payments" className="text-base font-semibold text-ink">
        Payments
      </h2>
      {payments.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {bill.status === 'void' ? 'No payment was recorded.' : 'Not paid yet.'}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {payments.map((payment) => (
            <li
              key={payment.id}
              className={cn(
                'flex flex-wrap items-baseline justify-between gap-2 py-2 text-base text-ink',
                payment.isVoid && 'text-ink-muted line-through',
              )}
            >
              <span className="flex flex-col">
                <span className="font-medium">
                  {PAYMENT_MODE_LABELS[payment.mode]}
                  {payment.reference && ` · ${payment.reference}`}
                </span>
                <span className="text-sm text-ink-muted">
                  {formatClockTime(payment.createdAt, print.timezone)}
                  {payment.recordedByName && ` by ${payment.recordedByName}`}
                  {payment.isVoid && ' · voided'}
                </span>
              </span>
              <Money paise={payment.amountPaise} className="font-semibold" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const ACTION_LABELS: Record<string, string> = {
  'bill.generated': 'Bill generated',
  'discount.applied': 'Discount applied',
  'payment.recorded': 'Payment recorded',
  'bill.voided': 'Bill voided',
  'session.reopened': 'Table reopened',
  'session.closed_unbilled': 'Closed without bill',
  'waiter.assigned': 'Waiter assigned',
  'waiter.reassigned': 'Waiter reassigned',
  'waiter.unassigned': 'Waiter unassigned',
};

function describe(entry: AuditEntry): string {
  const label =
    ACTION_LABELS[entry.action] ??
    entry.action.replace(/[._]/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase());
  const waiter = entry.after?.waiter_name;
  return typeof waiter === 'string' && entry.action.startsWith('waiter.')
    ? `${label}: ${waiter}`
    : label;
}

/** Who did what to this bill and its table session (docs/DECISIONS.md P5-15). */
export function BillAuditTrail({ detail }: { detail: BillDetail }) {
  const timezone = detail.print.timezone;
  return (
    <section
      aria-labelledby="bill-audit"
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
    >
      <h2 id="bill-audit" className="text-base font-semibold text-ink">
        History
      </h2>
      {detail.audit.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing recorded yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {detail.audit.map((entry) => (
            <li key={entry.id} className="flex flex-col text-sm text-ink">
              <span className="font-medium">{describe(entry)}</span>
              <span className="text-ink-muted">
                {formatBillDate(entry.createdAt, timezone)} · {entry.actorLabel}
                {entry.reason && ` · ${entry.reason}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
