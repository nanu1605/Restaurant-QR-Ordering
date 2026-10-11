import { cn } from 'cn';
import {
  Activity,
  ArrowRight,
  Camera,
  ChartColumn,
  ChevronDown,
  ClipboardX,
  Clock3,
  EyeOff,
  Languages,
  MousePointerClick,
  Printer,
  QrCode,
  ReceiptText,
  Tags,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';

import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Money } from '@/components/shared/money';
import { buttonVariants } from '@/components/ui/button';

import { SITE, type SiteLang } from '../content';
import { fillNodes } from '../i18n';
import { siteCta, signupOpen } from '../signup';
import { PhoneFrame } from './device-frames';
import { HeroStory } from './hero-story';
import { HowItWorks } from './how-it-works';
import { SiteLink } from './site-link';
import { WithHindi } from './with-hindi';

/** The home page's sections (docs/DECISIONS.md W-1), top to bottom. */

export function Section({
  id,
  title,
  lead,
  className,
  children,
}: {
  id?: string;
  title: string;
  lead?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={id ? `${id}-title` : undefined}
      className={cn('px-4 py-16 sm:px-6 sm:py-24', className)}
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-10 sm:gap-14">
        <div className="site-reveal flex max-w-2xl flex-col gap-3">
          {/* Focusable, so the menu can move focus to the section it scrolled to. */}
          <h2
            id={id ? `${id}-title` : undefined}
            tabIndex={id ? -1 : undefined}
            className="text-2xl font-bold text-ink outline-none sm:text-3xl"
          >
            {title}
          </h2>
          {lead && <p className="text-base text-ink-muted sm:text-lg">{lead}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}

export function Hero({ lang }: { lang: SiteLang }) {
  const t = SITE[lang];
  const cta = siteCta(lang);
  return (
    <section className="site-dots relative overflow-hidden px-4 pt-10 pb-16 sm:px-6 sm:pt-16 lg:pt-20">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 lg:grid-cols-[1fr_1.15fr]">
        <div className="flex flex-col gap-6">
          <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl lg:text-5xl">
            {t.hero.title}
          </h1>
          <p className="max-w-xl text-base text-ink-muted sm:text-lg">{t.hero.lead}</p>
          <div id="hero-cta" data-cta="hero" className="flex flex-wrap gap-3">
            <SiteLink
              siteLang={lang}
              href={cta.href}
              className={cn(buttonVariants({ size: 'touch' }), 'px-6')}
            >
              {cta.label}
            </SiteLink>
            {/* A plain anchor, so focus moves on to the section too. */}
            <a
              href="#how"
              className={cn(buttonVariants({ variant: 'outline', size: 'touch' }), 'px-6')}
            >
              {t.hero.secondary}
            </a>
          </div>
          <p className="text-sm text-ink-muted">
            {fillNodes(t.hero.customers, {
              login: (
                <SiteLink
                  siteLang={lang}
                  href="/login"
                  className="font-semibold text-brand hover:underline"
                >
                  {t.login}
                </SiteLink>
              ),
            })}
          </p>
        </div>
        <HeroStory t={t.story} />
      </div>
    </section>
  );
}

export function GrowthBadge({ lang }: { lang: SiteLang }) {
  return (
    <span className="ml-1.5 inline-flex rounded-full bg-accent px-2 py-0.5 align-middle text-xs font-semibold whitespace-nowrap text-brand">
      {SITE[lang].growthBadge}
    </span>
  );
}

const PROBLEM_ICONS: LucideIcon[] = [ClipboardX, Clock3, EyeOff];

export function Problems({ lang }: { lang: SiteLang }) {
  const t = SITE[lang].problems;
  return (
    <Section title={t.title} lead={t.lead} className="bg-surface">
      <ul className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {t.items.map((problem, index) => {
          const Icon = PROBLEM_ICONS[index]!;
          return (
            <li
              key={problem.title}
              className="site-reveal flex flex-col gap-3 rounded-2xl bg-paper p-6"
            >
              <Icon aria-hidden className="size-7 text-attention" />
              <h3 className="text-lg font-semibold text-ink">{problem.title}</h3>
              <p className="text-base text-ink-muted">{problem.body}</p>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

export function How({ lang }: { lang: SiteLang }) {
  const t = SITE[lang].how;
  return (
    <Section id="how" title={t.title} lead={t.lead}>
      <HowItWorks t={t.steps} />
    </Section>
  );
}

const ROLE_ACCENTS = ['bg-status-ready', 'bg-status-preparing', 'bg-primary'];

export function Roles({ lang }: { lang: SiteLang }) {
  const t = SITE[lang].roles;
  return (
    <Section id="features" title={t.title} lead={t.lead} className="bg-surface">
      <ul className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {t.items.map((role, index) => (
          <li
            key={role.id}
            className="site-reveal relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-line bg-paper p-6"
          >
            <span
              aria-hidden
              className={cn('absolute inset-x-0 top-0 h-1.5', ROLE_ACCENTS[index])}
            />
            <h3 className="text-lg font-semibold text-ink">{role.title}</h3>
            <ul className="flex flex-col gap-2.5">
              {role.points.map((point) => (
                <li key={point.text} className="flex gap-2.5 text-base text-ink-muted">
                  <span
                    aria-hidden
                    className={cn('mt-2 size-2 shrink-0 rounded-full', ROLE_ACCENTS[index])}
                  />
                  <span>
                    <WithHindi text={point.text} />
                    {point.plan && <GrowthBadge lang={lang} />}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** By position in the dictionary's highlights. */
const HIGHLIGHT_ICONS: LucideIcon[] = [
  Camera,
  Languages,
  Activity,
  WifiOff,
  Printer,
  ReceiptText,
  QrCode,
  ChartColumn,
];

export function Highlights({ lang }: { lang: SiteLang }) {
  const t = SITE[lang].highlights;
  return (
    <Section title={t.title} lead={t.lead}>
      <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {t.items.map((highlight, index) => {
          const Icon = HIGHLIGHT_ICONS[index]!;
          return (
            <li
              key={highlight.title}
              className="site-reveal group flex flex-col gap-3 rounded-2xl border border-line bg-surface p-6 transition-shadow hover:shadow-lg hover:shadow-black/5"
            >
              <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-brand transition-transform duration-300 group-hover:-rotate-6">
                <Icon aria-hidden className="size-5" />
              </span>
              <h3 className="text-base font-semibold text-ink">
                <WithHindi text={highlight.title} />
                {highlight.plan && <GrowthBadge lang={lang} />}
              </h3>
              <p className="text-sm text-ink-muted">{highlight.body}</p>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

const HINDI_MENU = [
  { en: 'Paneer Tikka', hi: 'पनीर टिक्का', type: 'veg' as const },
  { en: 'Chicken 65', hi: 'चिकन 65', type: 'non_veg' as const },
  { en: 'Dal Makhani', hi: 'दाल मखनी', type: 'veg' as const },
  { en: 'Butter Naan', hi: 'बटर नान', type: 'veg' as const },
];

function MiniMenu({ lang }: { lang: 'en' | 'hi' }) {
  const hindi = lang === 'hi';
  return (
    <div lang={lang} className="flex h-full flex-col text-[0.6rem]">
      <div className="bg-primary px-3 pt-6 pb-3 text-primary-foreground">
        <p className="text-[1.15em] font-bold">Spice Route</p>
        <p>{hindi ? 'टेबल 5' : 'Table 5'}</p>
      </div>
      <ul className="flex flex-col gap-1.5 p-2">
        {HINDI_MENU.map((dish) => (
          <li
            key={dish.en}
            className="flex items-center gap-1.5 rounded-md bg-surface p-2 shadow-sm"
          >
            <FoodTypeMark type={dish.type} className="size-[1.1em]" />
            <span className="flex-1 truncate font-semibold text-ink">
              {hindi ? dish.hi : dish.en}
            </span>
            <span className="rounded border border-brand px-1.5 font-semibold text-brand">
              {hindi ? 'जोड़ें' : 'Add'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Hindi({ lang }: { lang: SiteLang }) {
  const t = SITE[lang].hindi;
  return (
    <section
      aria-labelledby="hindi-title"
      className="bg-ink px-4 py-16 text-paper sm:px-6 sm:py-24 dark:border-y dark:border-line dark:bg-surface dark:text-ink"
    >
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 lg:grid-cols-2">
        <div className="site-reveal flex flex-col gap-4">
          <h2 id="hindi-title" className="text-2xl font-bold sm:text-3xl">
            {t.title}
          </h2>
          <p className="text-base text-paper/80 sm:text-lg dark:text-ink-muted">
            <WithHindi text={t.body} />
          </p>
        </div>
        <div aria-hidden className="site-reveal flex justify-center gap-4 sm:gap-8">
          <PhoneFrame className="w-[8.5rem] min-[400px]:w-40 sm:w-48">
            <MiniMenu lang="en" />
          </PhoneFrame>
          <PhoneFrame className="mt-10 w-[8.5rem] min-[400px]:w-40 sm:w-48">
            <MiniMenu lang="hi" />
          </PhoneFrame>
        </div>
      </div>
    </section>
  );
}

/** Two ways on from the home page: the demo, and the plans with the lowest price. */
export function NextSteps({ lang, fromPaise }: { lang: SiteLang; fromPaise: number | null }) {
  const t = SITE[lang].nextSteps;
  const cards = [
    { href: '/demo', icon: MousePointerClick, ...t.demo },
    {
      href: '/pricing',
      icon: Tags,
      title:
        fromPaise === null
          ? t.pricing.title
          : fillNodes(t.pricing.from, { price: <Money paise={fromPaise} fraction="auto" /> }),
      body: t.pricing.body,
      link: t.pricing.link,
    },
  ];
  return (
    <section aria-label={t.label} className="px-4 py-16 sm:px-6 sm:py-24">
      <ul className="mx-auto grid max-w-6xl grid-cols-1 gap-5 md:grid-cols-2">
        {cards.map(({ href, icon: Icon, title, body, link }) => (
          <li key={href} className="site-reveal">
            <SiteLink
              siteLang={lang}
              href={href}
              className="group flex h-full flex-col gap-3 rounded-2xl border border-line bg-surface p-6 transition-shadow hover:shadow-lg hover:shadow-black/5 sm:p-8"
            >
              <Icon aria-hidden className="size-7 text-brand" />
              <h2 className="text-xl font-bold text-ink">{title}</h2>
              <p className="text-base text-ink-muted">{body}</p>
              <span className="mt-auto inline-flex items-center gap-1.5 font-semibold text-brand">
                {link}
                <ArrowRight
                  aria-hidden
                  className="size-4 transition-transform group-hover:translate-x-1"
                />
              </span>
            </SiteLink>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Faq({
  lang,
  items = SITE[lang].faq.items,
  title = SITE[lang].faq.title,
}: {
  lang: SiteLang;
  items?: ReadonlyArray<{ q: string; a: string }>;
  title?: string;
}) {
  return (
    <Section id="faq" title={title} className="bg-surface">
      <div className="flex max-w-3xl flex-col divide-y divide-line rounded-2xl border border-line bg-paper">
        {items.map((item) => (
          <details key={item.q} className="group px-5 sm:px-6">
            <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-4 text-base font-semibold text-ink [&::-webkit-details-marker]:hidden">
              {item.q}
              <ChevronDown
                aria-hidden
                className="size-5 shrink-0 text-ink-muted transition-transform duration-200 group-open:rotate-180"
              />
            </summary>
            <p className="pb-5 text-base text-ink-muted">{item.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

export function FinalCta({ lang }: { lang: SiteLang }) {
  const t = SITE[lang];
  const cta = siteCta(lang);
  return (
    <section className="px-4 py-16 sm:px-6 sm:py-24">
      <div className="site-reveal on-brand mx-auto flex max-w-4xl flex-col items-center gap-6 rounded-3xl bg-primary px-6 py-14 text-center text-primary-foreground sm:px-12">
        <h2 className="text-2xl font-bold sm:text-3xl">{t.finalCta.title}</h2>
        <p className="max-w-2xl text-base sm:text-lg">
          {signupOpen() ? t.finalCta.signupBody : t.finalCta.body}
        </p>
        <div data-cta="final" className="flex flex-wrap justify-center gap-3">
          <SiteLink
            siteLang={lang}
            href={cta.href}
            className={cn(
              buttonVariants({ size: 'touch' }),
              'bg-primary-foreground px-6 text-paper hover:bg-primary-foreground/90 dark:text-ink',
            )}
          >
            {cta.label}
          </SiteLink>
          <SiteLink
            siteLang={lang}
            href="/login"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'touch' }),
              'px-6 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground dark:hover:bg-primary-foreground/10',
            )}
          >
            {t.login}
          </SiteLink>
        </div>
      </div>
    </section>
  );
}
