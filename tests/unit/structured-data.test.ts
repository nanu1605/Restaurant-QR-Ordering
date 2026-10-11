import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { FEATURE_KEYS } from '@/features/plans/plan-features';
import type { SitePricing } from '@/features/site/pricing';
import { faqPage, JsonLd, softwareApplication } from '@/features/site/structured-data';

vi.mock('@/lib/env', () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: 'https://menumesh.in' }),
}));

const features = Object.fromEntries(FEATURE_KEYS.map((key) => [key, true])) as Record<
  (typeof FEATURE_KEYS)[number],
  boolean
>;

// Structured data (docs/DECISIONS.md W-12).
describe('JsonLd', () => {
  it('escapes "<" so text can never close the script', () => {
    const html = renderToStaticMarkup(
      createElement(JsonLd, { nodes: [faqPage([{ q: 'Is </script> safe?', a: '<b>yes</b>' }])] }),
    );
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    const json = html.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    const data = JSON.parse(json);
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@graph'][0].mainEntity[0]).toEqual({
      '@type': 'Question',
      name: 'Is </script> safe?',
      acceptedAnswer: { '@type': 'Answer', text: '<b>yes</b>' },
    });
  });
});

describe('faqPage', () => {
  it('names the language of its questions', () => {
    const items = [{ q: 'Q', a: 'A' }];
    expect(faqPage(items)).toMatchObject({ '@type': 'FAQPage', inLanguage: 'en-IN' });
    expect(faqPage(items, 'hi')).toMatchObject({ '@type': 'FAQPage', inLanguage: 'hi-IN' });
  });
});

describe('softwareApplication', () => {
  it('lists each plan monthly and yearly in rupees, before GST', () => {
    const pricing: SitePricing = {
      plans: [
        {
          code: 'starter',
          name: 'Starter',
          monthlyPaise: 99900,
          yearlyPaise: 999000,
          maxTables: 10,
          maxStaff: 3,
          features,
        },
      ],
      trialDays: 14,
      trialPlanCode: 'starter',
      setupFeePaise: 0,
    };
    const { offers } = softwareApplication(pricing) as { offers: Record<string, unknown>[] };
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({
      name: 'Starter, monthly',
      price: '999.00',
      priceCurrency: 'INR',
      url: 'https://menumesh.in/pricing',
      priceSpecification: { billingDuration: 'P1M', valueAddedTaxIncluded: false },
    });
    expect(offers[1]).toMatchObject({
      name: 'Starter, yearly',
      price: '9990.00',
      priceSpecification: { billingDuration: 'P1Y' },
    });
  });
});
