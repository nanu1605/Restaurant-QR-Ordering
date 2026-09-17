'use client';

import { AlertTriangle, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/shared/empty-state';
import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Money } from '@/components/shared/money';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { upgradeHint } from '@/features/plans/plan-features';
import { tableHeading } from '@/features/ordering/format';
import { useBoard } from '@/features/orders/use-board';
import { AssignWaiterDialog } from '@/features/sessions/components/assign-waiter-dialog';
import { dbErrorCode, type DbErrorLike } from '@/lib/db-errors';
import { ORDER_ITEM_STATUS_LABELS } from '@/lib/order-status';
import { MAX_REASON } from '@/features/orders/schemas';

import { generateBill } from '../actions';
import { type BillDraft, type DiscountChoice, type DiscountType, lineName } from '../bill';
import { discountValue } from '../schemas';
import { useBillDraft, useDebounced } from '../use-billing';
import { BillTotalsList } from './bill-totals';

const PREVIEW_DELAY_MS = 300;

const DISCOUNT_OPTIONS: { value: DiscountType; label: string }[] = [
  { value: 'none', label: 'No discount' },
  { value: 'flat', label: 'Amount (₹)' },
  { value: 'percent', label: 'Percent (%)' },
];

/**
 * The bill builder (spec §13.3 Billing, §10.5): the table's waiter, blockers,
 * read-only lines, discount and service charge with a live preview from the
 * database, then Generate bill with a confirmation.
 */
export function BillBuilder({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const ids = useId();
  const [discountType, setDiscountType] = useState<DiscountType>('none');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [applyServiceCharge, setApplyServiceCharge] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [generating, setGenerating] = useState(false);

  const typedValue = discountValue(discountType, amount);
  // A plain string, so the debounce only restarts when the choice changes.
  const choiceKey = `${discountType}:${typedValue ?? 0}:${applyServiceCharge}`;
  const settledKey = useDebounced(choiceKey, PREVIEW_DELAY_MS);
  const [settledType, settledValue, settledCharge] = settledKey.split(':');
  const choice: DiscountChoice = {
    type: settledType as DiscountType,
    value: Number(settledValue),
    applyServiceCharge: settledCharge === 'true',
  };
  const draftQuery = useBillDraft(sessionId, choice);
  const draft = draftQuery.data;
  const failure = draftQuery.error as DbErrorLike | null;
  const failureCode = failure ? dbErrorCode(failure) : null;

  // Billed from another screen meanwhile: open that bill.
  useEffect(() => {
    if (failureCode === 'ALREADY_BILLED' && failure?.details) {
      router.replace(`/admin/bills/${failure.details}`);
    }
  }, [failureCode, failure?.details, router]);

  if (
    failureCode === 'ALREADY_BILLED' ||
    failureCode === 'SESSION_NOT_OPEN' ||
    failureCode === 'NOT_FOUND'
  ) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title={failureCode === 'ALREADY_BILLED' ? 'This table was billed' : 'This table is closed'}
        description="There is nothing left to bill here."
        action={
          <Link
            href="/admin/billing"
            className={buttonVariants({ variant: 'outline', size: 'touch' })}
          >
            Back to Billing
          </Link>
        }
      />
    );
  }
  if (!draft) {
    if (draftQuery.isError) {
      return (
        <div role="alert" className="flex flex-col items-start gap-2 text-ink">
          The bill couldn’t be loaded.
          <Button variant="outline" size="touch" onClick={() => void draftQuery.refetch()}>
            Try again
          </Button>
        </div>
      );
    }
    return (
      <div role="status" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <span className="sr-only">Loading the bill…</span>
        <Skeleton className="h-72 rounded-lg" />
        <Skeleton className="h-72 rounded-lg" />
      </div>
    );
  }

  const heading = tableHeading(draft.session.tableLabel);
  const amountInvalid = discountType !== 'none' && typedValue === null;
  const needsReason = discountType !== 'none' && (typedValue ?? 0) > 0 && !reason.trim();
  const previewStale = choiceKey !== settledKey || draftQuery.isFetching;
  const blocked = draft.waitingCount > 0 || draft.lines.length === 0 || draft.waiterRequired;
  const canGenerate = !blocked && !amountInvalid && !needsReason && !previewStale && !generating;

  async function generate() {
    setGenerating(true);
    let result: Awaited<ReturnType<typeof generateBill>>;
    try {
      result = await generateBill({
        sessionId,
        discountType: choice.type,
        discountValue: choice.value,
        discountReason: reason,
        applyServiceCharge: choice.applyServiceCharge,
      });
    } catch {
      setGenerating(false);
      toast.error('Couldn’t reach the server. Check the connection and try again.');
      return;
    }
    if (!result.ok) {
      setGenerating(false);
      setConfirming(false);
      toast.error(result.error);
      void draftQuery.refetch();
      return;
    }
    if (result.data.alreadyBilled) toast.info(`${heading} was already billed. Here is its bill.`);
    router.push(`/admin/bills/${result.data.billId}`);
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-4">
        <WaiterRow draft={draft} />
        <Blockers draft={draft} />
        <section
          aria-labelledby={`${ids}-lines`}
          className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
        >
          <h2 id={`${ids}-lines`} className="text-base font-semibold text-ink">
            Dishes on the bill
          </h2>
          {draft.lines.length === 0 ? (
            <p className="text-sm text-ink-muted">Nothing to bill yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-base text-ink">
                <thead className="text-sm text-ink-muted">
                  <tr>
                    <th scope="col" className="py-1 font-medium">
                      Dish
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      Qty
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      Rate
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {draft.lines.map((line) => (
                    <tr key={`${lineName(line)}-${line.unitPricePaise}`}>
                      <td className="py-2 pr-2">
                        <span className="flex items-start gap-2">
                          <FoodTypeMark type={line.foodType} size="sm" className="mt-1" />
                          {lineName(line)}
                        </span>
                      </td>
                      <td className="py-2 text-right tabular-nums">{line.quantity}</td>
                      <td className="py-2 text-right">
                        <Money paise={line.unitPricePaise} />
                      </td>
                      <td className="py-2 text-right">
                        <Money paise={line.lineTotalPaise} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-sm text-ink-muted">
            To change dishes, use Remove dish or Delete order on{' '}
            <Link href="/admin/live" className="text-primary underline underline-offset-4">
              Live orders
            </Link>
            .
          </p>
        </section>
      </div>

      <section
        aria-labelledby={`${ids}-totals`}
        className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-3"
      >
        <h2 id={`${ids}-totals`} className="text-base font-semibold text-ink">
          Bill for {heading}
        </h2>

        <fieldset className="flex flex-col gap-2">
          <legend id={`${ids}-discount`} className="mb-1 text-sm font-semibold text-ink">
            Discount
          </legend>
          {draft.settings.discounts ? (
            <>
              <RadioGroup
                aria-labelledby={`${ids}-discount`}
                value={discountType}
                onValueChange={(value) => setDiscountType(value as DiscountType)}
                className="flex flex-wrap gap-2"
              >
                {DISCOUNT_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line px-3 text-base text-ink has-data-checked:border-2 has-data-checked:border-ring"
                  >
                    <RadioGroupItem value={option.value} />
                    {option.label}
                  </label>
                ))}
              </RadioGroup>
              {discountType !== 'none' && (
                <>
                  <label className="flex flex-col gap-1 text-sm font-medium text-ink">
                    {discountType === 'flat' ? 'Discount in rupees' : 'Discount percentage'}
                    <Input
                      inputMode="decimal"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      aria-invalid={amountInvalid && amount !== '' ? true : undefined}
                      className="h-11 text-base"
                      placeholder={discountType === 'flat' ? '100' : '10'}
                    />
                  </label>
                  {amountInvalid && amount !== '' && (
                    <p role="alert" className="text-sm font-medium text-status-void">
                      {discountType === 'flat'
                        ? 'Enter an amount in rupees, like 150 or 99.50.'
                        : 'Enter a percentage up to 100, like 10 or 12.5.'}
                    </p>
                  )}
                  <label className="flex flex-col gap-1 text-sm font-medium text-ink">
                    Reason for the discount
                    <Input
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      maxLength={MAX_REASON}
                      className="h-11 text-base"
                      placeholder="Regular guest"
                    />
                  </label>
                </>
              )}
            </>
          ) : (
            <p className="text-sm text-ink-muted">{upgradeHint('discounts')}.</p>
          )}
        </fieldset>

        {draft.settings.serviceChargeEnabled && (
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-base text-ink">
            <Checkbox
              checked={applyServiceCharge}
              onCheckedChange={(checked) => setApplyServiceCharge(checked === true)}
            />
            Add service charge (optional)
          </label>
        )}

        <div aria-live="polite" aria-busy={previewStale} className="text-base text-ink">
          <BillTotalsList
            totals={draft.totals}
            gstMode={draft.settings.gstMode}
            gstRateBps={draft.settings.gstRateBps}
            serviceChargeBps={draft.settings.serviceChargeBps}
            grandClassName="border-t border-line pt-2 text-xl"
          />
        </div>

        <Button size="touch" disabled={!canGenerate} onClick={() => setConfirming(true)}>
          Generate bill
        </Button>
        {needsReason && (
          <p className="text-sm text-ink-muted">Give a reason for the discount to continue.</p>
        )}
      </section>

      <AlertDialog open={confirming} onOpenChange={(open) => !generating && setConfirming(open)}>
        <AlertDialogContent>
          <GenerateConfirmation draft={draft} heading={heading} />
          <AlertDialogFooter>
            <AlertDialogCancel size="touch" disabled={generating}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction size="touch" onClick={() => void generate()} disabled={generating}>
              {draft.unserved.length > 0 ? 'Bill anyway' : 'Generate bill'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function GenerateConfirmation({ draft, heading }: { draft: BillDraft; heading: string }) {
  const unservedCount = draft.unserved.reduce((sum, dish) => sum + dish.quantity, 0);
  if (unservedCount === 0) {
    return (
      <AlertDialogHeader>
        <AlertDialogTitle>Generate the bill for {heading}?</AlertDialogTitle>
        <AlertDialogDescription>
          The total is <Money paise={draft.totals.grandTotalPaise} />. The table becomes free for
          the next guests.
        </AlertDialogDescription>
      </AlertDialogHeader>
    );
  }
  return (
    <AlertDialogHeader>
      <AlertDialogTitle>
        {unservedCount} {unservedCount === 1 ? 'item' : 'items'} not marked served — bill anyway?
      </AlertDialogTitle>
      <AlertDialogDescription render={<div />}>
        <p>They are still on the bill unless you remove them on Live orders.</p>
        <ul className="mt-2 list-disc pl-5 text-ink">
          {draft.unserved.map((dish, index) => (
            <li key={`${dish.name}-${index}`}>
              {dish.quantity} × {lineName(dish)} · {ORDER_ITEM_STATUS_LABELS[dish.status]}
            </li>
          ))}
        </ul>
      </AlertDialogDescription>
    </AlertDialogHeader>
  );
}

function WaiterRow({ draft }: { draft: BillDraft }) {
  const { data: board } = useBoard();
  const [open, setOpen] = useState(false);
  const table = board?.tables.find((t) => t.session?.id === draft.session.id);

  return (
    <section
      aria-label="Waiter"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3"
    >
      <span className="flex items-center gap-2 text-base text-ink">
        <UserRound aria-hidden className="size-5 text-ink-muted" />
        Waiter: <strong>{draft.waiter?.name ?? 'Unassigned'}</strong>
      </span>
      <Button
        variant={draft.waiterRequired ? 'default' : 'outline'}
        size="touch"
        disabled={!board || !table}
        onClick={() => setOpen(true)}
      >
        {draft.waiter ? 'Reassign waiter' : 'Assign waiter'}
      </Button>
      {board && table && (
        <AssignWaiterDialog
          board={board}
          sessionId={draft.session.id}
          tableLabel={table.label}
          currentWaiterId={draft.waiter?.id ?? null}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </section>
  );
}

function Blockers({ draft }: { draft: BillDraft }) {
  const notes: string[] = [];
  if (draft.waitingCount > 0) {
    notes.push(
      draft.waitingCount === 1
        ? 'An order is waiting for approval. Approve or reject it on Live orders first.'
        : `${draft.waitingCount} orders are waiting for approval. Approve or reject them on Live orders first.`,
    );
  }
  if (draft.waiterRequired) notes.push('Assign a waiter before generating the bill.');
  if (draft.lines.length === 0 && draft.waitingCount === 0) {
    notes.push('This table has nothing to bill. Close it without a bill on Live orders instead.');
  }
  if (notes.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border-2 border-attention bg-surface p-3 text-base text-ink">
      {notes.map((note) => (
        <p key={note} className="flex items-start gap-2">
          <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0 text-attention" />
          {note}
        </p>
      ))}
      {draft.waitingCount > 0 && (
        <Link href="/admin/live" className={buttonVariants({ variant: 'outline', size: 'touch' })}>
          Open Live orders
        </Link>
      )}
    </div>
  );
}
