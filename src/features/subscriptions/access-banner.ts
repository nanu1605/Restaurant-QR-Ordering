import { DEFAULT_LOCALE } from '@/lib/config';
import type { MemberRole } from '@/lib/auth/roles';

/**
 * Admin banner text for the restaurant's access state (spec §10.6, §14.6).
 * The owner gets a link to the Subscription page; other roles are told to ask
 * the owner. Read-only also pauses setup changes (docs/DECISIONS.md P2-1).
 */

export type AccessInput = {
  state: 'full' | 'read_only';
  reason: string | null;
  restrictionAt: string | null;
  warning: string | null;
};

export type AccessBanner = {
  tone: 'warning' | 'blocked';
  text: string;
  action?: { href: string; label: string };
};

const SUBSCRIPTION_PATH = '/admin/subscription';
const DAY_MS = 24 * 60 * 60 * 1000;

function formatDay(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    day: 'numeric',
    month: 'short',
    timeZone: timezone,
  }).format(new Date(iso));
}

export function accessBanner({
  access,
  role,
  timezone,
  now = new Date(),
}: {
  access: AccessInput;
  role: MemberRole;
  timezone: string;
  now?: Date;
}): AccessBanner | null {
  const isOwner = role === 'owner';

  if (access.state === 'read_only') {
    if (access.reason === 'suspended') {
      return {
        tone: 'blocked',
        text: 'This restaurant is suspended, so ordering and setup changes are paused. Contact support to restore it.',
      };
    }
    return {
      tone: 'blocked',
      text: isOwner
        ? 'Ordering is paused because the subscription has lapsed. Setup changes are paused too.'
        : 'Ordering is paused because the subscription has lapsed. Setup changes are paused too. Contact the owner.',
      action: isOwner ? { href: SUBSCRIPTION_PATH, label: 'Choose a plan' } : undefined,
    };
  }

  if (!access.warning || !access.restrictionAt) return null;

  const day = formatDay(access.restrictionAt, timezone);
  const askOwner = isOwner ? '' : ' Ask the owner to renew.';

  switch (access.warning) {
    case 'trial_ends_soon': {
      const days = Math.max(
        1,
        Math.ceil((Date.parse(access.restrictionAt) - now.getTime()) / DAY_MS),
      );
      return {
        tone: 'warning',
        text: `Your trial ends in ${days} ${days === 1 ? 'day' : 'days'}.${askOwner}`,
        action: isOwner ? { href: SUBSCRIPTION_PATH, label: 'Choose a plan' } : undefined,
      };
    }
    case 'payment_failed':
      return {
        tone: 'warning',
        text: `Payment failed. Update payment by ${day} to keep ordering active.${askOwner}`,
        action: isOwner ? { href: SUBSCRIPTION_PATH, label: 'Update payment' } : undefined,
      };
    case 'subscription_ends_soon':
      return {
        tone: 'warning',
        text: `Your subscription ends on ${day}. Renew to keep ordering active.${askOwner}`,
        action: isOwner ? { href: SUBSCRIPTION_PATH, label: 'Renew' } : undefined,
      };
    default:
      return null;
  }
}
