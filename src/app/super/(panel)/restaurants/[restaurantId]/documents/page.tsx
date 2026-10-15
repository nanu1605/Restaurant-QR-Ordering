import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ChannelMenu } from '@/features/growth/components/channel-menu';
import { Facts, Section } from '@/features/platform/components/restaurant-sections';
import {
  ACQUISITION_CHANNEL_LABELS,
  formatDate,
  LOOKALIKE_REASON_LABELS,
} from '@/features/platform/platform';
import { getLookalikes, getRestaurantDetail, getSignupReview } from '@/features/platform/queries';
import { hasPlatformPermission, requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Documents',
};

const GST_MODE_LABELS: Record<string, string> = {
  none: 'No GST',
  regular: 'Regular GST',
  composition: 'Composition',
};

/**
 * A restaurant's Documents tab (docs/SUPER_ADMIN_PLAN.md 13a): its profile
 * with the FSSAI licence and GSTIN, the storefront photo sent at signup and
 * possible duplicates (docs/DECISIONS.md P11-12, P11-13).
 */
export default async function RestaurantDocumentsPage({
  params,
}: PageProps<'/super/restaurants/[restaurantId]/documents'>) {
  await requirePlatformPermission('restaurants.view');
  const { restaurantId } = await params;
  const detail = await getRestaurantDetail(restaurantId);
  if (!detail) notFound();
  const [review, lookalikes, manage] = await Promise.all([
    getSignupReview(restaurantId),
    getLookalikes([restaurantId]),
    hasPlatformPermission('restaurants.manage'),
  ]);
  const similar = lookalikes[restaurantId] ?? [];
  const { restaurant } = detail;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Profile">
        <Facts
          facts={[
            ['Legal name', restaurant.legal_name ?? '—'],
            [
              'Address',
              [restaurant.address_line, restaurant.city, restaurant.state, restaurant.pincode]
                .filter(Boolean)
                .join(', ') || '—',
            ],
            ['Phone', restaurant.phone ?? '—'],
            ['Email', restaurant.email ?? '—'],
            [
              'GST',
              `${GST_MODE_LABELS[restaurant.gst_mode] ?? restaurant.gst_mode}${restaurant.gstin ? `, ${restaurant.gstin}` : ''}`,
            ],
            ['FSSAI licence', review.fssaiLicense ?? '—'],
            [
              'Found us',
              manage ? (
                <ChannelMenu
                  key="channel"
                  restaurantId={restaurant.id}
                  channel={restaurant.acquisition_channel}
                />
              ) : restaurant.acquisition_channel ? (
                ACQUISITION_CHANNEL_LABELS[restaurant.acquisition_channel]
              ) : (
                'Not known'
              ),
            ],
            ['Onboarded', formatDate(restaurant.created_at)],
          ]}
        />
      </Section>

      {/* What the website's signup sent, for the one-trial check (docs/DECISIONS.md P11-12). */}
      <Section title="Storefront photo">
        {review.photoUrl ? (
          <a href={review.photoUrl} target="_blank" rel="noopener" className="self-start">
            {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link */}
            <img
              src={review.photoUrl}
              alt={`Front of ${restaurant.name}`}
              className="max-h-64 w-auto max-w-full rounded-md border border-line object-cover"
            />
          </a>
        ) : (
          <p className="text-sm text-ink-muted">
            No photo: restaurants onboarded here, or signed up before the photo was asked for, have
            none.
          </p>
        )}
      </Section>

      <Section title="Possible duplicates">
        {similar.length === 0 ? (
          <p className="text-sm text-ink-muted">None found.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line text-sm">
            {similar.map((other) => (
              <li key={other.restaurant_id} className="flex flex-col py-2 first:pt-0 last:pb-0">
                <Link
                  href={`/super/restaurants/${other.restaurant_id}`}
                  className="font-medium text-ink underline underline-offset-4"
                >
                  {other.name}
                </Link>
                <span className="text-ink-muted">
                  {[other.slug, other.city].filter(Boolean).join(', ')}:{' '}
                  {other.reasons.map((reason) => LOOKALIKE_REASON_LABELS[reason]).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
