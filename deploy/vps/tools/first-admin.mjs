/**
 * The first platform admin of a new MenuMesh server, whom no admin can invite yet: a login with no
 * password of its own yet (email confirmed) and an Admin's invite, made as Settings → Team makes
 * them (inviteMember in src/features/platform/team-actions.ts, platform_invite_member in
 * supabase/migrations/20261025100000_team.sql), then the one-time join link, printed once. It
 * refuses once the platform has any team member: everyone after the first is invited from
 * Settings → Team.
 *
 * The owner runs it by hand on the server after production's first deploy, from ~/incoming (it is
 * never installed under /srv/menumesh), in the web container, which holds the keys it needs, with
 * the values file in front of it on stdin: the email and the name, made on the owner's own machine
 * by first-admin-values.mjs (beside this file), so that neither is on a command line. docker exec's
 * output goes to the owner's terminal only, never to the container's log:
 *
 *   cat ~/incoming/first-admin.values.mjs ~/incoming/first-admin.mjs |
 *     sudo app-compose menumesh exec -T web node --input-type=module -
 *
 * The values file's lines run before this file's, as one module, so this file has no shebang line
 * (one is allowed only at the very start of a source) and nothing that reads the email or the name
 * at import time: its one import, node:crypto, is evaluated before any line of the source runs,
 * the values file's included, and the values are read in main() alone.
 *
 * Exits 0 with the link, 2 when it refused and made nothing, 1 when it failed (and says what is
 * left). Node 24's own fetch and crypto, nothing else. docs/RUNBOOK.md, "The first platform admin
 * (production)"; docs/DECISIONS.md VPS-111 and VPS-134.
 */
import { createHmac, randomBytes } from 'node:crypto';

// platform_invite_member's expiry: now() + interval '7 days'.
const INVITE_DAYS = 7;
// The Team page's email rule (inviteSchema in src/features/platform/team.ts): trimmed, lowercased,
// then zod's email pattern.
const EMAIL =
  /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
// What the Team page's names may not hold (hasNoHiddenCharacters in src/lib/person-name.ts): a
// control or format character, or a line or paragraph separator.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const TIMEOUT_MS = 30_000;

/** Refused before anything was made: exit 2. */
class Refused extends Error {}
/** Failed, with what is left said: exit 1, as for any error nobody expected. */
class Failed extends Error {}

/** Text from outside on one terminal line: no control characters, at most 200. */
const oneLine = (text) =>
  String(text)
    .replace(/\p{Cc}/gu, ' ')
    .slice(0, 200);

/** Each UTF-16 unit of `text` as a \uXXXX escape. */
const escaped = (text) =>
  text
    .split('')
    .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');

/**
 * A value the owner passed, quoted, with its control and format characters and its line and
 * paragraph separators written out as escapes.
 */
const shown = (value) =>
  JSON.stringify(String(value).slice(0, 200)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, escaped);

/** Why a request or a call failed. */
const reason = (error) =>
  oneLine(`${error?.message ?? error}${error?.cause?.code ? ` (${error.cause.code})` : ''}`);

/**
 * What an error answer says, without its details: PostgREST's can quote the whole row, the hash
 * among it.
 */
const said = (answer) =>
  oneLine(
    [answer.json?.error_code ?? answer.json?.code, answer.json?.msg ?? answer.json?.message]
      .filter((part) => part !== undefined && part !== null && part !== '')
      .join(': '),
  );

async function main() {
  const env = process.env;

  // What the owner passed: the values file's lines set them before this file's own ran.
  if (env.FIRST_ADMIN_EMAIL === undefined) {
    throw new Refused(
      'no FIRST_ADMIN_EMAIL: put the values file, made with first-admin-values.mjs, before this file on stdin (docs/RUNBOOK.md, The first platform admin (production))',
    );
  }
  const email = env.FIRST_ADMIN_EMAIL.trim().toLowerCase();
  if (!EMAIL.test(email)) {
    throw new Refused(`FIRST_ADMIN_EMAIL ${shown(env.FIRST_ADMIN_EMAIL)} is not an email address`);
  }
  if (env.FIRST_ADMIN_NAME === undefined) {
    throw new Refused(
      'no FIRST_ADMIN_NAME: put the values file, made with first-admin-values.mjs, before this file on stdin (docs/RUNBOOK.md, The first platform admin (production))',
    );
  }
  const name = env.FIRST_ADMIN_NAME.trim();
  // The Team page's rule: 1 to 80 characters, none of them HIDDEN, so nothing a terminal acts on
  // either: the link's line prints the name, where a control character could rewrite the screen, a
  // bidi control (a format character) reorder what the line shows, and a line or paragraph
  // separator break it.
  if (name.length < 1 || name.length > 80 || HIDDEN.test(name)) {
    throw new Refused(
      `FIRST_ADMIN_NAME ${shown(env.FIRST_ADMIN_NAME)} must be 1 to 80 characters, without control or format characters`,
    );
  }

  // The web container's own settings (compose.yml and env/web.env): never printed.
  const secretKey = env.SUPABASE_SECRET_KEY;
  const cookieSecret = env.CUSTOMER_COOKIE_SECRET;
  const gateway = env.SUPABASE_INTERNAL_URL?.replace(/\/+$/, '');
  const missing = [
    ...(secretKey ? [] : ['SUPABASE_SECRET_KEY']),
    ...(cookieSecret && cookieSecret.length >= 32 ? [] : ['CUSTOMER_COOKIE_SECRET']),
    ...(gateway ? [] : ['SUPABASE_INTERNAL_URL']),
  ];
  if (missing.length) {
    throw new Refused(`${missing.join(', ')} not set here: run it in the web container`);
  }

  /**
   * Supabase through the gateway with the secret key, as the kit's rehearsal calls it. No answer
   * at all is status 0, with why.
   */
  async function call(method, path, body) {
    try {
      const response = await fetch(`${gateway}${path}`, {
        method,
        headers: {
          apikey: secretKey,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON: the status says enough.
      }
      return { status: response.status, json };
    } catch (error) {
      return { status: 0, json: { message: reason(error) } };
    }
  }

  // The app's address as its build has it. NEXT_PUBLIC_APP_URL is inlined at build and is not in
  // the container's environment, but robots.txt names the sitemap under it (src/app/robots.ts),
  // so the link is the one Settings → Team would give, with nothing to mistype.
  const app = `http://127.0.0.1:${env.PORT || 3000}`;
  let robots = '';
  try {
    const answer = await fetch(`${app}/robots.txt`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (answer.ok) robots = await answer.text();
  } catch (error) {
    throw new Refused(`the app does not answer on ${app}: ${reason(error)}`);
  }
  let appUrl;
  try {
    const sitemap = new URL(/^Sitemap:\s*(\S+)/m.exec(robots)?.[1] ?? '');
    if (!['http:', 'https:'].includes(sitemap.protocol) || sitemap.pathname !== '/sitemap.xml') {
      throw new Error('not the sitemap');
    }
    appUrl = sitemap.origin;
  } catch {
    throw new Refused(`${app}/robots.txt names no sitemap, so the app's address is unknown`);
  }

  // The first member only: once anyone is on the team, joined or not, Settings → Team invites.
  const team = await call('GET', '/rest/v1/platform_admins?select=joined_at');
  if (team.status !== 200 || !Array.isArray(team.json)) {
    throw new Failed(`could not read the team (${team.status} ${said(team)}); nothing was made`);
  }
  if (team.json.length) {
    const joined = team.json.filter((member) => member.joined_at).length;
    throw new Refused(
      joined
        ? `the platform already has ${team.json.length} team member(s), ${joined} joined: invite others from /super, Settings → Team`
        : `an earlier invite is still waiting (${team.json.length} team member(s), none joined): open its link, or remove it as docs/RUNBOOK.md says and run this again`,
    );
  }

  // The login, asked for without a password (GoTrue gives it a random one nobody knows), as the
  // Team page makes it: the join page sets the member's own (src/app/login/join/actions.ts).
  const created = await call('POST', '/auth/v1/admin/users', { email, email_confirm: true });
  if (created.json?.error_code === 'email_exists') {
    throw new Refused(`${email} already has a login; nothing was changed`);
  }
  // GoTrue's own errors are JSON with an error_code, and leave nothing made. No answer at all, or
  // a 5xx without one (the gateway's own 502, 503 or 504 in plain text, when GoTrue's connection
  // broke or the route's 30 s ran out), leaves it unknown: GoTrue may have made the login before
  // its answer was lost.
  if (created.status === 0 || (created.status >= 500 && !created.json?.error_code)) {
    const lost =
      created.status === 0
        ? `no answer to making the login (${said(created)})`
        : `no answer from GoTrue to making the login (${created.status} from the gateway)`;
    throw new Failed(`${lost}: if ${email} has a login now, remove it before running this again`);
  }
  const userId = created.json?.id;
  if (created.status < 200 || created.status > 299 || typeof userId !== 'string') {
    throw new Failed(
      `could not make the login (${created.status} ${said(created)}); nothing was made`,
    );
  }

  // The invite as platform_invite_member inserts it, invited by nobody: the token goes only into
  // the link, its keyed hash into the row, as hashCode('team-invite', token) computes it
  // (src/lib/one-time-code.ts).
  const token = randomBytes(32).toString('base64url');
  const hash = createHmac('sha256', cookieSecret).update(`team-invite-code:${token}`).digest('hex');
  const invitedAt = new Date();
  const expiresAt = new Date(invitedAt.getTime() + INVITE_DAYS * 86_400_000);
  const inserted = await call('POST', '/rest/v1/platform_admins', {
    user_id: userId,
    role: 'admin',
    display_name: name,
    invited_by: null,
    invited_at: invitedAt.toISOString(),
    joined_at: null,
    // 'money.view' = any(private.role_permissions('admin')): an Admin gets the digest.
    digest: true,
    invite_token_hash: hash,
    invite_expires_at: expiresAt.toISOString(),
  });
  if (inserted.status !== 201) {
    // Left behind, the login would block this email from another try, as inviteMember says. A
    // row added without its answer goes with the login (on delete cascade).
    const removed = await call('DELETE', `/auth/v1/admin/users/${userId}`);
    const why = `could not add the invite (${inserted.status} ${said(inserted)})`;
    if (removed.status >= 200 && removed.status <= 299) {
      throw new Failed(`${why}; the login it made was removed again, so nothing is left`);
    }
    throw new Failed(
      `${why}, nor remove the login it made for ${email}, user ${userId} (${removed.status} ${said(removed)}): remove that login before running this again`,
    );
  }

  // India keeps no summer time: IST is always UTC+05:30.
  const minute = (date) => date.toISOString().slice(0, 16).replace('T', ' ');
  const ist = minute(new Date(expiresAt.getTime() + 330 * 60_000));
  console.log(
    [
      `first-admin: ${email} (${name}) is invited as the platform's first Admin. The join link:`,
      '',
      `  ${appUrl}/login/join?token=${token}`,
      '',
      `It works once, until ${minute(expiresAt)} UTC (${ist} IST), and is shown only here: the`,
      'server keeps only its hash. Warning: until it is used or expires, whoever opens it becomes',
      `the platform admin. Keep it to yourself and open it only once ${new URL(appUrl).host} is served`,
      'from this server; choose the password there, and /super then asks for an authenticator app.',
    ].join('\n'),
  );
}

try {
  await main();
} catch (error) {
  // Its own messages whole (what they quote from outside is capped already), anything else as
  // the error says it. exitCode rather than exit(): a pipe gets every line before Node ends.
  const known = error instanceof Refused || error instanceof Failed;
  console.error(
    `first-admin: ${error instanceof Refused ? 'refused' : 'failed'}: ${known ? error.message : reason(error)}`,
  );
  process.exitCode = error instanceof Refused ? 2 : 1;
}
