import { APP_NAME } from '@/lib/config';
import { getPublicEnv } from '@/lib/env';

import type { SitePricing } from './pricing';

/**
 * Structured data for search engines and answer engines (docs/DECISIONS.md W-12), built from the
 * same content and plans the pages show.
 */

type Node = Record<string, unknown>;

const url = (path = '/') => new URL(path, getPublicEnv().NEXT_PUBLIC_APP_URL).href;

/** Paise as the rupee amount schema.org expects, e.g. 99900 → "999.00". */
const rupees = (paise: number) => (paise / 100).toFixed(2);

/** One JSON-LD script; `<` is escaped so no text can close the script early. */
export function JsonLd({ nodes }: { nodes: Node[] }) {
  const data = { '@context': 'https://schema.org', '@graph': nodes };
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}

/** Google's site name and logo. Contact details join once the real ones are published. */
export function organization(): Node {
  return { '@type': 'Organization', name: APP_NAME, url: url(), logo: url('/icon/512') };
}

export function website(): Node {
  return { '@type': 'WebSite', name: APP_NAME, url: url() };
}

export function faqPage(items: readonly { q: string; a: string }[]): Node {
  return {
    '@type': 'FAQPage',
    mainEntity: items.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
}

/** The product, with each plan monthly and yearly, before GST like the pricing page (W-11). */
export function softwareApplication({ plans }: SitePricing): Node {
  const offer = (name: string, paise: number, billingDuration: 'P1M' | 'P1Y') => ({
    '@type': 'Offer',
    name,
    url: url('/pricing'),
    price: rupees(paise),
    priceCurrency: 'INR',
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: rupees(paise),
      priceCurrency: 'INR',
      billingDuration,
      valueAddedTaxIncluded: false,
    },
  });
  return {
    '@type': 'SoftwareApplication',
    name: APP_NAME,
    url: url(),
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description:
      'QR table ordering, kitchen and waiter screens, and billing for restaurants in India.',
    offers: plans.flatMap((plan) => [
      offer(`${plan.name}, monthly`, plan.monthlyPaise, 'P1M'),
      offer(`${plan.name}, yearly`, plan.yearlyPaise, 'P1Y'),
    ]),
  };
}
