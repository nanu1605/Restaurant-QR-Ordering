import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WithHindi } from '@/features/site/components/with-hindi';
import { fill, fillNodes, parseSiteLang, plural } from '@/features/site/i18n';
import { limitLabel } from '@/features/site/pricing';

// The website's language helpers: words from the dictionary (content.ts), filled in.

describe('fill', () => {
  it('puts each value in its slot and leaves unknown slots alone', () => {
    expect(fill('Try the {plan} plan free for {days} days.', { plan: 'Growth', days: 14 })).toBe(
      'Try the Growth plan free for 14 days.',
    );
    expect(fill('{plan}, {cycle}', { plan: 'Pro' })).toBe('Pro, {cycle}');
    expect(fill('{toString}', {})).toBe('{toString}');
  });
});

describe('fillNodes', () => {
  it('puts elements in their slots, wherever the language puts them', () => {
    const html = renderToStaticMarkup(
      <p>
        {fillNodes('Sent to {email}. Check {where}.', { email: <b>a@b.in</b>, where: 'spam' })}
      </p>,
    );
    expect(html).toBe('<p>Sent to <b>a@b.in</b>. Check spam.</p>');
  });
});

describe('plural', () => {
  it('picks the form by count and fills {n}', () => {
    const months = { one: '{n} month', other: '{n} months' };
    expect(plural(1, months)).toBe('1 month');
    expect(plural(2, months)).toBe('2 months');
    expect(plural(0, months)).toBe('0 months');
  });
});

describe('parseSiteLang', () => {
  it('accepts a website language and falls back to English', () => {
    expect(parseSiteLang('en')).toBe('en');
    expect(parseSiteLang('fr')).toBe('en');
    expect(parseSiteLang('constructor')).toBe('en');
    expect(parseSiteLang(undefined)).toBe('en');
  });
});

describe('limitLabel', () => {
  it('words a plan limit', () => {
    const words = { unlimited: 'Unlimited tables', upTo: 'Up to {n} tables' };
    expect(limitLabel(8, words)).toBe('Up to 8 tables');
    expect(limitLabel(null, words)).toBe('Unlimited tables');
  });
});

describe('WithHindi', () => {
  it('marks every हिन्दी as Hindi and keeps the text around it', () => {
    const html = renderToStaticMarkup(<WithHindi text="हिन्दी menu, हिन्दी buttons" />);
    expect(html).toBe('<span lang="hi">हिन्दी</span> menu, <span lang="hi">हिन्दी</span> buttons');
  });

  it('leaves text without Hindi as it is', () => {
    expect(renderToStaticMarkup(<WithHindi text="English only" />)).toBe('English only');
  });
});
