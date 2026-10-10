import { cn } from 'cn';
import type { Metadata } from 'next';
import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';
import { DemoSimulator } from '@/features/site/components/demo-simulator';
import { SITE } from '@/features/site/content';
import { APP_NAME } from '@/lib/config';

const { meta } = SITE.en.demo;

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} · ${meta.title}` },
  description: meta.description,
};

/** The interactive demo: one table's order, played on three devices in the browser. */
export default function DemoPage() {
  const t = SITE.en;
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-12 sm:px-6 sm:py-16">
      <div className="flex max-w-2xl flex-col gap-3">
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">{t.demo.title}</h1>
        <p className="text-base text-ink-muted sm:text-lg">{t.demo.lead}</p>
      </div>
      <DemoSimulator />
      <div className="flex flex-col items-start gap-4 rounded-2xl bg-surface p-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-base text-ink sm:text-lg">{t.demo.ownMenu}</p>
        <Link
          href="/contact"
          data-cta="demo"
          className={cn(buttonVariants({ size: 'touch' }), 'px-6')}
        >
          {t.cta.demo}
        </Link>
      </div>
    </div>
  );
}
