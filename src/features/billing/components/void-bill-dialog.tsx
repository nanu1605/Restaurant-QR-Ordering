'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useOffline } from '@/features/live/live-provider';
import { isUnrecognizedAction } from '@/features/new-version/stale';
import { formatClockTime, tableHeading } from '@/features/ordering/format';
import { ReasonDialog } from '@/features/orders/components/reason-dialog';

import { voidBill } from '../actions';
import { focusBillStatus } from './record-payment-dialog';
import { VOID_REASONS } from '../schemas';

type VoidBillDialogProps = {
  billId: string;
  invoiceNumber: string;
  tableLabel: string;
  /** Set while the table can be reopened: the end of the reopen window. */
  reopenUntil: string | null;
  timezone: string;
};

/**
 * Void bill (spec §13.3 Bill detail, §10.1): a reason, and "Reopen table to
 * add items" only while the reopen window is open and the table is free.
 */
export function VoidBillDialog({
  billId,
  invoiceNumber,
  tableLabel,
  reopenUntil,
  timezone,
}: VoidBillDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reopen, setReopen] = useState(false);
  const heading = tableHeading(tableLabel);
  const offline = useOffline();

  return (
    <>
      <Button
        variant="destructive"
        size="touch"
        disabled={offline}
        onClick={() => {
          setReopen(false);
          setOpen(true);
        }}
      >
        Void bill
      </Button>
      <ReasonDialog
        open={open}
        onOpenChange={setOpen}
        title={`Void ${invoiceNumber}?`}
        description="The number stays used and the bill shows as VOID in Total orders. Payments on it are voided too."
        presets={VOID_REASONS}
        confirmLabel={reopen ? 'Void and reopen table' : 'Void bill'}
        destructive
        onConfirm={async (reason) => {
          let result: Awaited<ReturnType<typeof voidBill>>;
          try {
            result = await voidBill({ billId, reason, reopen });
          } catch (error) {
            // An older build: the refresh notice explains (docs/DECISIONS.md VPS-8).
            if (!isUnrecognizedAction(error)) {
              toast.error('Couldn’t reach the server. Check the connection and try again.');
            }
            return false;
          }
          if (!result.ok) {
            toast.error(result.error);
            return false;
          }
          if (result.data.reopened) {
            toast.success(`${invoiceNumber} voided. ${heading} is open again.`);
            router.push('/admin/billing');
          } else {
            toast.success(`${invoiceNumber} voided`);
            focusBillStatus();
          }
          return true;
        }}
      >
        {reopenUntil && (
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line p-3 text-base text-ink">
            <Checkbox
              checked={reopen}
              onCheckedChange={(checked) => setReopen(checked === true)}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              Reopen table to add items
              <span className="text-sm text-ink-muted">
                {heading} opens again with its orders. Possible until{' '}
                {formatClockTime(reopenUntil, timezone)}.
              </span>
            </span>
          </label>
        )}
      </ReasonDialog>
    </>
  );
}
