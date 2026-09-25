import { cn } from 'cn';
import type { CSSProperties } from 'react';

import { Money } from '@/components/shared/money';
import { formatBillDate } from '@/features/ordering/format';
import { APP_NAME } from '@/lib/config';
import { amountInWords, formatINR } from '@/lib/money';

import { type BillDocument as Bill, DOCUMENT_TITLES, lineName, type PrintSettings } from '../bill';
import { BillTotalsList } from './bill-totals';

export type BillCopy = 'customer' | 'office';

type BillDocumentProps = {
  bill: Bill;
  print: PrintSettings;
  copy?: BillCopy;
  logoUrl?: string | null;
  upi?: { svg: string; payeeName: string } | null;
  className?: string;
  style?: CSSProperties;
};

/**
 * The bill as printed and shown on screen (spec §11.3, §15): black text only,
 * so it prints cleanly on thermal paper. The customer copy says "Discount"; the
 * office copy adds the reason and who generated the bill.
 */
export function BillDocument({
  bill,
  print,
  copy = 'customer',
  logoUrl,
  upi,
  className,
  style,
}: BillDocumentProps) {
  const r = bill.restaurant;
  const address = [r.addressLine, r.city, [r.state, r.pincode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const office = copy === 'office';

  return (
    <article
      aria-label={`${DOCUMENT_TITLES[bill.documentType]} ${bill.invoiceNumber}`}
      className={cn('flex flex-col gap-2 bg-white text-black', className)}
      style={style}
    >
      <header className="flex flex-col items-center gap-0.5 text-center">
        {logoUrl && (
          // Plain img: prints reliably and the logo is already small.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="mb-1 max-h-14 max-w-[60%] object-contain" />
        )}
        <p className="text-[1.25em] leading-tight font-bold">{r.name}</p>
        {r.legalName && r.legalName !== r.name && <p>{r.legalName}</p>}
        {address && <p>{address}</p>}
        {r.phone && <p>Phone: {r.phone}</p>}
        {r.gstin && <p>GSTIN: {r.gstin}</p>}
        {r.fssaiLicense && <p>FSSAI Lic. No.: {r.fssaiLicense}</p>}
      </header>

      <Rule />
      <div className="text-center">
        <h2 className="text-[1.15em] font-bold tracking-wide uppercase">
          {DOCUMENT_TITLES[bill.documentType]}
        </h2>
        {bill.status === 'void' && <p className="text-[1.15em] font-bold">VOID</p>}
        {bill.isSample && <p className="font-bold">TEST PRINT — NOT A BILL</p>}
        {office && <p>Office copy</p>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2">
        <dt>Invoice no.</dt>
        <dd className="text-right font-semibold">{bill.invoiceNumber}</dd>
        <dt>Date</dt>
        <dd className="text-right">{formatBillDate(bill.generatedAt, print.timezone)}</dd>
        <dt>Table</dt>
        <dd className="text-right">{bill.tableLabel}</dd>
        {print.printWaiterOnBill && bill.waiterName && (
          <>
            <dt>Served by</dt>
            <dd className="text-right">{bill.waiterName}</dd>
          </>
        )}
      </dl>

      <Rule />
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left">
            <th scope="col" className="pb-1 font-semibold">
              Item
            </th>
            <th scope="col" className="pb-1 text-right font-semibold">
              Qty
            </th>
            <th scope="col" className="pb-1 text-right font-semibold">
              Rate
            </th>
            <th scope="col" className="pb-1 text-right font-semibold">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {bill.lines.map((line, index) => (
            <tr key={index} className="align-top">
              <td className="py-0.5 pr-1">{lineName(line)}</td>
              <td className="py-0.5 text-right tabular-nums">{line.quantity}</td>
              <td className="py-0.5 pl-1 text-right">
                <Money paise={line.unitPricePaise} fraction="auto" />
              </td>
              <td className="py-0.5 pl-1 text-right">
                <Money paise={line.lineTotalPaise} fraction="auto" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Rule />
      <BillTotalsList
        totals={bill}
        gstMode={bill.gstMode}
        gstRateBps={bill.gstRateBps}
        serviceChargeBps={bill.serviceChargeBps}
        discountNote={office ? bill.discountReason : null}
        grandClassName="mt-1 border-t border-dashed border-black pt-1 text-[1.4em]"
      />
      <p className="text-center italic">{amountInWords(bill.grandTotalPaise)}</p>
      {bill.gstMode === 'composition' && (
        <p className="text-center">
          Composition taxable person, not eligible to collect tax on supplies.
        </p>
      )}

      {(upi || r.footer || office || print.showBranding) && <Rule />}
      {upi && (
        <figure className="flex flex-col items-center gap-1">
          <div
            aria-hidden
            className="w-[36mm] max-w-full [&_svg]:h-auto [&_svg]:w-full"
            dangerouslySetInnerHTML={{ __html: upi.svg }}
          />
          <figcaption className="text-center">
            Scan to pay {formatINR(bill.grandTotalPaise, { fraction: 'auto' })} to {upi.payeeName}
          </figcaption>
        </figure>
      )}
      {r.footer && <p className="text-center">{r.footer}</p>}
      {office && <p className="text-center">Generated by {bill.generatedByName ?? 'staff'}</p>}
      {print.showBranding && <p className="text-center text-[0.85em]">Powered by {APP_NAME}</p>}
    </article>
  );
}

function Rule() {
  return <hr aria-hidden className="border-0 border-t border-dashed border-black" />;
}
