import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { AccountManagerMenu } from '@/features/platform/components/account-manager-menu';
import { Breadcrumbs } from '@/features/platform/components/breadcrumbs';
import { RestaurantActions } from '@/features/platform/components/restaurant-actions';
import { RestaurantTabs } from '@/features/platform/components/restaurant-tabs';
import { HealthBadge, SubscriptionStateBadge } from '@/features/platform/components/status-badges';
import { TagBadge } from '@/features/platform/components/tag-badge';
import { TagsEditor } from '@/features/platform/components/tags-editor';
import { formatMobile, telHref, whatsappHref } from '@/features/platform/dues-messages';
import {
  firstUnpaidDay,
  formatDate,
  formatDateTime,
  type RestaurantDetail,
} from '@/features/platform/platform';
import {
  getRestaurantDetail,
  getSetupFee,
  getTeam,
  listPlans,
  listTags,
} from '@/features/platform/queries';
import { paidTillDay } from '@/features/platform/restaurants-csv';
import { autopayState } from '@/features/subscriptions/autopay';
import { hasPlatformPermission, requirePlatformPermission } from '@/lib/auth/guards';
import { APP_NAME } from '@/lib/config';
import { getSupportWindow } from '@/features/support/access-queries';
import { untilText } from '@/features/support/support-access';
import { DEFAULT_TIMEZONE } from '@/lib/config';
import { razorpayConfig } from '@/lib/razorpay/razorpay';

type Params = Pick<LayoutProps<'/super/restaurants/[restaurantId]'>, 'params'>;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { restaurantId } = await params;
  const detail = await getRestaurantDetail(restaurantId).catch(() => null);
  const name = detail?.restaurant.name ?? 'Restaurant';
  return { title: { default: name, template: `%s · ${name} · ${APP_NAME}` } };
}

/**
 * A restaurant's page (docs/SUPER_ADMIN_PLAN.md 13a, docs/DECISIONS.md SA-33,
 * SA-34): who it is and where it stands, its tags, account manager and
 * actions, over the tabs.
 */
export default async function RestaurantLayout({
  children,
  params,
}: LayoutProps<'/super/restaurants/[restaurantId]'>) {
  const user = await requirePlatformPermission('restaurants.view');
  const { restaurantId } = await params;
  const detail = await getRestaurantDetail(restaurantId);
  if (!detail) notFound();
  const [plans, setupFee, tags, team, support, manage, record, canSupport] = await Promise.all([
    listPlans(),
    getSetupFee(),
    listTags(),
    getTeam(),
    getSupportWindow(restaurantId, user.id),
    hasPlatformPermission('restaurants.manage'),
    hasPlatformPermission('money.record'),
    hasPlatformPermission('restaurants.support'),
  ]);
  const supportWindow = support.window;
  const { restaurant, subscription, access } = detail;
  const autopay = subscription
    ? autopayState({
        razorpayStatus: subscription.razorpay_status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      })
    : 'off';
  const plan = plans.find((p) => p.code === subscription?.plan_code);
  // The price it pays now, while that deal is open.
  const deal = subscription?.deal?.ended_at === null ? subscription.deal : null;

  return (
    <>
      <Breadcrumbs items={[{ href: '/super/restaurants', label: 'Restaurants' }]} />
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-xl font-semibold [overflow-wrap:anywhere] text-ink">
              {restaurant.name}
            </h1>
            <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
              <span>
                Code {restaurant.slug}
                {restaurant.city && `, ${restaurant.city}`}
              </span>
              <SubscriptionStateBadge
                state={detail.state}
                endsAt={subscription?.cancel_at_period_end ? subscription.current_period_end : null}
              />
              <HealthBadge
                health={detail.health}
                muted={detail.state === 'suspended' || detail.state === 'read_only'}
              />
            </p>
          </div>
          <RestaurantActions
            restaurantId={restaurant.id}
            restaurantName={restaurant.name}
            status={restaurant.status}
            subscription={
              subscription
                ? { status: subscription.status, planCode: subscription.plan_code }
                : null
            }
            plans={plans.filter((p) => p.is_active).map(({ code, name }) => ({ code, name }))}
            paymentStart={firstUnpaidDay(
              subscription && {
                status: subscription.status,
                restrictionAt: access.restriction_at,
                currentPeriodEnd: subscription.current_period_end,
              },
            )}
            razorpay={
              razorpayConfig()
                ? {
                    subscriptionId: subscription?.razorpay_subscription_id ?? null,
                    autopay,
                    linkDefaults: {
                      planName: plan?.name ?? '',
                      // A deal's price for its cycle (docs/DECISIONS.md SA-77+).
                      monthlyPaise:
                        (deal?.billing_cycle === 'monthly' ? deal.price_paise : null) ??
                        plan?.price_monthly_paise ??
                        0,
                      yearlyPaise:
                        (deal?.billing_cycle === 'yearly' ? deal.price_paise : null) ??
                        plan?.price_yearly_paise ??
                        0,
                      dealChargesLeft:
                        deal?.cycles == null ? null : deal.cycles - deal.charges_used,
                      listMonthlyPaise: plan?.price_monthly_paise ?? 0,
                      listYearlyPaise: plan?.price_yearly_paise ?? 0,
                      setupFeePaise: setupFee.feePaise - setupFee.discountPaise,
                      setupFeeDiscountPaise: setupFee.discountPaise,
                    },
                  }
                : null
            }
            support={{
              state: !supportWindow
                ? 'none'
                : !supportWindow.userId
                  ? 'open'
                  : supportWindow.userId === user.id
                    ? 'mine'
                    : 'in_use',
              lastName: support.lastName,
            }}
            can={{ manage, record, support: canSupport }}
          />
        </div>

        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <HeaderFact term="Plan">
            {subscription
              ? `${subscription.plan_name}${
                  subscription.billing_cycle
                    ? `, ${subscription.billing_cycle === 'yearly' ? 'yearly' : 'monthly'}`
                    : ''
                }`
              : 'No subscription'}
          </HeaderFact>
          {subscription && <PaidTill subscription={subscription} />}
          <HeaderFact term="Last active">
            {detail.last_active ? formatDateTime(detail.last_active) : 'Never'}
          </HeaderFact>
          <HeaderFact term="Support access">
            {!supportWindow
              ? 'Not allowed'
              : `${supportWindow.staffName ? `${supportWindow.staffName}, ` : 'Allowed, '}until ${untilText(supportWindow.endsAt, DEFAULT_TIMEZONE)}`}
          </HeaderFact>
        </dl>

        <OwnerContact detail={detail} />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink-muted">Tags:</span>
            {detail.tags.length === 0 ? (
              <span className="text-sm text-ink-muted">none</span>
            ) : (
              <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
                {detail.tags.map((tag) => (
                  <li key={tag.id}>
                    <TagBadge tag={tag} />
                  </li>
                ))}
              </ul>
            )}
            {manage && (
              <TagsEditor
                restaurantId={restaurant.id}
                restaurantName={restaurant.name}
                tags={tags}
                chosen={detail.tags.map((tag) => tag.id)}
              />
            )}
          </div>
          {manage ? (
            <AccountManagerMenu
              restaurantId={restaurant.id}
              current={
                detail.account_manager
                  ? { userId: detail.account_manager.user_id, email: detail.account_manager.email }
                  : null
              }
              team={team}
            />
          ) : (
            <p className="text-sm text-ink-muted">
              Account manager: {detail.account_manager?.email ?? 'none'}
            </p>
          )}
        </div>
      </header>

      {restaurant.status === 'suspended' && (
        <p role="status" className="rounded-lg border-2 border-destructive bg-surface p-3 text-ink">
          Suspended: {restaurant.suspended_reason}
        </p>
      )}

      <RestaurantTabs restaurantId={restaurant.id} menuImports={canSupport} />
      {children}
    </>
  );
}

function HeaderFact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-ink-muted">{term}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

// Paid or trial till (plan §5.5): the last day a paid period covers.
function PaidTill({
  subscription,
}: {
  subscription: NonNullable<RestaurantDetail['subscription']>;
}) {
  const trialing = subscription.status === 'trialing';
  const day = paidTillDay({
    paid_till: trialing ? subscription.trial_ends_at : subscription.current_period_end,
    subscription_status: subscription.status,
  });
  return (
    <HeaderFact term={trialing ? 'Trial till' : 'Paid till'}>
      {day ? formatDate(day) : '—'}
    </HeaderFact>
  );
}

// The restaurant owner, and the restaurant's phone with Call and WhatsApp.
function OwnerContact({ detail }: { detail: RestaurantDetail }) {
  const { restaurant } = detail;
  const owner = detail.owners.find((o) => o.is_active) ?? detail.owners[0];
  const email = owner?.email_is_real && owner.email ? owner.email : restaurant.email;
  const tel = telHref(restaurant.phone);
  const whatsapp = whatsappHref(restaurant.phone, '');
  const link =
    'inline-flex min-h-11 items-center text-brand underline underline-offset-4 md:min-h-6';
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink">
      <span>
        <span className="text-ink-muted">Owner:</span> {owner?.display_name ?? 'none'}
      </span>
      {tel && whatsapp ? (
        <>
          <span className="tabular-nums">{formatMobile(restaurant.phone)}</span>
          <a href={tel} className={link} aria-label={`Call ${restaurant.name}`}>
            Call
          </a>
          <a
            href={whatsapp}
            target="_blank"
            rel="noopener noreferrer"
            className={link}
            aria-label={`WhatsApp ${restaurant.name}`}
          >
            WhatsApp
          </a>
        </>
      ) : (
        restaurant.phone && <span>{restaurant.phone}</span>
      )}
      {email && <span className="[overflow-wrap:anywhere]">{email}</span>}
    </p>
  );
}
