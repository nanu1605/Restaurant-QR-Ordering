import type { Metadata, Viewport } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';

import { accentColors, customerThemeCss } from '@/features/ordering/accent';
import { tableHeading } from '@/features/ordering/format';
import { getCustomerTable } from '@/features/ordering/queries';

type Params = Pick<LayoutProps<'/t/[qrToken]'>, 'params'>;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const table = await getCustomerTable((await params).qrToken);
  return {
    title: {
      absolute: table
        ? `${table.restaurant.name} · ${tableHeading(table.tableLabel)}`
        : 'QR code not working',
    },
    robots: { index: false, follow: false },
  };
}

export async function generateViewport({ params }: Params): Promise<Viewport> {
  const table = await getCustomerTable((await params).qrToken);
  return table ? { themeColor: accentColors(table.restaurant.accentColor).accent } : {};
}

/**
 * Customer panel shell (spec §13.1, §16.1): the restaurant's logo, name and
 * accent colour lead; one column, max 560 px. A QR code that doesn't work
 * (unknown, switched off or regenerated) gets the not-found page.
 */
export default async function CustomerLayout({ children, params }: LayoutProps<'/t/[qrToken]'>) {
  const table = await getCustomerTable((await params).qrToken);
  if (!table) notFound();

  return (
    <div className="flex flex-1 flex-col bg-paper">
      <style>{customerThemeCss(accentColors(table.restaurant.accentColor))}</style>
      <div className="mx-auto flex w-full max-w-[560px] flex-1 flex-col bg-surface min-[561px]:border-x min-[561px]:border-line">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          {table.restaurant.logoUrl ? (
            <Image
              src={table.restaurant.logoUrl}
              alt=""
              width={40}
              height={40}
              sizes="40px"
              loading="eager"
              className="size-10 shrink-0 rounded-md object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="grid size-10 shrink-0 place-items-center rounded-md bg-primary text-lg font-semibold text-primary-foreground"
            >
              {table.restaurant.name.trim().charAt(0).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-ink">{table.restaurant.name}</p>
            <p className="text-sm text-ink-muted">{tableHeading(table.tableLabel)}</p>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
