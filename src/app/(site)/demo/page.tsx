import { cn } from 'cn';
import type { Metadata } from 'next';
import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';
import { DemoSimulator } from '@/features/site/components/demo-simulator';
import { APP_NAME } from '@/lib/config';

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} · Try the demo` },
  description:
    'Order from a guest’s phone, move the dishes through the kitchen and make the bill at the counter, all in your browser. Nothing is saved and no sign-up is needed.',
};

/** The interactive demo: one table's order, played on three devices in the browser. */
export default function DemoPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-12 sm:px-6 sm:py-16">
      <div className="flex max-w-2xl flex-col gap-3">
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">Try MenuMesh in your browser</h1>
        <p className="text-base text-ink-muted sm:text-lg">
          Be the guest, the kitchen and the counter for table 5. Nothing is saved, and you don’t
          need to sign up.
        </p>
      </div>
      <DemoSimulator />
      <div className="flex flex-col items-start gap-4 rounded-2xl bg-surface p-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-base text-ink sm:text-lg">
          Want to see it with your own menu and tables?
        </p>
        <Link href="/contact" className={cn(buttonVariants({ size: 'touch' }), 'px-6')}>
          Book a demo
        </Link>
      </div>
    </div>
  );
}
