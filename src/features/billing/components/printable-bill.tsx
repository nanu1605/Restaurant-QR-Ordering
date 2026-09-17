import { getPublicEnv } from '@/lib/env';
import { publicImageUrl } from '@/features/menu/images';

import type { PrintableBill } from '../bill';
import { billUpiQr } from '../upi-qr';
import { BillDocument, type BillCopy } from './bill-document';
import { PrintControls } from './print-controls';

const PRINTABLE_WIDTH = { '80mm': '72mm', '58mm': '48mm' } as const;

type PrintableBillPageProps = PrintableBill & {
  copy: BillCopy;
  backHref: string;
  backLabel: string;
  selfHref: string;
};

/**
 * A bill laid out for a thermal printer (spec §15): the paper width from Bill
 * settings, no margins, 12 px system font, black only.
 */
export async function PrintableBillPage({
  bill,
  print,
  copy,
  backHref,
  backLabel,
  selfHref,
}: PrintableBillPageProps) {
  const upi = await billUpiQr(bill, print);
  const logoUrl = bill.restaurant.logoPath
    ? publicImageUrl(getPublicEnv().NEXT_PUBLIC_SUPABASE_URL, 'logos', bill.restaurant.logoPath)
    : null;
  const width = PRINTABLE_WIDTH[print.paperWidth];

  return (
    <>
      <style>{`
        @page { size: ${print.paperWidth} auto; margin: 0; }
        @media print {
          html, body { background: #fff !important; }
          .print-toolbar { display: none !important; }
          .bill-sheet { margin: 0 auto !important; padding: 2mm 0 !important; box-shadow: none !important; border: 0 !important; }
        }
      `}</style>
      <PrintControls
        billId={bill.isSample ? null : bill.id}
        copy={copy}
        backHref={backHref}
        backLabel={backLabel}
        selfHref={selfHref}
      />
      <div className="bill-sheet mx-auto my-6 border border-line bg-white px-[3mm] py-[4mm] shadow-sm">
        <BillDocument
          bill={bill}
          print={print}
          copy={copy}
          logoUrl={logoUrl}
          upi={upi}
          className="[font-family:system-ui,sans-serif] text-[12px] leading-snug"
          style={{ width }}
        />
      </div>
    </>
  );
}
