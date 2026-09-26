import { QrCode } from 'lucide-react';

import { getStrings } from '@/features/ordering/lang';

/**
 * A table QR code that doesn't work: unknown, switched off, or replaced by a
 * regenerated one (spec §13.1 invalid QR).
 */
export default async function QrNotFound() {
  const t = await getStrings();
  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <QrCode aria-hidden className="size-12 text-ink-muted" strokeWidth={1.5} />
      <h1 className="text-xl font-semibold text-ink">{t.notFound.title}</h1>
      <p className="max-w-sm text-base text-ink-muted">{t.notFound.body}</p>
    </main>
  );
}
