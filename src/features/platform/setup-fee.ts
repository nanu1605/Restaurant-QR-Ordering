// The setup fee discount in force (docs/DECISIONS.md SA-5). No path aliases:
// scripts/razorpay-event.mts imports this file.

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // India has no daylight saving

type DiscountRow = {
  setup_fee_discount_paise: number;
  setup_fee_discount_ends_at: string | null;
};

/** The discount off the setup fee now: 0 once its end has passed. */
export function setupFeeDiscountPaise(row: DiscountRow, now = new Date()): number {
  const ends = row.setup_fee_discount_ends_at;
  return ends !== null && Date.parse(ends) <= now.getTime() ? 0 : row.setup_fee_discount_paise;
}

/** The offer's last day (YYYY-MM-DD, India) to when it ends: the next midnight in India. */
export function discountEndsAt(lastDay: string): string {
  return new Date(Date.parse(`${lastDay}T00:00:00+05:30`) + DAY_MS).toISOString();
}

/** When the offer ends to its last day (YYYY-MM-DD, India). */
export function discountLastDay(endsAt: string): string {
  return new Date(Date.parse(endsAt) - 1 + IST_OFFSET_MS).toISOString().slice(0, 10);
}
