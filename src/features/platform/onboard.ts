/**
 * Creates a restaurant with its owner login (spec §13.4 onboarding): an auth
 * user via the Admin API, then platform_create_restaurant(), which adds the
 * owner membership, a trial subscription and the default categories. If the
 * database step fails, the new login is deleted again.
 *
 * Takes a service-role client, so only server code may call it. Used by
 * scripts/create-restaurant.mts and the E2E fixtures, and later by the
 * super-admin wizard. Relative .ts imports keep it runnable by Node directly.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { normalizeLoginName, staffEmail } from '../../lib/auth/staff-email.ts';
import type { Database } from '../../types/database.ts';
import {
  DEFAULT_CATEGORY_SETS,
  DEFAULT_CUISINE,
  type CuisineSet,
} from '../menu/default-categories.ts';

export type OnboardInput = {
  name: string;
  slug: string;
  ownerName: string;
  ownerUsername: string;
  ownerPassword: string;
  /** Real email; without it the owner signs in with restaurant code + username. */
  ownerEmail?: string;
  plan?: string;
  city?: string;
  cuisine?: CuisineSet;
  staffEmailDomain: string;
  /** Platform admin doing the onboarding (null = script/system). */
  actorUserId?: string;
};

export type OnboardResult = {
  restaurantId: string;
  slug: string;
  ownerUserId: string;
  ownerUsername: string;
  ownerEmail: string;
};

// No constructor parameter properties: Node's type stripping can't run them.
export class OnboardError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'OnboardError';
    this.code = code;
  }
}

export async function onboardRestaurant(
  admin: SupabaseClient<Database>,
  input: OnboardInput,
): Promise<OnboardResult> {
  const slug = normalizeLoginName(input.slug);
  const ownerUsername = normalizeLoginName(input.ownerUsername);
  if (input.ownerPassword.length < 8) {
    throw new OnboardError('The owner password must be at least 8 characters.', 'WEAK_PASSWORD');
  }

  const ownerEmail =
    input.ownerEmail?.trim().toLowerCase() ||
    staffEmail(ownerUsername, slug, input.staffEmailDomain);

  const { data: created, error: createUserError } = await admin.auth.admin.createUser({
    email: ownerEmail,
    password: input.ownerPassword,
    email_confirm: true,
    user_metadata: { display_name: input.ownerName.trim() },
  });
  if (createUserError || !created.user) {
    throw new OnboardError(
      `Could not create the owner login: ${createUserError?.message ?? 'unknown error'}`,
      createUserError?.code ?? 'CREATE_USER_FAILED',
    );
  }

  const { data, error } = await admin.rpc('platform_create_restaurant', {
    p_payload: {
      name: input.name.trim(),
      slug,
      city: input.city,
      plan_code: input.plan ?? 'growth',
      actor_user_id: input.actorUserId,
      categories: [...DEFAULT_CATEGORY_SETS[input.cuisine ?? DEFAULT_CUISINE]],
      owner: {
        user_id: created.user.id,
        display_name: input.ownerName.trim(),
        username: ownerUsername,
      },
    },
  });

  if (error) {
    // Don't leave an orphaned login behind.
    await admin.auth.admin.deleteUser(created.user.id);
    throw new OnboardError(`Could not create the restaurant: ${error.message}`, error.message);
  }

  return {
    restaurantId: (data as { restaurant_id: string }).restaurant_id,
    slug,
    ownerUserId: created.user.id,
    ownerUsername,
    ownerEmail,
  };
}
