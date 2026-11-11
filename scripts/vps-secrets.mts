/**
 * Writes the shared server's secrets (docs/DECISIONS.md VPS-36): the .env that deploy/vps/compose.yml
 * reads and the two app settings files, made from the templates in deploy/vps/env/. Every value the
 * stack makes for itself is generated here, in the formats of self-hosted Supabase's own key scripts
 * (v0.8.4, docker/utils/generate-keys.sh and add-new-auth-keys.sh), with Node's crypto only. The
 * owner's values from other accounts stay empty under a "# FILL IN" line. Files are 0600, values are
 * never printed, and existing files are kept unless --force.
 *
 *   pnpm vps:secrets --out <dir>                         the server's .env, env/web.env and
 *                                                        env/web-staging.env
 *   pnpm vps:secrets --rehearsal [--out .vps-rehearsal]  throwaway values for the local rehearsal,
 *                                                        and a throwaway age key in age/identity.txt
 *   pnpm vps:secrets --check <dir> [--rehearsal]         checks the files in <dir>, by name only
 *
 * Inside this repository it writes only where git ignores the files (.vps-rehearsal/), so a secret
 * can't be committed by accident. --force replaces files: a running stack keeps its old values (the
 * database keeps its password), so new ones are for a new install or a planned rotation only.
 */
import { spawnSync } from 'node:child_process';
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

/** The repository: the templates are read from it, and nothing it tracks is ever written. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES = join(ROOT, 'deploy', 'vps', 'env');

const USAGE = `Usage: pnpm vps:secrets --out <dir> [--force]
       pnpm vps:secrets --rehearsal [--out .vps-rehearsal] [--force]
       pnpm vps:secrets --check <dir> [--rehearsal]`;

// The key scripts' constants: the project ref in the opaque keys' checksum, and how long the
// API-key JWTs last.
const PROJECT_REF = 'supabase-self-hosted';
const FIVE_YEARS = 5 * 365 * 24 * 3600;
export const PUBLISHABLE_PREFIX = 'sb_publishable_';
export const SECRET_PREFIX = 'sb_secret_';

/** The public addresses: the server's, and the rehearsal's on this machine (docs/DECISIONS.md VPS-42). */
export const PRODUCTION = { siteUrl: 'https://menumesh.in', publicUrl: 'https://api.menumesh.in' };
export const REHEARSAL = {
  siteUrl: 'http://localhost:3300',
  publicUrl: 'http://127.0.0.1:8300',
  // The rehearsal's S3 stand-in on its own network, and the bucket the backup writes to.
  s3Endpoint: 'http://s3:9000',
  bucket: 'menumesh-rehearsal',
};

export type Values = Record<string, string>;
export type Mode = 'production' | 'rehearsal';

// ─── Generation ──────────────────────────────────────────────────────────────

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const base64url = (bytes: number) => randomBytes(bytes).toString('base64url');
const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');

/** The opaque keys' checksum: the first 8 base64url characters of sha256("<ref>|<prefix><random>"). */
export function opaqueKeyChecksum(prefixAndRandom: string) {
  return createHash('sha256')
    .update(`${PROJECT_REF}|${prefixAndRandom}`)
    .digest('base64url')
    .slice(0, 8);
}

/** sb_publishable_ or sb_secret_, 22 random base64url characters, "_" and the checksum. */
export function opaqueKey(prefix: string) {
  const intermediate = prefix + randomBytes(17).toString('base64url').slice(0, 22);
  return `${intermediate}_${opaqueKeyChecksum(intermediate)}`;
}

type Claims = { role: string; iss: string; iat: number; exp: number };

function hs256(claims: Claims, secret: string) {
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}

function es256(claims: Claims, key: KeyObject, kid: string) {
  const data = `${encode({ alg: 'ES256', typ: 'JWT', kid })}.${encode(claims)}`;
  const signature = sign('SHA256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${signature.toString('base64url')}`;
}

/**
 * The Supabase stack's keys, as the two key scripts make them: the legacy HS256 secret and its two
 * API keys; an ES256 pair as Auth's signing keys and as the other services' JWKS, each with the
 * HS256 secret as an oct key; the two roles as ES256 tokens; and the opaque keys Envoy swaps for
 * those. Hex and base64url only, so a value is safe in a URL, in Envoy's sed and in an env file.
 */
export function supabaseKeys(now = Date.now()) {
  const jwtSecret = base64url(48);
  const iat = Math.floor(now / 1000);
  const claims = (role: string): Claims => ({ role, iss: 'supabase', iat, exp: iat + FIVE_YEARS });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { crv, x, y, d } = privateKey.export({ format: 'jwk' });
  const kid = randomUUID();
  const oct = { kty: 'oct', k: Buffer.from(jwtSecret).toString('base64url'), alg: 'HS256' };
  // In the key script's member order: Auth signs with the private key, the others check tokens
  // with the public one.
  const signing = { kty: 'EC', kid, use: 'sig', key_ops: ['sign', 'verify'], alg: 'ES256' };
  const checking = { kty: 'EC', kid, use: 'sig', key_ops: ['verify'], alg: 'ES256' };
  return {
    values: {
      POSTGRES_PASSWORD: hex(16),
      JWT_SECRET: jwtSecret,
      JWT_KEYS: JSON.stringify([{ ...signing, ext: true, crv, x, y, d }, oct]),
      JWT_JWKS: JSON.stringify({ keys: [{ ...checking, ext: true, crv, x, y }, oct] }),
      ANON_KEY: hs256(claims('anon'), jwtSecret),
      SERVICE_ROLE_KEY: hs256(claims('service_role'), jwtSecret),
      ANON_KEY_ASYMMETRIC: es256(claims('anon'), privateKey, kid),
      SERVICE_ROLE_KEY_ASYMMETRIC: es256(claims('service_role'), privateKey, kid),
      SUPABASE_PUBLISHABLE_KEY: opaqueKey(PUBLISHABLE_PREFIX),
      SUPABASE_SECRET_KEY: opaqueKey(SECRET_PREFIX),
      SECRET_KEY_BASE: base64url(48),
      REALTIME_DB_ENC_KEY: hex(8),
    } satisfies Values,
    expires: new Date((iat + FIVE_YEARS) * 1000),
  };
}

// age's keys are Bech32 (BIP 173, with no length limit): "age" and the X25519 public key for a
// recipient, "AGE-SECRET-KEY-" and the private key, in capitals, for an identity.
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values: number[]) {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) check ^= generator[i];
  }
  return check;
}

const expandPrefix = (prefix: string) => [
  ...[...prefix].map((char) => char.charCodeAt(0) >>> 5),
  0,
  ...[...prefix].map((char) => char.charCodeAt(0) & 31),
];

/** Bech32 of the bytes in lower case (age writes an identity in capitals). */
export function bech32Encode(prefix: string, bytes: Uint8Array) {
  const words: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((buffer >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((buffer << (5 - bits)) & 31);
  const check = polymod([...expandPrefix(prefix), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const sum = [0, 1, 2, 3, 4, 5].map((i) => (check >>> (5 * (5 - i))) & 31);
  return `${prefix}1${[...words, ...sum].map((word) => BECH32[word]).join('')}`;
}

/** The prefix and bytes of Bech32 text in one case; null when it isn't valid Bech32. */
export function bech32Decode(text: string): { prefix: string; bytes: Buffer } | null {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return null;
  const lower = text.toLowerCase();
  const split = lower.lastIndexOf('1');
  if (split < 1 || lower.length - split < 7) return null;
  const prefix = lower.slice(0, split);
  const words = [...lower.slice(split + 1)].map((char) => BECH32.indexOf(char));
  if (words.includes(-1) || polymod([...expandPrefix(prefix), ...words]) !== 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const word of words.slice(0, -6)) {
    buffer = ((buffer << 5) | word) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  if (bits >= 5 || (buffer & ((1 << bits) - 1)) !== 0) return null;
  return { prefix, bytes: Buffer.from(bytes) };
}

/** An age X25519 key pair: the recipient (age1...) and an identity file, as age-keygen writes. */
export function ageKeyPair(now = new Date()) {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const d = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
  const x = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const recipient = bech32Encode('age', x);
  const identity = bech32Encode('age-secret-key-', d).toUpperCase();
  const created = `${now.toISOString().slice(0, 19)}Z`;
  return {
    recipient,
    identityFile: `# created: ${created}\n# public key: ${recipient}\n${identity}\n`,
  };
}

// ─── The files ───────────────────────────────────────────────────────────────

type FileSpec = {
  /** Where it goes in --out, and its template in deploy/vps/env/. */
  path: string;
  template: string;
  /** Required values from the owner's accounts: empty under a "# FILL IN" line until then. */
  owner: string[];
  /** Values that may stay empty: a feature off, or the app's default. */
  optional: string[];
};

/** Each name in a template is generated, set here, the owner's, or optional, and nothing else. */
export const FILES: FileSpec[] = [
  {
    path: '.env',
    template: 'project.env.example',
    owner: [
      'BACKUP_AGE_RECIPIENT',
      'BACKUP_BUCKET',
      'BACKUP_S3_PROVIDER',
      'BACKUP_S3_ENDPOINT',
      'BACKUP_S3_ACCESS_KEY_ID',
      'BACKUP_S3_SECRET_ACCESS_KEY',
      'STAGING_DB_HOST',
      'STAGING_DB_USER',
      'STAGING_DB_PASSWORD',
    ],
    optional: [
      'BACKUP_S3_REGION',
      'HEARTBEAT_DAILY_URL',
      'HEARTBEAT_DIGEST_URL',
      'HEARTBEAT_JOBS_URL',
      'STAGING_HEARTBEAT_DAILY_URL',
      'STAGING_HEARTBEAT_DIGEST_URL',
      'STAGING_HEARTBEAT_JOBS_URL',
      'HEARTBEAT_BACKUP_URL',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      // Named on the one run that needs it, never kept in the file.
      'RESTORE_STAMP',
    ],
  },
  {
    path: 'env/web.env',
    template: 'web.env.example',
    owner: [
      'RAZORPAY_KEY_ID',
      'RAZORPAY_KEY_SECRET',
      'RAZORPAY_WEBHOOK_SECRET',
      'RESEND_API_KEY',
      'EMAIL_FROM',
      'RESEND_WEBHOOK_SECRET',
      'MENU_IMPORT_API_KEY',
      'MENU_IMPORT_FALLBACK_API_KEY',
      'TURNSTILE_SITE_KEY',
      'TURNSTILE_SECRET_KEY',
      'SENTRY_READ_TOKEN',
      'SENTRY_ORG',
      'SENTRY_PROJECT',
    ],
    optional: [
      'MENU_IMPORT_BASE_URL',
      'MENU_IMPORT_MODEL',
      'MENU_IMPORT_FALLBACK_BASE_URL',
      'MENU_IMPORT_FALLBACK_MODEL',
      'MENU_IMPORT_USD_INR',
      'PRODUCTION_APP_URL',
      'STAGING_APP_URL',
      'PLATFORM_TRIAL_DAYS',
      'PLATFORM_GRACE_DAYS',
    ],
  },
  {
    path: 'env/web-staging.env',
    template: 'web-staging.env.example',
    owner: [
      'SUPABASE_SECRET_KEY',
      'RAZORPAY_KEY_ID',
      'RAZORPAY_KEY_SECRET',
      'RAZORPAY_WEBHOOK_SECRET',
    ],
    optional: [
      'RESEND_API_KEY',
      'EMAIL_FROM',
      'RESEND_WEBHOOK_SECRET',
      'MENU_IMPORT_API_KEY',
      'MENU_IMPORT_FALLBACK_API_KEY',
      'MENU_IMPORT_BASE_URL',
      'MENU_IMPORT_MODEL',
      'MENU_IMPORT_FALLBACK_BASE_URL',
      'MENU_IMPORT_FALLBACK_MODEL',
      'MENU_IMPORT_USD_INR',
      'TURNSTILE_SITE_KEY',
      'TURNSTILE_SECRET_KEY',
      'SENTRY_READ_TOKEN',
      'SENTRY_ORG',
      'SENTRY_PROJECT',
      'PRODUCTION_APP_URL',
      'STAGING_APP_URL',
      'PLATFORM_TRIAL_DAYS',
      'PLATFORM_GRACE_DAYS',
    ],
  },
];

/** The rehearsal's throwaway age key, for its restore test (mounted on /run/age). */
export const AGE_IDENTITY = 'age/identity.txt';

/** Each file's values. A rehearsal also gives the backup's owner-supplied names throwaway values. */
export function generate(mode: Mode, now = new Date()) {
  const { values: keys, expires } = supabaseKeys(now.getTime());
  const urls = mode === 'production' ? PRODUCTION : REHEARSAL;
  const project: Values = {
    ...keys,
    SITE_URL: urls.siteUrl,
    SUPABASE_PUBLIC_URL: urls.publicUrl,
    // Production's and staging's each their own.
    CRON_SECRET: base64url(32),
    STAGING_CRON_SECRET: base64url(32),
  };
  // A rehearsal's staff logins use the domain the end-to-end tests expect.
  const web: Values = {
    STAFF_EMAIL_DOMAIN: mode === 'production' ? 'menumesh.in' : 'tableorder.test',
    CUSTOMER_COOKIE_SECRET: base64url(32),
  };
  const staging: Values = {
    STAFF_EMAIL_DOMAIN: mode === 'production' ? 'staging.menumesh.in' : 'tableorder.test',
    CUSTOMER_COOKIE_SECRET: base64url(32),
  };
  let identityFile: string | undefined;
  if (mode === 'rehearsal') {
    const age = ageKeyPair(now);
    identityFile = age.identityFile;
    Object.assign(project, {
      BACKUP_AGE_RECIPIENT: age.recipient,
      BACKUP_BUCKET: REHEARSAL.bucket,
      BACKUP_S3_PROVIDER: 'Other',
      BACKUP_S3_ENDPOINT: REHEARSAL.s3Endpoint,
      BACKUP_S3_ACCESS_KEY_ID: hex(16),
      BACKUP_S3_SECRET_ACCESS_KEY: hex(32),
      // Never reached: the rehearsal keeps the staging services off.
      STAGING_DB_HOST: 'staging-db.invalid',
      STAGING_DB_USER: 'postgres.rehearsal',
      STAGING_DB_PASSWORD: hex(16),
    });
    // Stands in for the hosted staging project's key.
    staging.SUPABASE_SECRET_KEY = opaqueKey(SECRET_PREFIX);
  }
  return { values: [project, web, staging], expires, identityFile };
}

/** A value as an env file line holds it: JSON in single quotes, which Compose and Node both read. */
function quote(name: string, value: string) {
  if (/['\r\n]/.test(value)) throw new Error(`${name} can't go in an env file`);
  return /^[A-Za-z0-9._~:/@+=,-]*$/.test(value) ? value : `'${value}'`;
}

/** The names a template sets, in order. */
export const templateNames = (text: string) =>
  [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);

/**
 * The template with the values filled in, under a header. With `mark`, an empty "# FILL IN" line
 * goes above each of the owner's names still empty.
 */
export function render(
  spec: FileSpec,
  template: string,
  values: Values,
  header: string[],
  mark: boolean,
) {
  const known = new Set([...Object.keys(values), ...spec.owner, ...spec.optional]);
  const names = templateNames(template);
  const drift = [
    ...names.filter((name) => !known.has(name)),
    ...[...known].filter((name) => !names.includes(name)),
  ];
  if (drift.length) {
    throw new Error(`${spec.template} and scripts/vps-secrets.mts disagree on ${drift.join(', ')}`);
  }
  const lines = template.split('\n').flatMap((line) => {
    const name = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (!name) return [line];
    if (name in values) return [`${name}=${quote(name, values[name])}`];
    return mark && spec.owner.includes(name) ? ['# FILL IN', `${name}=`] : [`${name}=`];
  });
  return `${header.map((line) => `# ${line}`).join('\n')}\n#\n${lines.join('\n')}`;
}

// ─── Checks ──────────────────────────────────────────────────────────────────

/** A JWT's decoded parts; null unless it has three that decode. */
function parts(token: string) {
  const split = token.split('.');
  if (split.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(split[0], 'base64url').toString()),
      claims: JSON.parse(Buffer.from(split[1], 'base64url').toString()),
      data: `${split[0]}.${split[1]}`,
      signature: Buffer.from(split[2], 'base64url'),
    };
  } catch {
    return null;
  }
}

/** Whether an opaque key has the prefix, 22 random characters, "_" and a matching checksum. */
export function isOpaqueKey(key: string, prefix: string) {
  const body = key.slice(prefix.length);
  return (
    key.startsWith(prefix) &&
    /^[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$/.test(body) &&
    body.slice(23) === opaqueKeyChecksum(prefix + body.slice(0, 22))
  );
}

/** What Envoy's sed and Lua can hold: no "|", "&", "\" or quotes. */
const ENVOY_SAFE = /^[A-Za-z0-9._-]+$/;

/** The origin of an address, or '' when it isn't one. */
function originOf(text: string) {
  try {
    return new URL(text).origin;
  } catch {
    return '';
  }
}

/**
 * Problems with the Supabase keys, by name only: shapes, signatures, the JWKS against the signing
 * keys, the checksums. Accepts the key scripts' own output too, whose secrets are plain base64.
 */
export function checkSupabaseKeys(values: Values, now = Date.now()): string[] {
  const problems: string[] = [];
  const need = (name: string) => {
    const value = values[name] ?? '';
    if (!value) problems.push(`${name} is empty`);
    return value;
  };
  const password = need('POSTGRES_PASSWORD');
  if (password && !/^[A-Za-z0-9._~-]{32,}$/.test(password)) {
    problems.push(
      'POSTGRES_PASSWORD needs 32 or more letters, digits, ".", "_", "~" or "-" (it goes into postgres:// addresses as it is)',
    );
  }
  const secret = need('JWT_SECRET');
  if (secret && (!/^[!-~]{32,}$/.test(secret) || /['"\\]/.test(secret))) {
    problems.push(
      'JWT_SECRET needs 32 or more printable characters, without quotes or backslashes',
    );
  }
  const base = need('SECRET_KEY_BASE');
  if (base && base.length < 64) problems.push('SECRET_KEY_BASE needs 64 or more characters');
  const enc = need('REALTIME_DB_ENC_KEY');
  if (enc && enc.length !== 16) problems.push('REALTIME_DB_ENC_KEY must be exactly 16 characters');

  // Auth's signing keys, and the JWKS the other services check tokens with.
  const oct = secret ? Buffer.from(secret).toString('base64url') : undefined;
  const isOct = (key: { kty?: string; k?: string; alg?: string } | null) =>
    key?.kty === 'oct' && key.k === oct && key.alg === 'HS256';
  let publicKey: KeyObject | undefined;
  let kid: string | undefined;
  try {
    const keys = JSON.parse(need('JWT_KEYS') || 'null');
    const ec = Array.isArray(keys) ? keys.find((key) => key?.kty === 'EC') : undefined;
    if (!ec || keys.length !== 2) throw new Error('JWT_KEYS must hold one EC key and the oct key');
    if (ec.alg !== 'ES256' || ec.crv !== 'P-256' || !ec.d || !ec.kid) {
      throw new Error('JWT_KEYS: the EC key must be a P-256 private key for ES256, with a kid');
    }
    if (!ec.key_ops?.includes('sign')) throw new Error("JWT_KEYS: the EC key can't sign");
    if (!keys.some(isOct)) throw new Error('JWT_KEYS: the oct key is not JWT_SECRET');
    const derived = createPublicKey(createPrivateKey({ key: ec, format: 'jwk' }));
    const own = derived.export({ format: 'jwk' });
    if (own.x !== ec.x || own.y !== ec.y) {
      throw new Error("JWT_KEYS: the EC key's public part is not its private key's");
    }
    publicKey = derived;
    kid = ec.kid;
  } catch (error) {
    problems.push(error instanceof SyntaxError ? 'JWT_KEYS is not JSON' : (error as Error).message);
  }
  try {
    const keys = JSON.parse(need('JWT_JWKS') || 'null')?.keys;
    if (!Array.isArray(keys) || keys.length !== 2) {
      throw new Error('JWT_JWKS must be {"keys":[the EC public key, the oct key]}');
    }
    if (keys.some((key) => key && 'd' in key)) throw new Error('JWT_JWKS holds a private key');
    const ec = keys.find((key) => key?.kty === 'EC');
    const own = publicKey?.export({ format: 'jwk' });
    if (own && (ec?.kid !== kid || ec?.x !== own.x || ec?.y !== own.y || ec?.alg !== 'ES256')) {
      throw new Error("JWT_JWKS's EC key is not JWT_KEYS's public key");
    }
    if (!keys.some(isOct)) throw new Error('JWT_JWKS: the oct key is not JWT_SECRET');
  } catch (error) {
    problems.push(error instanceof SyntaxError ? 'JWT_JWKS is not JSON' : (error as Error).message);
  }

  // The four API-key JWTs: algorithm, signature, role, issuer, expiry.
  const tokens: [name: string, role: string, alg: 'HS256' | 'ES256'][] = [
    ['ANON_KEY', 'anon', 'HS256'],
    ['SERVICE_ROLE_KEY', 'service_role', 'HS256'],
    ['ANON_KEY_ASYMMETRIC', 'anon', 'ES256'],
    ['SERVICE_ROLE_KEY_ASYMMETRIC', 'service_role', 'ES256'],
  ];
  for (const [name, role, alg] of tokens) {
    const token = need(name);
    if (!token) continue;
    const jwt = parts(token);
    if (!jwt || !ENVOY_SAFE.test(token)) {
      problems.push(`${name} is not a JWT`);
      continue;
    }
    if (jwt.header.alg !== alg || (alg === 'ES256' && jwt.header.kid !== kid)) {
      problems.push(
        `${name} must be signed ${alg}${alg === 'ES256' ? " with JWT_KEYS's kid" : ''}`,
      );
    } else if (alg === 'HS256' && secret) {
      const expected = createHmac('sha256', secret).update(jwt.data).digest();
      if (expected.length !== jwt.signature.length || !timingSafeEqual(expected, jwt.signature)) {
        problems.push(`${name} is not signed with JWT_SECRET`);
      }
    } else if (alg === 'ES256' && publicKey) {
      const key = { key: publicKey, dsaEncoding: 'ieee-p1363' as const };
      if (!verify('SHA256', Buffer.from(jwt.data), key, jwt.signature)) {
        problems.push(`${name} is not signed with JWT_KEYS's EC key`);
      }
    }
    if (jwt.claims.role !== role || jwt.claims.iss !== 'supabase') {
      problems.push(`${name} must have the role ${role} and the issuer supabase`);
    }
    if (!(jwt.claims.exp * 1000 > now)) problems.push(`${name} has expired`);
  }

  for (const [name, prefix] of [
    ['SUPABASE_PUBLISHABLE_KEY', PUBLISHABLE_PREFIX],
    ['SUPABASE_SECRET_KEY', SECRET_PREFIX],
  ]) {
    const key = need(name);
    if (key && !isOpaqueKey(key, prefix)) {
      problems.push(`${name} is not ${prefix}, 22 characters, "_" and its checksum`);
    }
  }
  return problems;
}

/** When the API-key JWTs expire: the earliest of the four. */
export function apiKeysExpire(values: Values) {
  const names = [
    'ANON_KEY',
    'SERVICE_ROLE_KEY',
    'ANON_KEY_ASYMMETRIC',
    'SERVICE_ROLE_KEY_ASYMMETRIC',
  ];
  const times = names
    .map((name) => parts(values[name] ?? '')?.claims.exp)
    .filter((exp): exp is number => typeof exp === 'number');
  return times.length ? new Date(Math.min(...times) * 1000) : null;
}

/** An age recipient: age1 and a valid Bech32 X25519 public key. */
export function isAgeRecipient(text: string) {
  const decoded = /^age1[02-9ac-hj-np-z]+$/.test(text) ? bech32Decode(text) : null;
  return decoded?.prefix === 'age' && decoded.bytes.length === 32;
}

/**
 * Problems in each of the three files (.env, env/web.env, env/web-staging.env), by name only. A
 * rehearsal's app files may leave the owner's names empty.
 */
export function checkFiles([project, web, staging]: Values[], mode: Mode): string[][] {
  const own = checkSupabaseKeys(project);
  const forWeb: string[] = [];
  const forStaging: string[] = [];
  for (const name of ['SITE_URL', 'SUPABASE_PUBLIC_URL']) {
    if (!project[name] || originOf(project[name]) !== project[name]) {
      own.push(
        `${name} must be an address alone, like https://menumesh.in: no path, no "/" at the end`,
      );
    }
  }
  for (const name of ['CRON_SECRET', 'STAGING_CRON_SECRET']) {
    if (!/^[A-Za-z0-9._~+/=-]{32,}$/.test(project[name] ?? '')) {
      own.push(`${name} needs 32 or more letters and digits (base64url)`);
    }
  }
  if (project.CRON_SECRET && project.CRON_SECRET === project.STAGING_CRON_SECRET) {
    own.push('CRON_SECRET and STAGING_CRON_SECRET must differ');
  }
  if (project.BACKUP_AGE_RECIPIENT && !isAgeRecipient(project.BACKUP_AGE_RECIPIENT)) {
    own.push('BACKUP_AGE_RECIPIENT is not an age public key (age1...)');
  }
  const lists = [own, forWeb, forStaging];
  [project, web, staging].forEach((values, index) => {
    if (mode === 'rehearsal' && index > 0) return;
    for (const name of FILES[index].owner)
      if (!values[name]) lists[index].push(`${name} is still to fill in`);
  });
  for (const [values, list] of [
    [web, forWeb],
    [staging, forStaging],
  ] as const) {
    if ((values.CUSTOMER_COOKIE_SECRET ?? '').length < 32) {
      list.push('CUSTOMER_COOKIE_SECRET needs 32 or more characters');
    }
    if (!values.STAFF_EMAIL_DOMAIN) list.push('STAFF_EMAIL_DOMAIN is empty');
  }
  if (web.CUSTOMER_COOKIE_SECRET && web.CUSTOMER_COOKIE_SECRET === staging.CUSTOMER_COOKIE_SECRET) {
    forStaging.push("CUSTOMER_COOKIE_SECRET must not be production's");
  }
  if (staging.SUPABASE_SECRET_KEY && staging.SUPABASE_SECRET_KEY === project.SUPABASE_SECRET_KEY) {
    forStaging.push("SUPABASE_SECRET_KEY must be the hosted staging project's, not production's");
  }
  return lists;
}

// ─── The command ─────────────────────────────────────────────────────────────

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** Inside the repository, writes only where git ignores the file: a secret is never committed. */
function refuseTracked(paths: string[]) {
  const inside = paths.filter((path) => {
    const rel = relative(ROOT, path);
    return !rel.startsWith('..') && !isAbsolute(rel);
  });
  if (!inside.length) return;
  // Names the paths git ignores; a tracked file is never among them.
  const result = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: ROOT,
    input: inside.map((path) => relative(ROOT, path).replaceAll('\\', '/')).join('\n'),
    encoding: 'utf8',
  });
  const ignored = new Set(
    (result.stdout ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => resolve(ROOT, line)),
  );
  const exposed = inside.filter((path) => !ignored.has(path));
  if (exposed.length) {
    fail(
      `git doesn't ignore ${exposed.map((path) => relative(ROOT, path)).join(', ')}: ` +
        'write outside the repository, or into .vps-rehearsal/',
    );
  }
}

/** Writes a file 0600 in a 0700 folder, through a rename, so a file is whole or not there. */
function writePrivate(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function write(mode: Mode, out: string, force: boolean) {
  const now = new Date();
  const { values, expires, identityFile } = generate(mode, now);
  const targets = FILES.map((spec) => join(out, spec.path));
  if (identityFile) targets.push(join(out, AGE_IDENTITY));
  refuseTracked(targets);
  const shown = (path: string) => relative(process.cwd(), path) || path;
  const present = targets.filter((path) => existsSync(path));
  if (present.length && !force) {
    fail(
      `${present.map(shown).join(', ')} already exist: --force replaces them, and a running stack ` +
        'keeps its old values (the database keeps its password)',
    );
  }
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const written = `Written by pnpm vps:secrets (${mode}) on ${day(now)}.`;
  const header =
    mode === 'production'
      ? [written, 'Fill in each line under "# FILL IN" before installing.']
      : [written];
  FILES.forEach((spec, index) => {
    const template = readFileSync(join(TEMPLATES, spec.template), 'utf8');
    const lines =
      index === 0 ? [...header, `The four API-key JWTs expire on ${day(expires)}.`] : header;
    writePrivate(
      targets[index],
      render(spec, template, values[index], lines, mode === 'production'),
    );
  });
  if (identityFile) writePrivate(join(out, AGE_IDENTITY), identityFile);

  console.log(`✔ Wrote ${targets.map(shown).join(', ')} (0600)`);
  console.log(`  The four API-key JWTs expire on ${day(expires)}.`);
  if (mode === 'production') {
    for (const spec of FILES) console.log(`  To fill in, ${spec.path}: ${spec.owner.join(', ')}`);
    console.log(
      '  Optional, empty = off: the heartbeat URLs, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and BACKUP_S3_REGION.',
    );
    console.log(
      "  SUPABASE_PUBLISHABLE_KEY is also the production image's NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY " +
        '(the GitHub variable PRODUCTION_SUPABASE_PUBLISHABLE_KEY).',
    );
  }
}

function check(dir: string, mode: Mode) {
  const values = FILES.map((spec) => {
    const path = join(dir, spec.path);
    if (!existsSync(path)) fail(`No ${path}`);
    return parseEnv(readFileSync(path, 'utf8')) as Values;
  });
  const problems = checkFiles(values, mode);
  FILES.forEach((spec, index) => {
    if (!problems[index].length) console.log(`✔ ${spec.path}`);
    for (const problem of problems[index]) console.error(`✖ ${spec.path}: ${problem}`);
  });
  const expires = apiKeysExpire(values[0]);
  if (expires) console.log(`  The API-key JWTs expire on ${expires.toISOString().slice(0, 10)}.`);
  if (problems.some((list) => list.length)) process.exit(1);
}

if (import.meta.main) {
  const { values: args } = parseArgs({
    options: {
      out: { type: 'string' },
      rehearsal: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      check: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  const mode: Mode = args.rehearsal ? 'rehearsal' : 'production';
  if (args.help) {
    console.log(USAGE);
  } else if (args.check) {
    check(resolve(args.check), mode);
  } else if (args.rehearsal || args.out) {
    write(mode, resolve(args.out ?? '.vps-rehearsal'), args.force!);
  } else {
    fail(USAGE);
  }
}
