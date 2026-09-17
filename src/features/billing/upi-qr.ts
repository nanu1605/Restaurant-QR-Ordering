import 'server-only';

import QRCode from 'qrcode';

import { buildUpiUrl } from '@/lib/upi';

import type { BillDocument, PrintSettings } from './bill';

/**
 * The UPI QR printed on a bill (spec §11.3): pays the grand total to the
 * restaurant with the invoice number as the note. Null when the bill has no
 * QR: switched off, not in the plan, void, or nothing to pay.
 */
export async function billUpiQr(
  bill: BillDocument,
  print: PrintSettings,
): Promise<{ svg: string; payeeName: string } | null> {
  if (!print.upi || bill.status === 'void' || bill.grandTotalPaise <= 0) return null;
  const url = buildUpiUrl({
    vpa: print.upi.vpa,
    payeeName: print.upi.payeeName,
    amountPaise: bill.grandTotalPaise,
    note: bill.invoiceNumber,
  });
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
  return { svg, payeeName: print.upi.payeeName };
}
