import type { PrintableBill } from '@/features/billing/bill';
import { BillDocument } from '@/features/billing/components/bill-document';
import { publicImageUrl } from '@/features/menu/images';
import { getPublicEnv } from '@/lib/env';

/**
 * The customer copy of this phone's bill on the orders page (spec §13.1; docs/DECISIONS.md
 * P11-1…P11-3), drawn on the server so /t ships no bill code. In English and the system font,
 * as printed.
 */
export function CustomerBill({ bill, print }: PrintableBill) {
  const logoUrl = bill.restaurant.logoPath
    ? publicImageUrl(getPublicEnv().NEXT_PUBLIC_SUPABASE_URL, 'logos', bill.restaurant.logoPath)
    : null;
  return (
    <div lang="en" className="rounded-lg border border-line bg-white p-4">
      <BillDocument
        bill={bill}
        print={print}
        logoUrl={logoUrl}
        className="[font-family:system-ui,sans-serif] text-[13px] leading-snug"
      />
    </div>
  );
}
