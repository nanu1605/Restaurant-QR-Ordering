import { Mail, MessageCircle, Phone } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Book a demo',
  description: 'Talk to us about QR ordering, kitchen screens and billing for your restaurant.',
};

const WAYS = [
  { icon: Mail, title: 'Email', detail: '[Support email]' },
  { icon: Phone, title: 'Phone', detail: '[Phone number and hours]' },
  { icon: MessageCircle, title: 'WhatsApp', detail: '[WhatsApp number]' },
];

/** Contact details until the booking form arrives (docs/DECISIONS.md W-2). */
export default function ContactPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-12 sm:px-6 sm:py-16">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">Book a demo</h1>
        <p className="text-base text-ink-muted sm:text-lg">
          Tell us about your restaurant. We’ll show you MenuMesh on your own menu, set up your
          tables with you, and you can try MenuMesh free for 14 days on the Growth plan.
        </p>
      </div>
      <p
        role="note"
        className="rounded-lg border border-attention/40 bg-attention/5 px-4 py-3 text-sm font-medium text-ink"
      >
        Placeholder — the contact details below are filled in before launch.
      </p>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {WAYS.map(({ icon: Icon, title, detail }) => (
          <li
            key={title}
            className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-5"
          >
            <Icon aria-hidden className="size-6 text-brand" />
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            <p className="text-sm text-ink-muted">{detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
