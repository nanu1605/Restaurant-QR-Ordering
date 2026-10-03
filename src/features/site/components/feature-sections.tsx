import { cn } from 'cn';
import { Check } from 'lucide-react';
import Image, { type StaticImageData } from 'next/image';

import { FEATURE_SECTIONS } from '../content';
import bill from '../shots/bill.jpg';
import guestMenuHindi from '../shots/guest-menu-hindi.jpg';
import guestMenu from '../shots/guest-menu.jpg';
import guestOrders from '../shots/guest-orders.jpg';
import kitchen from '../shots/kitchen.jpg';
import reports from '../shots/reports.jpg';
import staffBoard from '../shots/staff-board.jpg';
import { LaptopFrame, PhoneFrame, TabletFrame } from './device-frames';
import { GrowthBadge } from './sections';
import { WithHindi } from './with-hindi';

/**
 * The features page's sections (docs/DECISIONS.md W-7): each role's screen,
 * from the real app (tests/site-shots), beside what it does.
 */

function Shot({ src, alt, sizes }: { src: StaticImageData; alt: string; sizes: string }) {
  return (
    <Image
      src={src}
      alt={alt}
      sizes={sizes}
      placeholder="blur"
      className="h-full w-full object-cover object-top"
    />
  );
}

const PHONE = 'w-36 sm:w-44 lg:w-48';
const PHONE_SIZES = '(min-width: 1024px) 192px, (min-width: 640px) 176px, 144px';
// The laptop's base is drawn 112% wide; this keeps it inside the column.
const LAPTOP = 'mx-auto w-[89%]';
const WIDE_SIZES = '(min-width: 1024px) 560px, 92vw';

const PICTURES: Record<string, React.ReactNode> = {
  guests: (
    <div className="flex justify-center gap-3 sm:gap-5">
      <PhoneFrame className={PHONE}>
        <Shot
          src={guestMenu}
          alt="The guest menu on a phone, with three dishes in the cart"
          sizes={PHONE_SIZES}
        />
      </PhoneFrame>
      <PhoneFrame className={cn(PHONE, 'mt-8 max-sm:hidden')}>
        <Shot src={guestMenuHindi} alt="The same menu in Hindi" sizes={PHONE_SIZES} />
      </PhoneFrame>
      <PhoneFrame className={cn(PHONE, 'sm:mt-16')}>
        <Shot
          src={guestOrders}
          alt="The guest’s order, each dish showing placed, preparing or ready"
          sizes={PHONE_SIZES}
        />
      </PhoneFrame>
    </div>
  ),
  waiters: (
    <TabletFrame>
      <Shot
        src={staffBoard}
        alt="The waiters’ live board: eight tables, coloured by status, one calling a waiter"
        sizes={WIDE_SIZES}
      />
    </TabletFrame>
  ),
  kitchen: (
    <TabletFrame>
      <Shot
        src={kitchen}
        alt="The kitchen view: tickets in columns for new, preparing and ready"
        sizes={WIDE_SIZES}
      />
    </TabletFrame>
  ),
  billing: (
    <LaptopFrame className={LAPTOP}>
      <Shot
        src={bill}
        alt="A paid bill with CGST and SGST, the payment by UPI and the table’s history"
        sizes={WIDE_SIZES}
      />
    </LaptopFrame>
  ),
  owners: (
    <LaptopFrame className={LAPTOP}>
      <Shot
        src={reports}
        alt="Today’s sales report: bills, gross and net sales, GST and how it was paid"
        sizes={WIDE_SIZES}
      />
    </LaptopFrame>
  ),
};

export function FeatureSections() {
  return FEATURE_SECTIONS.map((section, index) => (
    <section
      key={section.id}
      id={section.id}
      aria-labelledby={`${section.id}-title`}
      className={cn('px-4 py-16 sm:px-6 sm:py-20', index % 2 === 1 && 'bg-surface')}
    >
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <div
          className={cn('site-reveal flex min-w-0 flex-col gap-4', index % 2 === 1 && 'lg:order-2')}
        >
          <h2
            id={`${section.id}-title`}
            tabIndex={-1}
            className="text-2xl font-bold text-ink outline-none sm:text-3xl"
          >
            {section.title}
            {section.plan && <GrowthBadge />}
          </h2>
          <p className="text-base text-ink-muted sm:text-lg">{section.lead}</p>
          <ul className="flex flex-col gap-2.5">
            {section.points.map((point) => (
              <li key={point.text} className="flex gap-2.5 text-base text-ink">
                <Check aria-hidden className="mt-1 size-4 shrink-0 text-status-served" />
                <span>
                  <WithHindi text={point.text} />
                  {point.plan && <GrowthBadge />}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="site-reveal min-w-0">{PICTURES[section.id]}</div>
      </div>
    </section>
  ));
}
