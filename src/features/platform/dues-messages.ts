import { APP_NAME, DEFAULT_TIMEZONE } from '@/lib/config';
import { formatINR } from '@/lib/money';

import { periodLastDay, type DuesBucket, type DuesRow } from './platform';

/**
 * WhatsApp messages for the Dues page (docs/SUPER_ADMIN_PLAN.md 12c,
 * docs/DECISIONS.md SA-20): one per bucket, in English and Hindi, filled in
 * for one restaurant and edited before sending. The templates live in code
 * until the team asks to change them often.
 */

export type MessageLanguage = 'en' | 'hi';

type Filled = {
  restaurant: string;
  plan: string;
  amount: string;
  /** The day the message is about, already in the language's words. */
  date: string;
  cycle: string;
};

const TEMPLATES: Record<DuesBucket, Record<MessageLanguage, (f: Filled) => string>> = {
  payment_failed: {
    en: (f) =>
      `Hello from ${APP_NAME}. The payment for ${f.restaurant}'s ${f.plan} plan (${f.amount} with GST) didn't go through. Ordering keeps working until ${f.date}. You can pay from the Subscription page in your admin panel, or reply here and we'll send a payment link.`,
    hi: (f) =>
      `${APP_NAME} की ओर से नमस्ते। ${f.restaurant} के ${f.plan} प्लान का भुगतान (${f.amount}, GST सहित) नहीं हो पाया। ${f.date} तक ऑर्डर लेना चालू रहेगा। आप एडमिन पैनल के सब्सक्रिप्शन पेज से भुगतान कर सकते हैं, या यहाँ जवाब दें, हम भुगतान लिंक भेज देंगे।`,
  },
  lapsed: {
    en: (f) =>
      `Hello from ${APP_NAME}. ${f.restaurant}'s ${f.plan} plan has ended, so QR ordering is paused. Your menu, tables and reports are safe. To switch it back on, pay ${f.amount} with GST from the Subscription page in your admin panel, or reply here for a payment link.`,
    hi: (f) =>
      `${APP_NAME} की ओर से नमस्ते। ${f.restaurant} का ${f.plan} प्लान खत्म हो गया है, इसलिए QR ऑर्डर बंद हैं। आपका मेन्यू, टेबल और रिपोर्ट सुरक्षित हैं। फिर से शुरू करने के लिए एडमिन पैनल के सब्सक्रिप्शन पेज से ${f.amount} (GST सहित) का भुगतान करें, या भुगतान लिंक के लिए यहाँ जवाब दें।`,
  },
  trial_ending: {
    en: (f) =>
      `Hello from ${APP_NAME}. ${f.restaurant}'s free trial ends on ${f.date}. To keep taking QR orders, choose a plan on the Subscription page in your admin panel (${f.plan}: ${f.amount} ${f.cycle} with GST), or reply here and we'll help you set it up.`,
    hi: (f) =>
      `${APP_NAME} की ओर से नमस्ते। ${f.restaurant} का फ्री ट्रायल ${f.date} को खत्म हो रहा है। QR ऑर्डर लेते रहने के लिए एडमिन पैनल के सब्सक्रिप्शन पेज पर प्लान चुनें (${f.plan}: ${f.amount} ${f.cycle}, GST सहित), या यहाँ जवाब दें, हम मदद करेंगे।`,
  },
  renewal_due: {
    en: (f) =>
      `Hello from ${APP_NAME}. ${f.restaurant}'s ${f.plan} plan is paid till ${f.date}. The next payment is ${f.amount} with GST. Reply here and we'll send a payment link, or pay from the Subscription page in your admin panel.`,
    hi: (f) =>
      `${APP_NAME} की ओर से नमस्ते। ${f.restaurant} के ${f.plan} प्लान का भुगतान ${f.date} तक हो चुका है। अगला भुगतान ${f.amount} (GST सहित) है। भुगतान लिंक के लिए यहाँ जवाब दें, या एडमिन पैनल के सब्सक्रिप्शन पेज से भुगतान करें।`,
  },
};

const CYCLE_WORDS: Record<MessageLanguage, Record<'monthly' | 'yearly', string>> = {
  en: { monthly: 'a month', yearly: 'a year' },
  hi: { monthly: 'प्रति माह', yearly: 'प्रति वर्ष' },
};

const dateFormats: Record<MessageLanguage, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-IN', {
    timeZone: DEFAULT_TIMEZONE,
    day: 'numeric',
    month: 'long',
  }),
  hi: new Intl.DateTimeFormat('hi-IN', {
    timeZone: DEFAULT_TIMEZONE,
    day: 'numeric',
    month: 'long',
  }),
};

/** The day each bucket's message is about. */
function messageDate(bucket: DuesBucket, row: DuesRow): string | null {
  if (bucket === 'payment_failed') return row.grace_until;
  if (bucket === 'trial_ending') return row.trial_ends_at;
  if (bucket === 'renewal_due' && row.current_period_end) {
    return periodLastDay(row.current_period_end);
  }
  return null;
}

/** The message for one restaurant in one bucket. */
export function duesMessage(bucket: DuesBucket, row: DuesRow, language: MessageLanguage): string {
  const at = messageDate(bucket, row);
  return TEMPLATES[bucket][language]({
    restaurant: row.name,
    plan: row.plan_name,
    amount: formatINR(row.due_paise, { fraction: 'auto' }),
    date: at ? dateFormats[language].format(new Date(at)) : '',
    cycle: CYCLE_WORDS[language][row.billing_cycle ?? 'monthly'],
  }).normalize('NFC');
}

/** An Indian mobile as stored (10 digits starting 6 to 9), or null. */
// The phone is free text ('+91 98765-43210' too): its last 10 digits, as
// private.phone10 reads it, when they are a mobile number.
function mobile(phone: string | null): string | null {
  const digits = (phone ?? '').replace(/\D/g, '').slice(-10);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** A mobile number to read out: '98765 43210'; null without one. */
export function formatMobile(phone: string | null): string | null {
  const number = mobile(phone);
  return number ? `${number.slice(0, 5)} ${number.slice(5)}` : null;
}

/** wa.me opens a chat with the text filled in; null without a mobile number. */
export function whatsappHref(phone: string | null, text: string): string | null {
  const number = mobile(phone);
  return number ? `https://wa.me/91${number}?text=${encodeURIComponent(text)}` : null;
}

export function telHref(phone: string | null): string | null {
  const number = mobile(phone);
  return number ? `tel:+91${number}` : null;
}
