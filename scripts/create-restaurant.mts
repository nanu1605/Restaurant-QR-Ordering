/**
 * Creates a restaurant and its owner login until the super-admin onboarding
 * wizard exists (Phase 7). Uses the Supabase URL and secret key from
 * .env.local, so it only ever touches the database that file points at.
 *
 *   pnpm create-restaurant --name "Sharma Dhaba" --slug sharma-dhaba \
 *     --owner-name "Vikram Sharma" --owner-username vikram --owner-password "..." \
 *     [--owner-email vikram@example.com] [--plan growth] [--cuisine north_indian] [--city Jaipur]
 *
 * Without --owner-email the owner gets a synthetic login email and signs in
 * with restaurant code + username.
 */
import { parseArgs } from 'node:util';

import { createClient } from '@supabase/supabase-js';

import { CUISINE_SETS, isCuisineSet } from '../src/features/menu/default-categories.ts';
import { onboardRestaurant } from '../src/features/platform/onboard.ts';
import type { Database } from '../src/types/database.ts';

const USAGE = `Usage: pnpm create-restaurant --name <name> --slug <code> --owner-name <name>
       --owner-username <username> --owner-password <password>
       [--owner-email <email>] [--plan starter|growth|pro] [--city <city>]
       [--cuisine ${CUISINE_SETS.join('|')}]`;

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const { values: args } = parseArgs({
  options: {
    name: { type: 'string' },
    slug: { type: 'string' },
    'owner-name': { type: 'string' },
    'owner-username': { type: 'string' },
    'owner-password': { type: 'string' },
    'owner-email': { type: 'string' },
    plan: { type: 'string', default: 'growth' },
    cuisine: { type: 'string', default: 'north_indian' },
    city: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const required = ['name', 'slug', 'owner-name', 'owner-username', 'owner-password'] as const;
const missing = required.filter((key) => !args[key]);
if (missing.length > 0) fail(`Missing ${missing.map((key) => `--${key}`).join(', ')}\n\n${USAGE}`);
if (!isCuisineSet(args.cuisine)) fail(`Unknown --cuisine "${args.cuisine}".\n\n${USAGE}`);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
if (!supabaseUrl || !secretKey) {
  fail('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env.local.');
}

const admin = createClient<Database>(supabaseUrl, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log(`Creating "${args.name}" on ${supabaseUrl} …`);

try {
  const result = await onboardRestaurant(admin, {
    name: args.name!,
    slug: args.slug!,
    ownerName: args['owner-name']!,
    ownerUsername: args['owner-username']!,
    ownerPassword: args['owner-password']!,
    ownerEmail: args['owner-email'],
    plan: args.plan,
    city: args.city,
    cuisine: args.cuisine,
    staffEmailDomain: process.env.STAFF_EMAIL_DOMAIN || 'tableorder.test',
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  console.log(`
✔ Restaurant created (id ${result.restaurantId})

  Log in at        ${appUrl}/login
  Restaurant code  ${result.slug}
  Username         ${result.ownerUsername}${args['owner-email'] ? `\n  Email            ${result.ownerEmail}` : ''}
  Plan             ${args.plan} (trial)
  Menu categories  ${args.cuisine}
`);
} catch (error) {
  fail((error as Error).message);
}
