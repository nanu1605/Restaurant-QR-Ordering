import { FeatureSections } from '../components/feature-sections';
import { FinalCta } from '../components/sections';
import { SITE, type SiteLang } from '../content';

export function FeaturesView({ lang }: { lang: SiteLang }) {
  const t = SITE[lang].featuresPage;
  return (
    <>
      <section className="site-dots px-4 pt-12 pb-10 sm:px-6 sm:pt-16">
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          <div className="flex max-w-2xl flex-col gap-4">
            <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">{t.title}</h1>
            <p className="text-base text-ink-muted sm:text-lg">{t.lead}</p>
          </div>
          <nav aria-label={t.onThisPage}>
            <ul className="flex flex-wrap gap-2">
              {t.sections.map((section) => (
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
      <FeatureSections lang={lang} />
      <FinalCta lang={lang} />
    </>
  );
}
