import { describe, expect, it, vi } from 'vitest';

import { leadEmail } from '@/features/site/leads';
import {
  monthsFreeYearly,
  recommendPlan,
  toPricingPlan,
  yearlySavingPaise,
  type PricingPlan,
} from '@/features/site/pricing';
import { leadSchema, normalizePhone, signupSchema, verifySchema } from '@/features/site/schemas';
import { signupCodeEmail, slugFromName, welcomeEmail } from '@/features/site/signup';
import { RESTAURANT_CODE_PATTERN } from '@/lib/auth/staff-email';
import { verifyTurnstile, type TurnstileConfig } from '@/lib/turnstile';

// The website's pricing, "Book a demo" form and Turnstile check
// (docs/DECISIONS.md W-5, W-6).

const none = { kds: false, discounts: false, split_payments: false, upi_qr_on_bill: false };

const PLANS: PricingPlan[] = [
  toPricingPlan({
    code: 'pro',
    name: 'Pro',
    price_monthly_paise: 179900,
    price_yearly_paise: 1799000,
    max_tables: null,
    max_staff: null,
    features: { kds: true, remove_branding: true },
  }),
  toPricingPlan({
    code: 'starter',
    name: 'Starter',
    price_monthly_paise: 39900,
    price_yearly_paise: 399000,
    max_tables: 8,
    max_staff: 3,
    features: none,
  }),
  toPricingPlan({
    code: 'growth',
    name: 'Growth',
    price_monthly_paise: 89900,
    price_yearly_paise: 899000,
    max_tables: null,
    max_staff: 15,
    features: { ...none, kds: true, extra: true },
  }),
];

describe('pricing', () => {
  it('reads only the known features, and only true counts', () => {
    const growth = PLANS[2]!;
    expect(growth.features.kds).toBe(true);
    expect(growth.features.csv_export).toBe(false);
    expect('extra' in growth.features).toBe(false);
    expect(toPricingPlan({ ...PLANS[0]!, features: null } as never).features.kds).toBe(false);
  });

  it('works out the yearly saving in paise', () => {
    expect(yearlySavingPaise(PLANS[1]!)).toBe(79800);
    expect(yearlySavingPaise({ ...PLANS[1]!, yearlyPaise: 600000 })).toBe(0);
  });

  it('offers as many free months as every paid plan gives', () => {
    expect(monthsFreeYearly(PLANS)).toBe(2);
    expect(monthsFreeYearly([...PLANS, { ...PLANS[1]!, code: 'odd', yearlyPaise: 450000 }])).toBe(
      0,
    );
    expect(monthsFreeYearly([{ ...PLANS[1]!, monthlyPaise: 0, yearlyPaise: 0 }])).toBe(0);
    expect(monthsFreeYearly([])).toBe(0);
  });

  it('recommends the cheapest plan that covers the tables, staff and features', () => {
    const pick = (
      tables: number,
      staff: number,
      features: Parameters<typeof recommendPlan>[1]['features'] = [],
    ) => recommendPlan(PLANS, { tables, staff, features })?.code ?? null;
    expect(pick(8, 3)).toBe('starter');
    expect(pick(9, 3)).toBe('growth');
    expect(pick(8, 4)).toBe('growth');
    expect(pick(2, 0, ['kds'])).toBe('growth');
    expect(pick(2, 16)).toBe('pro');
    expect(pick(2, 0, ['remove_branding'])).toBe('pro');
    expect(recommendPlan(PLANS.slice(1), { tables: 2, staff: 40, features: [] })).toBeNull();
  });
});

describe('the "Book a demo" form', () => {
  const valid = {
    name: '  Asha Rao ',
    restaurantName: 'Spice Route',
    city: 'Pune',
    phone: '98765 43210',
    email: '',
    planCode: 'growth',
    message: '  ',
  };

  it('normalizes Indian phone numbers to ten digits', () => {
    expect(normalizePhone('+91 98765-43210')).toBe('9876543210');
    expect(normalizePhone('09876543210')).toBe('9876543210');
    expect(normalizePhone('919876543210')).toBe('9876543210');
    expect(normalizePhone('98765')).toBe('98765');
  });

  it('cleans what the visitor typed', () => {
    expect(leadSchema.parse(valid)).toEqual({
      name: 'Asha Rao',
      restaurantName: 'Spice Route',
      city: 'Pune',
      phone: '9876543210',
      email: null,
      planCode: 'growth',
      message: null,
    });
    expect(leadSchema.parse({ ...valid, email: ' A@B.in ', planCode: 'x; drop' })).toMatchObject({
      email: 'a@b.in',
      planCode: null,
    });
  });

  it('names what to fix', () => {
    const result = leadSchema.safeParse({ ...valid, name: ' ', phone: '12345', email: 'nope' });
    expect(result.success).toBe(false);
    const messages = Object.fromEntries(
      result.error!.issues.map((issue) => [issue.path[0], issue.message]),
    );
    expect(messages).toEqual({
      name: 'Enter your name.',
      phone: 'Enter a 10-digit mobile number.',
      email: 'Enter a valid email address, or leave it empty.',
    });
    expect(leadSchema.safeParse({ ...valid, message: 'x'.repeat(1001) }).success).toBe(false);
    // Forms send line breaks as CRLF; they count once, as in the textarea.
    const lines = Array.from({ length: 10 }, () => 'x'.repeat(99)).join('\r\n');
    expect(leadSchema.parse({ ...valid, message: lines }).message).toHaveLength(999);
  });

  it('emails the lead with everything escaped', () => {
    const lead = leadSchema.parse({ ...valid, restaurantName: 'Tom & <Jerry>', message: 'Hi' });
    const email = leadEmail(lead, 'Growth', 'https://menumesh.in/', 'l1');
    expect(email.subject).toBe('Demo request: Tom & <Jerry>, Pune');
    expect(email.text).toContain('Phone: +91 9876543210');
    expect(email.text).toContain('Plan: Growth');
    expect(email.text).toContain('Open the lead: https://menumesh.in/super/leads/l1');
    expect(email.html).toContain('Tom &amp; &lt;Jerry&gt;');
    expect(email.html).not.toContain('<Jerry>');
  });
});

describe('the self-serve signup', () => {
  const valid = {
    restaurantName: ' Spice Route ',
    city: 'Pune',
    cuisine: 'cafe',
    ownerName: 'Asha Rao',
    email: ' Asha@Example.IN ',
    phone: '+91 98765 43210',
    addressLine: ' 12 MG Road ',
    pincode: '452001',
    fssaiLicense: '1142 5999 0001 23',
    gstin: ' 23aaacd1234e1z5 ',
    terms: 'on',
    planCode: 'starter',
    cycle: 'yearly',
  };

  it('cleans the details and needs the terms agreed', () => {
    expect(signupSchema.parse(valid)).toEqual({
      ...valid,
      restaurantName: 'Spice Route',
      email: 'asha@example.in',
      phone: '9876543210',
      addressLine: '12 MG Road',
      fssaiLicense: '11425999000123',
      gstin: '23AAACD1234E1Z5',
    });
    expect(signupSchema.parse({ ...valid, gstin: '' }).gstin).toBeNull();
    expect(signupSchema.parse({ ...valid, planCode: '', cycle: 'weekly' })).toMatchObject({
      planCode: null,
      cycle: 'monthly',
    });
    const refused = signupSchema.safeParse({ ...valid, terms: '', email: '', cuisine: 'thai' });
    expect(refused.error!.issues.map((issue) => [issue.path[0], issue.message])).toEqual([
      ['cuisine', 'Choose your menu style.'],
      ['email', 'Enter a valid email address.'],
      ['terms', 'Agree to the terms to continue.'],
    ]);
  });

  it('needs the licence, address and pincode, and a well-formed GSTIN when given', () => {
    const refused = signupSchema.safeParse({
      ...valid,
      addressLine: ' ',
      pincode: '012345',
      fssaiLicense: '1234',
      gstin: '23AAACD1234E1Z',
    });
    expect(refused.error!.issues.map((issue) => [issue.path[0], issue.message])).toEqual([
      ['addressLine', 'Enter your restaurant’s address.'],
      ['pincode', 'Enter a 6-digit pincode.'],
      ['fssaiLicense', 'Enter the 14-digit FSSAI licence number.'],
      [
        'gstin',
        'A GSTIN has 15 characters, like 23AAACD1234E1Z5. Leave it empty if you have none.',
      ],
    ]);
  });

  it('takes the code with spaces and a password of 8 to 72 characters', () => {
    expect(verifySchema.parse({ code: '123 456', password: 'longenough' }).code).toBe('123456');
    expect(verifySchema.safeParse({ code: '12345', password: 'longenough' }).success).toBe(false);
    expect(verifySchema.safeParse({ code: '123456', password: 'short' }).success).toBe(false);
    expect(verifySchema.safeParse({ code: '123456', password: 'x'.repeat(73) }).success).toBe(
      false,
    );
    // Supabase Auth reads 72 bytes: 25 Hindi letters are 75.
    expect(verifySchema.safeParse({ code: '123456', password: 'क'.repeat(25) }).success).toBe(
      false,
    );
    expect(verifySchema.safeParse({ code: '123456', password: 'क'.repeat(24) }).success).toBe(true);
  });

  it('makes a restaurant code from the name', () => {
    expect(slugFromName('Spice Route & Co.')).toBe('spice-route-and-co');
    expect(slugFromName('  Café Mocha!! ')).toBe('cafe-mocha');
    expect(slugFromName('स्वाद')).toBe('restaurant');
    expect(slugFromName('The Very Long Restaurant Name Of Delhi')).toBe('the-very-long-restaurant');
    expect(slugFromName('Spice Route', 'k7m2')).toBe('spice-route-k7m2');
    for (const name of ['A', 'Hotel —— Annapurna ——', 'x'.repeat(200)]) {
      expect(slugFromName(name, 'ab12')).toMatch(RESTAURANT_CODE_PATTERN);
    }
  });

  it('emails the code and the welcome with everything escaped', () => {
    const code = signupCodeEmail('042917', 'en');
    expect(code.subject).toBe('042917 is your MenuMesh code');
    expect(code.text).toContain('It works for 15 minutes.');
    expect(code.html).toContain('<strong');

    const welcome = welcomeEmail({
      ownerName: 'Asha <b>',
      restaurantName: 'Tom & Jerry',
      slug: 'tom-and-jerry',
      appUrl: 'https://menumesh.in/',
      lang: 'en',
    });
    expect(welcome.subject).toBe('Welcome to MenuMesh, Tom & Jerry');
    expect(welcome.text).toContain('Your restaurant code is tom-and-jerry.');
    expect(welcome.text).toContain(
      '1. Add your menu, or import it from a photo: https://menumesh.in/admin/menu',
    );
    expect(welcome.html).toContain('Asha &lt;b&gt;');
    expect(welcome.html).not.toContain('<b>');
    expect(code.html).toMatch(/^<div lang="en">/);
    expect(welcome.html).toMatch(/^<div lang="en">/);
  });

  it('emails a Hindi visitor in Hindi', () => {
    const code = signupCodeEmail('042917', 'hi');
    expect(code.html).toMatch(/^<div lang="hi">[^]*042917<\/strong>[^]*<\/div>$/);
    expect(code.text).toMatch(/\p{Script=Devanagari}/u);
    const welcome = welcomeEmail({
      ownerName: 'Asha',
      restaurantName: 'Swad',
      slug: 'swad',
      appUrl: 'https://menumesh.in',
      lang: 'hi',
    });
    expect(welcome.html).toMatch(/^<div lang="hi">/);
    expect(welcome.text).toMatch(/\p{Script=Devanagari}/u);
    expect(welcome.text).toContain('swad');
  });
});

describe('verifyTurnstile', () => {
  const config = (fetchImpl: typeof fetch): TurnstileConfig => ({
    siteKey: 'site',
    secretKey: 'secret',
    verifyUrl: 'https://verify.test/siteverify',
    fetchImpl,
  });
  const reply = (body: unknown, status = 200) =>
    vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

  it('passes only when Cloudflare says so, sending the secret, token and IP', async () => {
    const fetchImpl = reply({ success: true });
    expect(await verifyTurnstile(config(fetchImpl), 'token', '1.2.3.4')).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://verify.test/siteverify');
    expect(String(init?.body)).toBe('secret=secret&response=token&remoteip=1.2.3.4');
  });

  it('fails closed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await verifyTurnstile(config(reply({ success: false })), 'token', null)).toBe(false);
    expect(await verifyTurnstile(config(reply({ success: true }, 500)), 'token', null)).toBe(false);
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await verifyTurnstile(config(offline), 'token', null)).toBe(false);
    const unused = reply({ success: true });
    expect(await verifyTurnstile(config(unused), '', null)).toBe(false);
    expect(await verifyTurnstile(config(unused), 'x'.repeat(2049), null)).toBe(false);
    expect(unused).not.toHaveBeenCalled();
  });
});
