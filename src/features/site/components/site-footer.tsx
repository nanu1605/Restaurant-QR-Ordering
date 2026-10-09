import { Wordmark } from '@/components/shared/logo';
import { ThemeSwitch } from '@/features/theme/theme-switch';
import { APP_NAME } from '@/lib/config';

import { SiteLink } from './site-link';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { href: '/#how', label: 'How it works' },
      { href: '/features', label: 'Features' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/demo', label: 'Try the demo' },
      { href: '/#faq', label: 'FAQ' },
      { href: '/login', label: 'Log in' },
    ],
  },
  {
    title: 'Company',
    links: [{ href: '/contact', label: 'Contact' }],
  },
  {
    title: 'Legal',
    links: [
      { href: '/terms', label: 'Terms of service' },
      { href: '/privacy', label: 'Privacy policy' },
      { href: '/refund', label: 'Refunds and cancellation' },
      { href: '/shipping', label: 'Shipping and delivery' },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    // Room for the phone's sticky call to action.
    <footer data-cta="footer" className="border-t border-line bg-surface pb-28 md:pb-0">
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.5fr_repeat(3,1fr)]">
        <div className="flex flex-col gap-3">
          <Wordmark className="self-start" />
          <p className="max-w-xs text-sm text-ink-muted">
            QR table ordering, kitchen and waiter screens, and billing for restaurants in India.
          </p>
        </div>
        {COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <h2 className="text-sm font-semibold text-ink">{column.title}</h2>
            <ul className="mt-3 flex flex-col gap-1">
              {column.links.map((link) => (
                <li key={link.href}>
                  <SiteLink
                    href={link.href}
                    className="inline-flex min-h-11 items-center text-sm text-ink-muted hover:text-brand"
                  >
                    {link.label}
                  </SiteLink>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 border-t border-line px-4 py-6 sm:px-6">
        <p className="text-xs text-ink-muted">
          © {new Date().getFullYear()} {APP_NAME}
        </p>
        <ThemeSwitch />
      </div>
    </footer>
  );
}
