/**
 * GST on what restaurants pay MenuMesh (docs/DECISIONS.md W-11): plan prices
 * and the setup fee are before GST, and every payment adds 18% (software
 * services). Restaurants' own bills have their own GST settings.
 */
export const FEE_GST_BPS = 1800; // private.fee_gst_bps() in SQL says the same (SA-8)

/** The GST on a fee, in paise, rounded to the nearest paisa. */
export const feeGst = (paise: number): number => Math.round((paise * FEE_GST_BPS) / 10_000);

/** What a payment of this fee costs with GST: 89900 → 106082. */
export const withGst = (paise: number): number => paise + feeGst(paise);

/** A payment split back into the fee and its GST, as the database stores it: 106082 → 89900 + 16182. */
export function splitGst(totalPaise: number): { basePaise: number; gstPaise: number } {
  const basePaise = Math.round((totalPaise * 10_000) / (10_000 + FEE_GST_BPS));
  return { basePaise, gstPaise: totalPaise - basePaise };
}
