import type { Metadata, Viewport } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';

import { setLanguage } from '@/features/ordering/actions';
import { accentColors, customerThemeCss } from '@/features/ordering/accent';
import { LangProvider } from '@/features/ordering/components/lang-provider';
import { ServiceRequestButton } from '@/features/ordering/components/service-request-button';
import { getLang } from '@/features/ordering/lang';
import { getCustomerTable } from '@/features/ordering/queries';
import { LANG_NAMES, STRINGS } from '@/features/ordering/strings';

type Params = Pick<LayoutProps<'/t/[qrToken]'>, 'params'>;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const table = await getCustomerTable((await params).qrToken);
  const t = STRINGS[await getLang()];
  return {
    title: {
      absolute: table ? `${table.restaurant.name} · ${t.table(table.tableLabel)}` : t.qrNotWorking,
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
  const { qrToken } = await params;
  const table = await getCustomerTable(qrToken);
  if (!table) notFound();
  const lang = await getLang();
  const other = lang === 'hi' ? 'en' : 'hi';

  return (
    <LangProvider lang={lang}>
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
              <div className="flex items-center gap-1 text-sm text-ink-muted">
                <span>{STRINGS[lang].table(table.tableLabel)}</span>
                <span aria-hidden>·</span>
                {/* A plain form: it switches even before the page's JavaScript has loaded. */}
                <form action={setLanguage}>
                  <input type="hidden" name="lang" value={other} />
                  <button
                    type="submit"
                    lang={other}
                    className="min-h-6 px-1 font-medium text-ink underline underline-offset-4"
                  >
                    {LANG_NAMES[other]}
                  </button>
                </form>
              </div>
            </div>
            <ServiceRequestButton
              qrToken={qrToken}
              type="call_waiter"
              className="ml-auto shrink-0"
            />
          </header>
          {children}
        </div>
      </div>
    </LangProvider>
  );
}
