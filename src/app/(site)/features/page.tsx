import type { Metadata } from 'next';

import { FEATURE_SECTIONS, FEATURES_PAGE } from '@/features/site/content';
import { FeatureSections } from '@/features/site/components/feature-sections';
import { FinalCta } from '@/features/site/components/sections';
import { APP_NAME } from '@/lib/config';

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} · Features` },
  description:
    'QR ordering for guests, a live board for waiters, a kitchen view, one-tap bills and reports for owners. See each screen of MenuMesh.',
};

export default function FeaturesPage() {
  return (
    <>
      <section className="site-dots px-4 pt-12 pb-10 sm:px-6 sm:pt-16">
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          <div className="flex max-w-2xl flex-col gap-4">
            <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
              {FEATURES_PAGE.title}
            </h1>
            <p className="text-base text-ink-muted sm:text-lg">{FEATURES_PAGE.lead}</p>
          </div>
          <nav aria-label="On this page">
            <ul className="flex flex-wrap gap-2">
              {FEATURE_SECTIONS.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className="inline-flex h-11 items-center rounded-full border border-line bg-surface px-4 text-sm font-medium text-ink hover:border-brand hover:text-brand"
                  >
                    {section.nav}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </section>
      <FeatureSections />
      <FinalCta />
    </>
  );
}
