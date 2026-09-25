import { ArrowLeft, Printer } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/shared/page-header';
import { buttonVariants } from '@/components/ui/button';
import {
  BillAuditTrail,
  BillPayments,
  BillStatusBadge,
} from '@/features/billing/components/bill-activity';
import { BillDocument } from '@/features/billing/components/bill-document';
import { RecordPaymentDialog } from '@/features/billing/components/record-payment-dialog';
import { VoidBillDialog } from '@/features/billing/components/void-bill-dialog';
import { getBill } from '@/features/billing/queries';
import { billUpiQr } from '@/features/billing/upi-qr';
import { publicImageUrl } from '@/features/menu/images';
import { formatBillDate, tableHeading } from '@/features/ordering/format';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';
import { getPublicEnv } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Bill',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bill detail (spec §13.3): the bill, its status and payments, history, print and void. */
export default async function BillDetailPage({ params }: PageProps<'/admin/bills/[billId]'>) {
  await requireMember(ADMIN_PANEL_ROLES);
  const { billId } = await params;
  if (!UUID.test(billId)) notFound();
  const detail = await getBill(billId);
  if (!detail) notFound();

  const { bill, print, reopen } = detail;
  const upi = await billUpiQr(bill, print);
  const logoUrl = bill.restaurant.logoPath
    ? publicImageUrl(getPublicEnv().NEXT_PUBLIC_SUPABASE_URL, 'logos', bill.restaurant.logoPath)
    : null;
  const active = bill.status === 'active';

  return (
    <>
      <PageHeader
        title={`Bill ${bill.invoiceNumber}`}
        description={`${tableHeading(bill.tableLabel)} · ${formatBillDate(bill.generatedAt, print.timezone)}${
          bill.generatedByName ? ` · by ${bill.generatedByName}` : ''
        }`}
        actions={
          <>
            <Link
              href="/admin/billing"
              className={buttonVariants({ variant: 'outline', size: 'touch' })}
            >
              <ArrowLeft aria-hidden /> Billing
            </Link>
            <Link
              href={`/admin/bills/${bill.id}/print`}
              target="_blank"
              className={buttonVariants({ variant: 'outline', size: 'touch' })}
            >
              <Printer aria-hidden /> Print
            </Link>
            {active && bill.paymentStatus === 'unpaid' && (
              <RecordPaymentDialog
                billId={billId}
                invoiceNumber={bill.invoiceNumber}
                grandTotalPaise={bill.grandTotalPaise}
                splitPayments={detail.splitPayments}
              />
            )}
            {active && (
              <VoidBillDialog
                billId={billId}
                invoiceNumber={bill.invoiceNumber}
                tableLabel={bill.tableLabel}
                reopenUntil={reopen.allowed ? reopen.until : null}
                timezone={print.timezone}
              />
            )}
          </>
        }
      />

      <div
        id="bill-status"
        tabIndex={-1}
        className="flex flex-wrap items-center gap-3 rounded-md text-base text-ink focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <BillStatusBadge status={bill.status} paymentStatus={bill.paymentStatus} />
        {bill.status === 'void' && (
          <span>
            Voided{bill.voidedByName && ` by ${bill.voidedByName}`}
            {bill.voidedAt && ` · ${formatBillDate(bill.voidedAt, print.timezone)}`}
            {bill.voidReason && ` · ${bill.voidReason}`}
          </span>
        )}
        <span className="text-sm text-ink-muted">
          Printed {bill.printCount} {bill.printCount === 1 ? 'time' : 'times'}
        </span>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-label="Bill preview" className="overflow-x-auto rounded-lg bg-muted p-4">
          <BillDocument
            bill={bill}
            print={print}
            copy="office"
            logoUrl={logoUrl}
            upi={upi}
            className="mx-auto w-full max-w-sm rounded-md p-4 text-sm shadow-sm"
          />
        </section>
        <div className="flex flex-col gap-4">
          <BillPayments detail={detail} />
          <BillAuditTrail detail={detail} />
        </div>
      </div>
    </>
  );
}
