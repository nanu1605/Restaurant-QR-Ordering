import { CircleCheck, CircleX } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Money } from '@/components/shared/money';
import { buttonVariants } from '@/components/ui/button';
import { DEFAULT_LOCALE, DEFAULT_TIMEZONE } from '@/lib/config';

import { markExistingItems } from '../merge';
import { isPhotoImportEnabled } from '../providers';
import {
  getCurrentMenu,
  getMenuImport,
  listMenuImports,
  pageImageUrls,
  type ImportStatus,
  type ImportSummary,
} from '../queries';

import { ImportProgress } from './import-progress';
import { ImportStart } from './import-start';
import { ReviewScreen } from './review-screen';

/**
 * The import pages shared by the owner's Menu page and super-admin (spec
 * §20A, docs/DECISIONS.md P7-19): start an import, read it, review it.
 */

const STATUS_LABELS: Record<ImportStatus, string> = {
  uploaded: 'Reading',
  processing: 'Reading',
  review: 'Waiting for your check',
  imported: 'Imported',
  failed: 'Could not be read',
  discarded: 'Discarded',
};

const dateTime = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
  timeZone: DEFAULT_TIMEZONE,
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

export async function ImportStartView({
  restaurantId,
  importBasePath,
  readOnly,
  showCost = false,
}: {
  restaurantId: string;
  importBasePath: string;
  readOnly: boolean;
  /** Platform admins see what each import cost (P7-13). */
  showCost?: boolean;
}) {
  const imports = await listMenuImports(restaurantId);
  return (
    <>
      {readOnly ? (
        <p className="rounded-lg border border-line bg-surface p-4 text-sm text-ink">
          Imports are paused while the subscription is inactive.
        </p>
      ) : (
        <ImportStart
          restaurantId={restaurantId}
          importBasePath={importBasePath}
          photoEnabled={isPhotoImportEnabled()}
        />
      )}
      {imports.length > 0 && (
        <ImportList imports={imports} importBasePath={importBasePath} showCost={showCost} />
      )}
    </>
  );
}

function ImportList({
  imports,
  importBasePath,
  showCost,
}: {
  imports: ImportSummary[];
  importBasePath: string;
  showCost: boolean;
}) {
  return (
    <section
      aria-label="Recent imports"
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
    >
      <h2 className="text-base font-semibold text-ink">Recent imports</h2>
      <ul className="flex flex-col divide-y divide-line">
        {imports.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <Link
              href={`${importBasePath}/${item.id}`}
              className="font-medium text-brand underline-offset-4 hover:underline"
            >
              {item.source === 'photo'
                ? `Photos, ${item.pageCount} ${item.pageCount === 1 ? 'page' : 'pages'}`
                : 'CSV file'}
            </Link>
            <span className="text-ink-muted">{dateTime.format(new Date(item.createdAt))}</span>
            <span className="text-ink">{STATUS_LABELS[item.status]}</span>
            {item.items !== null && (
              <span className="text-ink-muted">
                {item.items} {item.items === 1 ? 'dish' : 'dishes'}
              </span>
            )}
            {showCost && item.source === 'photo' && (
              <span className="text-ink-muted">
                Cost {item.costPaise === null ? '—' : <Money paise={item.costPaise} />}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export async function ImportDetailView({
  importId,
  restaurantId,
  importBasePath,
  menuHref,
  asPlatformAdmin = false,
}: {
  importId: string;
  restaurantId: string;
  importBasePath: string;
  menuHref: string;
  asPlatformAdmin?: boolean;
}) {
  const menuImport = await getMenuImport(importId);
  if (!menuImport || menuImport.restaurantId !== restaurantId) notFound();

  const costLine = asPlatformAdmin && menuImport.source === 'photo' && (
    <p className="text-sm text-ink-muted" data-testid="import-cost">
      {menuImport.model ?? 'No model'} · {menuImport.inputTokens.toLocaleString(DEFAULT_LOCALE)} in
      / {menuImport.outputTokens.toLocaleString(DEFAULT_LOCALE)} out tokens · cost{' '}
      {menuImport.costPaise === null ? '—' : <Money paise={menuImport.costPaise} />}
    </p>
  );

  switch (menuImport.status) {
    case 'uploaded':
    case 'processing':
      return (
        <>
          <ImportProgress
            importId={menuImport.id}
            pages={menuImport.pages.map((page) => ({ index: page.index, status: page.status }))}
          />
          {costLine}
        </>
      );

    case 'review': {
      if (!menuImport.draft) {
        return (
          <Outcome ok={false} title="This draft can't be opened." startHref={importBasePath}>
            Start a new import.
          </Outcome>
        );
      }
      const [menu, pageUrls] = await Promise.all([
        getCurrentMenu(restaurantId, { asPlatformAdmin }),
        pageImageUrls(menuImport),
      ]);
      const draft = markExistingItems(menuImport.draft, menu);
      return (
        <>
          {costLine}
          <ReviewScreen
            importId={menuImport.id}
            source={menuImport.source}
            initialDraft={draft}
            menuCategoryNames={menu.categories.map((category) => category.name)}
            hiddenCategoryNames={menu.categories
              .filter((category) => !category.isActive)
              .map((category) => category.name)}
            pageUrls={pageUrls}
            failedPages={menuImport.pages
              .filter((page) => page.status === 'failed')
              .map((page) => ({ index: page.index, error: page.error ?? 'Unknown error' }))}
            startHref={importBasePath}
          />
        </>
      );
    }

    case 'imported': {
      const counts = menuImport.importedCounts;
      const parts = counts
        ? [
            (counts.items_created > 0 || counts.items_updated === 0) &&
              `${counts.items_created} ${counts.items_created === 1 ? 'dish' : 'dishes'} added`,
            counts.items_updated > 0 &&
              `${counts.items_updated} ${counts.items_updated === 1 ? 'price' : 'prices'} updated`,
            counts.categories_created > 0 &&
              `${counts.categories_created} new ${counts.categories_created === 1 ? 'category' : 'categories'}`,
            counts.categories_shown > 0 &&
              `${counts.categories_shown} hidden ${counts.categories_shown === 1 ? 'category' : 'categories'} shown again`,
            counts.items_skipped > 0 && `${counts.items_skipped} skipped`,
          ].filter(Boolean)
        : [];
      return (
        <>
          <Outcome ok title="Menu imported." startHref={importBasePath} menuHref={menuHref}>
            {parts.join(', ')}.
          </Outcome>
          {costLine}
        </>
      );
    }

    case 'failed':
      return (
        <>
          <Outcome ok={false} title="This import could not be read." startHref={importBasePath}>
            {menuImport.error}
          </Outcome>
          {costLine}
        </>
      );

    case 'discarded':
      return (
        <Outcome ok={false} title="This import was discarded." startHref={importBasePath}>
          Nothing from it reached the menu.
        </Outcome>
      );
  }
}

function Outcome({
  ok,
  title,
  children,
  startHref,
  menuHref,
}: {
  ok: boolean;
  title: string;
  children: React.ReactNode;
  startHref: string;
  menuHref?: string;
}) {
  const Icon = ok ? CircleCheck : CircleX;
  return (
    <section
      aria-label="Import result"
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <p className="flex items-center gap-2 text-base font-semibold text-ink">
        <Icon
          aria-hidden
          className={ok ? 'size-5 text-status-served' : 'size-5 text-status-void'}
        />
        {title}
      </p>
      <p className="text-sm text-ink">{children}</p>
      <div className="flex flex-wrap gap-2">
        {menuHref && (
          <Link href={menuHref} className={buttonVariants()}>
            Open the menu
          </Link>
        )}
        <Link href={startHref} className={buttonVariants({ variant: 'outline' })}>
          {ok ? 'Import more' : 'Start a new import'}
        </Link>
      </div>
    </section>
  );
}
