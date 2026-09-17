import { paiseToDecimalString, type Paise } from './money';

/** UPI ID (VPA) as the database accepts it, e.g. "cafe.name@okicici". */
export const UPI_VPA_PATTERN = /^[A-Za-z0-9._-]{2,255}@[A-Za-z0-9.-]{2,64}$/;

/**
 * A UPI deep link (NPCI "upi://pay") for the QR printed on bills (spec §13.3
 * Bill settings). Without an amount the payer types it in, which is what the
 * settings preview shows; bills add the grand total.
 */
export function buildUpiUrl({
  vpa,
  payeeName,
  amountPaise,
  note,
}: {
  vpa: string;
  payeeName?: string | null;
  amountPaise?: Paise;
  note?: string;
}): string {
  // As in spec §11.3: the VPA as it is (its pattern allows only URL-safe
  // characters and @); the payee name and note are encoded.
  const params = [`pa=${vpa.trim()}`];
  if (payeeName?.trim()) params.push(`pn=${encodeURIComponent(payeeName.trim())}`);
  if (amountPaise !== undefined) params.push(`am=${paiseToDecimalString(amountPaise)}`);
  params.push('cu=INR');
  if (note?.trim()) params.push(`tn=${encodeURIComponent(note.trim())}`);
  return `upi://pay?${params.join('&')}`;
}
