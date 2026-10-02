import { cn } from 'cn';
import {
  Activity,
  Camera,
  ChartColumn,
  ChevronDown,
  ClipboardX,
  Clock3,
  EyeOff,
  Languages,
  Printer,
  QrCode,
  ReceiptText,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';

import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { buttonVariants } from '@/components/ui/button';

import { FAQ, FINAL_CTA, HERO, HIGHLIGHTS, PROBLEMS, ROLES, type HighlightIcon } from '../content';
import { PhoneFrame } from './device-frames';
import { HeroStory } from './hero-story';
import { HowItWorks } from './how-it-works';

/** The home page's sections (docs/DECISIONS.md W-1), top to bottom. */

function Section({
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

export function Hero() {
  return (
    <section className="site-dots relative overflow-hidden px-4 pt-10 pb-16 sm:px-6 sm:pt-16 lg:pt-20">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 lg:grid-cols-[1fr_1.15fr]">
        <div className="flex flex-col gap-6">
          <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl lg:text-5xl">
            {HERO.title}
          </h1>
          <p className="max-w-xl text-base text-ink-muted sm:text-lg">{HERO.lead}</p>
          <div id="hero-cta" className="flex flex-wrap gap-3">
            <Link href="/contact" className={cn(buttonVariants({ size: 'touch' }), 'px-6')}>
              {HERO.primary}
            </Link>
            {/* A plain anchor, so focus moves on to the section too. */}
            <a
              href="#how"
              className={cn(buttonVariants({ variant: 'outline', size: 'touch' }), 'px-6')}
            >
              {HERO.secondary}
            </a>
          </div>
          <p className="text-sm text-ink-muted">
            Already using MenuMesh?{' '}
            <Link href="/login" className="font-semibold text-brand hover:underline">
              Log in
            </Link>
          </p>
        </div>
        <HeroStory />
      </div>
    </section>
  );
}

/** "हिन्दी" inside English copy, marked as Hindi for screen readers. */
export function WithHindi({ text }: { text: string }) {
  const [before, after] = text.split('हिन्दी');
  if (after === undefined) return text;
  return (
    <>
      {before}
      <span lang="hi">हिन्दी</span>
      {after}
    </>
  );
}

function GrowthBadge() {
  return (
    <span className="ml-1.5 inline-flex rounded-full bg-accent px-2 py-0.5 align-middle text-xs font-semibold whitespace-nowrap text-brand">
      Growth plan
    </span>
  );
}

const PROBLEM_ICONS: LucideIcon[] = [ClipboardX, Clock3, EyeOff];

export function Problems() {
  return (
    <Section
      title="Running a busy floor on paper is hard"
      lead="Orders, the kitchen and the bill all depend on slips and memory. MenuMesh puts them on one screen everyone shares."
      className="bg-surface"
    >
      <ul className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {PROBLEMS.map((problem, index) => {
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

export function How() {
  return (
    <Section
      id="how"
      title="How it works"
      lead="From the first scan to a free table, in four steps your staff already know."
    >
      <HowItWorks />
    </Section>
  );
}

const ROLE_ACCENTS = ['bg-status-ready', 'bg-status-preparing', 'bg-brand'];

export function Roles() {
  return (
    <Section
      id="features"
      title="One system for the whole restaurant"
      lead="Guests, the floor, the kitchen and the counter each get a screen made for what they do."
      className="bg-surface"
    >
      <ul className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {ROLES.map((role, index) => (
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
                    {point.plan && <GrowthBadge />}
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

const HIGHLIGHT_ICONS: Record<HighlightIcon, LucideIcon> = {
  camera: Camera,
  languages: Languages,
  activity: Activity,
  'wifi-off': WifiOff,
  printer: Printer,
  receipt: ReceiptText,
  'qr-code': QrCode,
  chart: ChartColumn,
};

export function Highlights() {
  return (
    <Section
      title="Made for restaurants in India"
      lead="The details that matter on a real service."
    >
      <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {HIGHLIGHTS.map((highlight) => {
          const Icon = HIGHLIGHT_ICONS[highlight.icon];
          return (
            <li
              key={highlight.title}
              className="site-reveal group flex flex-col gap-3 rounded-2xl border border-line bg-surface p-6 transition-shadow hover:shadow-lg hover:shadow-ink/5"
            >
              <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-brand transition-transform duration-300 group-hover:-rotate-6">
                <Icon aria-hidden className="size-5" />
              </span>
              <h3 className="text-base font-semibold text-ink">
                <WithHindi text={highlight.title} />
                {'plan' in highlight && <GrowthBadge />}
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
      <div className="bg-brand px-3 pt-6 pb-3 text-white">
        <p className="text-[1.15em] font-bold">Spice Route</p>
        <p className="opacity-80">{hindi ? 'टेबल 5' : 'Table 5'}</p>
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

export function Hindi() {
  return (
    <section
      aria-labelledby="hindi-title"
      className="bg-ink px-4 py-16 text-white sm:px-6 sm:py-24"
    >
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 lg:grid-cols-2">
        <div className="site-reveal flex flex-col gap-4">
          <h2 id="hindi-title" className="text-2xl font-bold sm:text-3xl">
            Your menu, in your guests’ language
          </h2>
          <p className="text-base text-white/80 sm:text-lg">
            One tap switches the whole menu to <span lang="hi">हिन्दी</span>: buttons, the cart,
            order status, and your dish names. MenuMesh writes each dish name in Hindi for you, and
            you can change any of them in the menu editor.
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

export function Faq() {
  return (
    <Section id="faq" title="Questions owners ask" className="bg-surface">
      <div className="flex max-w-3xl flex-col divide-y divide-line rounded-2xl border border-line bg-paper">
        {FAQ.map((item) => (
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

export function FinalCta() {
  return (
    <section className="px-4 py-16 sm:px-6 sm:py-24">
      <div className="site-reveal on-brand mx-auto flex max-w-4xl flex-col items-center gap-6 rounded-3xl bg-brand px-6 py-14 text-center text-white sm:px-12">
        <h2 className="text-2xl font-bold sm:text-3xl">{FINAL_CTA.title}</h2>
        <p className="max-w-2xl text-base text-white/85 sm:text-lg">{FINAL_CTA.body}</p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link
            href="/contact"
            className={cn(
              buttonVariants({ variant: 'outline', size: 'touch' }),
              'border-white bg-white px-6 text-brand hover:bg-white/90',
            )}
          >
            {HERO.primary}
          </Link>
          <Link
            href="/login"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'touch' }),
              'px-6 text-white hover:bg-white/10 hover:text-white',
            )}
          >
            Log in
          </Link>
        </div>
      </div>
    </section>
  );
}
