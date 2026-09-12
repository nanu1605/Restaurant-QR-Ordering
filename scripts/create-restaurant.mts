/**
 * Creates a restaurant and its owner login until the super-admin onboarding
 * wizard exists (Phase 7). Uses the Supabase URL and secret key from
 * .env.local, so it only ever touches the database that file points at.
 *
 *   pnpm create-restaurant --name "Sharma Dhaba" --slug sharma-dhaba \
 *     --owner-name "Vikram Sharma" --owner-username vikram --owner-password "..." \
 *     [--owner-email vikram@example.com] [--plan growth] [--city Jaipur]
 *
 * Without --owner-email the owner gets a synthetic login email and signs in
 * with restaurant code + username.
 */
import { parseArgs } from 'node:util';

import { createClient } from '@supabase/supabase-js';

import { normalizeLoginName, staffEmail } from '../src/lib/auth/staff-email.ts';

const USAGE = `Usage: pnpm create-restaurant --name <name> --slug <code> --owner-name <name>
       --owner-username <username> --owner-password <password>
       [--owner-email <email>] [--plan starter|growth|pro] [--city <city>]`;

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

const name = args.name!.trim();
const slug = normalizeLoginName(args.slug!);
const ownerName = args['owner-name']!.trim();
const ownerUsername = normalizeLoginName(args['owner-username']!);
const ownerPassword = args['owner-password']!;
if (ownerPassword.length < 8) fail('The owner password must be at least 8 characters.');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
if (!supabaseUrl || !secretKey) {
  fail('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env.local.');
}

let ownerEmail: string;
try {
  ownerEmail =
    args['owner-email']?.trim().toLowerCase() ||
    staffEmail(ownerUsername, slug, process.env.STAFF_EMAIL_DOMAIN || 'tableorder.test');
} catch (error) {
  fail((error as Error).message);
}

const admin = createClient(supabaseUrl, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log(`Creating "${name}" (${slug}) on ${supabaseUrl} …`);

const { data: created, error: createUserError } = await admin.auth.admin.createUser({
  email: ownerEmail,
  password: ownerPassword,
  email_confirm: true,
  user_metadata: { display_name: ownerName },
});
if (createUserError || !created.user) {
  fail(`Could not create the owner login: ${createUserError?.message ?? 'unknown error'}`);
}

const { data: result, error: rpcError } = await admin.rpc('platform_create_restaurant', {
  p_payload: {
    name,
    slug,
    city: args.city,
    plan_code: args.plan,
    owner: { user_id: created.user.id, display_name: ownerName, username: ownerUsername },
  },
});

if (rpcError) {
  // Don't leave an orphaned login behind.
  await admin.auth.admin.deleteUser(created.user.id);
  fail(`Could not create the restaurant: ${rpcError.message}`);
}

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
console.log(`
✔ Restaurant created (id ${(result as { restaurant_id: string }).restaurant_id})

  Log in at        ${appUrl}/login
  Restaurant code  ${slug}
  Username         ${ownerUsername}${args['owner-email'] ? `\n  Email            ${ownerEmail}` : ''}
  Plan             ${args.plan} (trial)
`);
