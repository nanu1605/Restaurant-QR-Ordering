import Link from 'next/link';

import { LogoMark } from '@/components/shared/logo';
import { buttonVariants } from '@/components/ui/button';

/**
 * Any address that doesn't exist (docs/DECISIONS.md W-12). Kept neutral, since mistyped panel
 * addresses land here too; Next adds the noindex itself.
 */
export default function NotFound() {
  return (
    // English, also under /hi, whose <html lang> is Hindi.
    <main
      lang="en"
      className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center"
    >
      <LogoMark className="size-12" />
      <h1 className="text-2xl font-semibold text-ink">Page not found</h1>
      <p className="text-base text-ink-muted">The link may be old or mistyped.</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Link href="/" className={buttonVariants({ size: 'touch' })}>
          Go to the home page
        </Link>
        {/* A full load: under /hi this page's <html lang> is Hindi, and the login page has no
            website frame to set it back (the home page's does, W-16). */}
        <a href="/login" className={buttonVariants({ variant: 'outline', size: 'touch' })}>
          Log in
        </a>
      </div>
    </main>
  );
}
