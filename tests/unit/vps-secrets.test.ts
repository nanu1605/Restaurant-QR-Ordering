import { execFile } from 'node:child_process';
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import {
  AGE_IDENTITY,
  ageKeyPair,
  bech32Decode,
  bech32Encode,
  checkFiles,
  checkSigningKeys,
  checkSupabaseKeys,
  FILES,
  generate,
  isAgeRecipient,
  isOpaqueKey,
  PUBLISHABLE_PREFIX,
  render,
  SECRET_PREFIX,
  signingKeyPair,
  signingPrivateKey,
  signingPublicKey,
  supabaseKeys,
  templateNames,
  type Values,
} from '../../scripts/vps-secrets.mts';

/**
 * The shared server's secrets (docs/DECISIONS.md VPS-36) must be what self-hosted Supabase v0.8.4's
 * own key scripts make (docker/utils/generate-keys.sh and add-new-auth-keys.sh): Auth, PostgREST,
 * Realtime, Storage and Envoy only work together when every key, JWKS and checksum matches. These
 * checks rebuild each format with Node's crypto, apart from the generator's code.
 */

const keys = supabaseKeys();
const v = keys.values;
const decode = (part: string) => Buffer.from(part, 'base64url').toString();
const FIVE_YEARS = 5 * 365 * 24 * 3600;

describe('the Supabase keys', () => {
  it('have the key scripts’ shapes: hex and base64url only', () => {
    expect(v.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{32}$/);
    expect(v.JWT_SECRET).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(v.SECRET_KEY_BASE).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(v.REALTIME_DB_ENC_KEY).toMatch(/^[0-9a-f]{16}$/);
    // Safe in Envoy's sed (| is its delimiter), its Lua strings and an env file.
    for (const [name, value] of Object.entries(v)) {
      if (name === 'JWT_KEYS' || name === 'JWT_JWKS') expect(value).not.toMatch(/['\\|&\s]/);
      else expect(value, name).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });

  it('are new on every run', () => {
    const again = supabaseKeys().values;
    for (const name of Object.keys(v) as (keyof typeof v)[]) expect(again[name]).not.toBe(v[name]);
  });

  it('give Auth an ES256 signing key and the HS256 secret, in the key script’s member order', () => {
    const [ec, oct] = JSON.parse(v.JWT_KEYS);
    expect(Object.keys(ec)).toEqual([
      'kty',
      'kid',
      'use',
      'key_ops',
      'alg',
      'ext',
      'crv',
      'x',
      'y',
      'd',
    ]);
    expect(ec).toMatchObject({ kty: 'EC', use: 'sig', key_ops: ['sign', 'verify'], alg: 'ES256' });
    expect(ec).toMatchObject({ ext: true, crv: 'P-256' });
    expect(ec.kid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // The oct key is the secret's own bytes, base64url: what Auth signs HS256 tokens with.
    expect(oct).toEqual({
      kty: 'oct',
      k: Buffer.from(v.JWT_SECRET).toString('base64url'),
      alg: 'HS256',
    });
    expect(Object.keys(oct)).toEqual(['kty', 'k', 'alg']);
  });

  it('give the other services the public key and the HS256 secret, never the private key', () => {
    const [signing] = JSON.parse(v.JWT_KEYS);
    const jwks = JSON.parse(v.JWT_JWKS);
    expect(Object.keys(jwks)).toEqual(['keys']);
    const [ec, oct] = jwks.keys;
    expect(Object.keys(ec)).toEqual([
      'kty',
      'kid',
      'use',
      'key_ops',
      'alg',
      'ext',
      'crv',
      'x',
      'y',
    ]);
    expect(ec).toMatchObject({ kid: signing.kid, key_ops: ['verify'], x: signing.x, y: signing.y });
    expect(oct).toEqual(JSON.parse(v.JWT_KEYS)[1]);
    expect(v.JWT_JWKS).not.toContain('"d"');
    // The public key really is the private key's.
    const derived = createPublicKey(createPrivateKey({ key: signing, format: 'jwk' }));
    expect(derived.export({ format: 'jwk' })).toMatchObject({ x: ec.x, y: ec.y });
  });

  it('sign the two legacy API keys HS256 with the secret, for five years', () => {
    for (const [name, role] of [
      ['ANON_KEY', 'anon'],
      ['SERVICE_ROLE_KEY', 'service_role'],
    ] as const) {
      const [header, claims, signature] = v[name].split('.');
      expect(decode(header)).toBe('{"alg":"HS256","typ":"JWT"}');
      const { iat } = JSON.parse(decode(claims));
      expect(decode(claims)).toBe(
        `{"role":"${role}","iss":"supabase","iat":${iat},"exp":${iat + FIVE_YEARS}}`,
      );
      const expected = createHmac('sha256', v.JWT_SECRET).update(`${header}.${claims}`);
      expect(signature).toBe(expected.digest('base64url'));
    }
  });

  it('sign the same roles ES256 with the kid, checked against the JWKS', () => {
    const [ec] = JSON.parse(v.JWT_JWKS).keys;
    const publicKey = createPublicKey({ key: ec, format: 'jwk' });
    for (const [name, role] of [
      ['ANON_KEY_ASYMMETRIC', 'anon'],
      ['SERVICE_ROLE_KEY_ASYMMETRIC', 'service_role'],
    ] as const) {
      const [header, claims, signature] = v[name].split('.');
      expect(decode(header)).toBe(`{"alg":"ES256","typ":"JWT","kid":"${ec.kid}"}`);
      const { iat } = JSON.parse(decode(claims));
      expect(decode(claims)).toBe(
        `{"role":"${role}","iss":"supabase","iat":${iat},"exp":${iat + FIVE_YEARS}}`,
      );
      const raw = Buffer.from(signature, 'base64url');
      expect(raw).toHaveLength(64);
      const options = { key: publicKey, dsaEncoding: 'ieee-p1363' as const };
      expect(verify('SHA256', Buffer.from(`${header}.${claims}`), options, raw)).toBe(true);
    }
    expect(keys.expires.getTime() - Date.now()).toBeGreaterThan((FIVE_YEARS - 60) * 1000);
  });

  it('make the opaque keys with the self-hosted checksum', () => {
    for (const [name, prefix] of [
      ['SUPABASE_PUBLISHABLE_KEY', PUBLISHABLE_PREFIX],
      ['SUPABASE_SECRET_KEY', SECRET_PREFIX],
    ] as const) {
      const key = v[name];
      expect(key.startsWith(prefix)).toBe(true);
      const body = key.slice(prefix.length);
      expect(body).toMatch(/^[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$/);
      const intermediate = prefix + body.slice(0, 22);
      const checksum = createHash('sha256').update(`supabase-self-hosted|${intermediate}`);
      expect(body.slice(23)).toBe(checksum.digest('base64url').slice(0, 8));
      expect(isOpaqueKey(key, prefix)).toBe(true);
    }
    expect(isOpaqueKey(v.SUPABASE_SECRET_KEY, PUBLISHABLE_PREFIX)).toBe(false);
  });
});

describe('the key check', () => {
  const problems = (change: Partial<Values>, now?: number) =>
    checkSupabaseKeys({ ...v, ...change } as Values, now);
  const other = supabaseKeys().values;
  /** The text with its last character changed. */
  const flip = (text: string) => text.slice(0, -1) + (text.endsWith('A') ? 'B' : 'A');

  it('accepts a generated set', () => {
    expect(checkSupabaseKeys(v)).toEqual([]);
  });

  it('refuses each broken form, by name only', () => {
    const cases: [Partial<Values>, string][] = [
      [{ SUPABASE_PUBLISHABLE_KEY: flip(v.SUPABASE_PUBLISHABLE_KEY) }, 'SUPABASE_PUBLISHABLE_KEY'],
      [{ SUPABASE_SECRET_KEY: other.SUPABASE_PUBLISHABLE_KEY }, 'SUPABASE_SECRET_KEY'],
      [{ ANON_KEY: other.ANON_KEY }, 'ANON_KEY is not signed with JWT_SECRET'],
      [{ ANON_KEY_ASYMMETRIC: other.ANON_KEY_ASYMMETRIC }, 'ANON_KEY_ASYMMETRIC'],
      [{ SERVICE_ROLE_KEY: v.ANON_KEY }, 'SERVICE_ROLE_KEY must have the role service_role'],
      [{ JWT_JWKS: other.JWT_JWKS }, "JWT_JWKS's EC key is not JWT_KEYS's public key"],
      [
        { JWT_JWKS: JSON.stringify({ keys: JSON.parse(v.JWT_KEYS) }) },
        'JWT_JWKS holds a private key',
      ],
      [{ JWT_KEYS: other.JWT_KEYS }, 'JWT_KEYS: the oct key is not JWT_SECRET'],
      [{ JWT_KEYS: '[{' }, 'JWT_KEYS is not JSON'],
      [{ REALTIME_DB_ENC_KEY: v.REALTIME_DB_ENC_KEY.slice(1) }, 'REALTIME_DB_ENC_KEY'],
      [{ POSTGRES_PASSWORD: `${v.POSTGRES_PASSWORD}@x` }, 'POSTGRES_PASSWORD'],
      [{ SECRET_KEY_BASE: v.SECRET_KEY_BASE.slice(1) }, 'SECRET_KEY_BASE'],
      [{ JWT_SECRET: '' }, 'JWT_SECRET is empty'],
    ];
    for (const [change, expected] of cases) {
      const found = problems(change);
      expect(found.join('\n'), expected).toContain(expected);
      for (const value of Object.values(change)) {
        if (value && value.length > 8) expect(found.join('\n')).not.toContain(value);
      }
    }
    expect(problems({}, keys.expires.getTime() + 1000).join('\n')).toContain(
      'ANON_KEY has expired',
    );
  });
});

describe('the age key of the rehearsal', () => {
  it('encodes Bech32 as BIP 173’s test vectors', () => {
    expect(bech32Encode('a', new Uint8Array())).toBe('a12uel5l');
    const vector = 'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw';
    const decoded = bech32Decode(vector);
    expect(decoded?.prefix).toBe('abcdef');
    expect(bech32Encode('abcdef', decoded!.bytes)).toBe(vector);
    expect(bech32Decode('A12UEL5L')).toEqual({ prefix: 'a', bytes: Buffer.alloc(0) });
    // Invalid: a checksum made with the capital prefix, mixed case, a bad character, no prefix.
    for (const bad of ['A1G7SGD8', 'A12uEL5L', 'x1b4n0q5v', '1pzry9x0s0muk', 'li1dgmt3']) {
      expect(bech32Decode(bad), bad).toBeNull();
    }
  });

  it('pairs a recipient with the identity whose public key it is', () => {
    const { recipient, identityFile } = ageKeyPair(new Date('2026-11-11T12:00:00Z'));
    expect(recipient).toMatch(/^age1[02-9ac-hj-np-z]{58}$/);
    const lines = identityFile.trimEnd().split('\n');
    expect(lines.slice(0, 2)).toEqual([
      '# created: 2026-11-11T12:00:00Z',
      `# public key: ${recipient}`,
    ]);
    expect(lines[2]).toMatch(/^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/);
    const secret = bech32Decode(lines[2])!;
    expect(secret.prefix).toBe('age-secret-key-');
    // X25519: the PKCS #8 form of the 32-byte private key gives the recipient's public key.
    const der = Buffer.concat([
      Buffer.from('302e020100300506032b656e04220420', 'hex'),
      secret.bytes,
    ]);
    const publicKey = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
    const x = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
    expect(bech32Decode(recipient)).toEqual({ prefix: 'age', bytes: x });
    expect(isAgeRecipient(recipient)).toBe(true);
    expect(isAgeRecipient(recipient.slice(0, -1) + (recipient.endsWith('q') ? 'p' : 'q'))).toBe(
      false,
    );
    // Another curve's key in the same text is still refused by length.
    const ed = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
    expect(isAgeRecipient(bech32Encode('age', ed))).toBe(false);
  });
});

describe('the backup’s signing pair', () => {
  const pair = signingKeyPair();
  const other = signingKeyPair();
  const ok: Values = {
    BACKUP_SIGNING_KEY: pair.privateKey,
    BACKUP_SIGNING_PUBLIC_KEY: pair.publicKey,
  };

  it('is an Ed25519 key, base64 PKCS #8 DER, and its own public key, base64 SPKI DER', () => {
    // The fixed DER headers in base64: what seal.sh checks before it hands a key to openssl.
    expect(pair.privateKey).toMatch(/^MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9+/]{43}$/);
    expect(pair.publicKey).toMatch(/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/);
    const secret = createPrivateKey({
      key: Buffer.from(pair.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    expect(secret.asymmetricKeyType).toBe('ed25519');
    expect(createPublicKey(secret).export({ format: 'der', type: 'spki' }).toString('base64')).toBe(
      pair.publicKey,
    );
    const message = Buffer.from(`menumesh wal 1 1 000000010000000000000001 ${'0'.repeat(64)}\n`);
    expect(
      verify(null, message, signingPublicKey(pair.publicKey)!, sign(null, message, secret)),
    ).toBe(true);
    expect(signingPrivateKey(pair.privateKey)?.asymmetricKeyType).toBe('ed25519');
    expect(other.privateKey).not.toBe(pair.privateKey);
    // Another curve's keys in the same shapes are refused.
    const x = generateKeyPairSync('x25519');
    expect(
      signingPrivateKey(x.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')),
    ).toBeNull();
    expect(
      signingPublicKey(x.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')),
    ).toBeNull();
  });

  it('is checked by name only: the pair, and the private key’s own public key first', () => {
    expect(checkSigningKeys(ok)).toEqual([]);
    // After a rotation the old public key stays, after the new one.
    expect(
      checkSigningKeys({
        ...ok,
        BACKUP_SIGNING_PUBLIC_KEY: `${pair.publicKey} ${other.publicKey}`,
      }),
    ).toEqual([]);
    const cases: [Values, string][] = [
      [{ ...ok, BACKUP_SIGNING_KEY: '' }, 'BACKUP_SIGNING_KEY is empty'],
      [{ ...ok, BACKUP_SIGNING_PUBLIC_KEY: '' }, 'BACKUP_SIGNING_PUBLIC_KEY is empty'],
      [
        { ...ok, BACKUP_SIGNING_PUBLIC_KEY: other.publicKey },
        "BACKUP_SIGNING_PUBLIC_KEY's first key is not BACKUP_SIGNING_KEY's public key",
      ],
      [
        { ...ok, BACKUP_SIGNING_PUBLIC_KEY: `${other.publicKey} ${pair.publicKey}` },
        "first key is not BACKUP_SIGNING_KEY's",
      ],
      [
        { ...ok, BACKUP_SIGNING_PUBLIC_KEY: `${pair.publicKey}  ${other.publicKey}` },
        'separated by single spaces',
      ],
      [
        { ...ok, BACKUP_SIGNING_PUBLIC_KEY: `${pair.publicKey} ${pair.publicKey}` },
        'names a key twice',
      ],
      [{ ...ok, BACKUP_SIGNING_KEY: pair.publicKey }, 'not an Ed25519 private key'],
      [
        { ...ok, BACKUP_SIGNING_KEY: `${pair.privateKey.slice(0, -1)}!` },
        'not an Ed25519 private key',
      ],
      [{ ...ok, BACKUP_SIGNING_PUBLIC_KEY: pair.privateKey }, 'must be Ed25519 public keys'],
    ];
    for (const [values, expected] of cases) {
      const found = checkSigningKeys(values).join('\n');
      expect(found, expected).toContain(expected);
      for (const text of [pair.privateKey, pair.publicKey, other.publicKey]) {
        expect(found).not.toContain(text);
      }
    }
  });

  it('is made for the server and the rehearsal alike, and checked with the other files', () => {
    for (const mode of ['production', 'rehearsal'] as const) {
      const { values } = generate(mode);
      expect(checkSigningKeys(values[0]), mode).toEqual([]);
      expect(values[1].BACKUP_SIGNING_KEY, mode).toBeUndefined();
      expect(values[2].BACKUP_SIGNING_KEY, mode).toBeUndefined();
    }
    const { values } = generate('rehearsal');
    const swapped = [
      { ...values[0], BACKUP_SIGNING_PUBLIC_KEY: other.publicKey },
      ...values.slice(1),
    ];
    expect(checkFiles(swapped, 'rehearsal')[0].join('\n')).toContain(
      "BACKUP_SIGNING_PUBLIC_KEY's first key is not BACKUP_SIGNING_KEY's public key",
    );
  });
});

describe('the env files', () => {
  const templates = FILES.map((spec) =>
    readFileSync(join('deploy/vps/env', spec.template), 'utf8'),
  );

  it('fill every name of the templates, and only those', () => {
    const { values } = generate('production');
    FILES.forEach((spec, index) => {
      const known = [...Object.keys(values[index]), ...spec.owner, ...spec.optional];
      expect(new Set(known).size, spec.template).toBe(known.length);
      expect([...known].sort(), spec.template).toEqual(templateNames(templates[index]).sort());
    });
  });

  it('give every required compose value from .env a generated or an owner’s value', () => {
    const compose = readFileSync('deploy/vps/compose.yml', 'utf8');
    const images = templateNames(readFileSync('deploy/vps/env/images.env.example', 'utf8'));
    const required = new Set(
      [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)].map((match) => match[1]),
    );
    const generated = Object.keys(generate('production').values[0]);
    for (const name of required) {
      if (images.includes(name)) continue;
      expect([...generated, ...FILES[0].owner], name).toContain(name);
    }
    // An optional name is never required: empty must stay a valid value.
    for (const name of FILES[0].optional) expect(required.has(name), name).toBe(false);
  });

  it('mark the owner’s names on the server’s files and read back as the values', () => {
    const { values } = generate('production');
    FILES.forEach((spec, index) => {
      const text = render(spec, templates[index], values[index], ['header'], true);
      expect(text.startsWith('# header\n#\n')).toBe(true);
      for (const name of spec.owner) {
        if (name in values[index]) continue;
        expect(text, name).toContain(`\n# FILL IN\n${name}=\n`);
      }
      const read = parseEnv(text) as Values;
      for (const [name, value] of Object.entries(values[index]))
        expect(read[name], name).toBe(value);
    });
    const project = render(FILES[0], templates[0], values[0], [], true);
    expect(project).toMatch(/^JWT_KEYS='\[\{"kty":"EC"/m);
    expect(project).toMatch(/^JWT_JWKS='\{"keys":/m);
    expect(project).toContain('\nSITE_URL=https://menumesh.in\n');
    expect(project).toContain('\nSUPABASE_PUBLIC_URL=https://api.menumesh.in\n');
    expect(checkFiles(values, 'production')[0].join('\n')).toContain(
      'BACKUP_AGE_RECIPIENT is still to fill in',
    );
  });

  it('give a rehearsal throwaway values for everything it runs', () => {
    const { values, identityFile } = generate('rehearsal');
    expect(values[0]).toMatchObject({
      SITE_URL: 'http://localhost:3300',
      SUPABASE_PUBLIC_URL: 'http://127.0.0.1:8300',
      BACKUP_BUCKET: 'menumesh-rehearsal',
      BACKUP_S3_ENDPOINT: 'http://s3:9000',
    });
    expect(identityFile).toContain(`# public key: ${values[0].BACKUP_AGE_RECIPIENT}\n`);
    expect(values[2].SUPABASE_SECRET_KEY).not.toBe(values[0].SUPABASE_SECRET_KEY);
    expect(values[1].STAFF_EMAIL_DOMAIN).toBe('tableorder.test');
    expect(checkFiles(values, 'rehearsal')).toEqual([[], [], []]);
    const text = render(FILES[1], templates[1], values[1], [], false);
    expect(text).not.toContain('# FILL IN');
  });
});

describe('pnpm vps:secrets', () => {
  const run = promisify(execFile);
  const dirs: string[] = [];
  const temporary = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vps-secrets-'));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const cli = async (...args: string[]) => {
    try {
      const { stdout, stderr } = await run(
        process.execPath,
        ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/vps-secrets.mts', ...args],
        { encoding: 'utf8' },
      );
      return { code: 0, output: stdout + stderr };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, output: failed.stdout + failed.stderr };
    }
  };
  /** Every value a written file holds. */
  const secretsIn = (dir: string) => [
    ...FILES.flatMap((spec) =>
      Object.values(parseEnv(readFileSync(join(dir, spec.path), 'utf8')) as Values),
    ),
    ...(existsSync(join(dir, AGE_IDENTITY))
      ? readFileSync(join(dir, AGE_IDENTITY), 'utf8').split('\n').slice(2)
      : []),
  ];

  it('writes a rehearsal’s files 0600, prints no value, and keeps them unless --force', async () => {
    const out = temporary();
    const first = await cli('--rehearsal', '--out', out);
    expect(first.code, first.output).toBe(0);
    const paths = [...FILES.map((spec) => join(out, spec.path)), join(out, AGE_IDENTITY)];
    const before = paths.map((path) => readFileSync(path, 'utf8'));
    if (process.platform !== 'win32') {
      for (const path of paths) expect(statSync(path).mode & 0o777, path).toBe(0o600);
      expect(statSync(join(out, 'env')).mode & 0o777).toBe(0o700);
    }
    const checked = await cli('--check', out, '--rehearsal');
    expect(checked.code, checked.output).toBe(0);
    const again = await cli('--rehearsal', '--out', out);
    expect(again.code).toBe(1);
    expect(again.output).toContain('--force');
    expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(before);
    for (const secret of secretsIn(out).filter((value) => value.length >= 8)) {
      for (const output of [first.output, checked.output, again.output]) {
        expect(output).not.toContain(secret);
      }
    }
    const forced = await cli('--rehearsal', '--out', out, '--force');
    expect(forced.code, forced.output).toBe(0);
    expect(readFileSync(paths[0], 'utf8')).not.toBe(before[0]);
  });

  it('writes the server’s files with the owner’s names to fill in, and checks them', async () => {
    const out = temporary();
    const written = await cli('--out', out);
    expect(written.code, written.output).toBe(0);
    expect(written.output).toContain('To fill in, .env: BACKUP_AGE_RECIPIENT');
    expect(existsSync(join(out, AGE_IDENTITY))).toBe(false);
    const checked = await cli('--check', out);
    expect(checked.code).toBe(1);
    expect(checked.output).toContain('.env: STAGING_DB_PASSWORD is still to fill in');
    // The signing pair's public half is printed once, for the owner to keep beside the age key, in
    // a file of its own: age reads the file of its key as keys and comments alone (Stop C's
    // re-review, design note 4). The check prints neither half, and no other value is printed.
    const { BACKUP_SIGNING_PUBLIC_KEY: publicKey } = parseEnv(
      readFileSync(join(out, '.env'), 'utf8'),
    ) as Values;
    expect(written.output).toContain(`\n  BACKUP_SIGNING_PUBLIC_KEY=${publicKey}\n`);
    expect(written.output).toContain(
      "Keep its public half beside the age key, offline, in a file of its own and never in the age key's file",
    );
    expect(written.output).not.toContain('with the age key');
    expect(checked.output).not.toContain(publicKey);
    for (const secret of secretsIn(out).filter((value) => value.length >= 8)) {
      if (secret !== publicKey) expect(written.output + checked.output).not.toContain(secret);
    }
  });

  it('refuses to write where git would track the files', async () => {
    const out = join('deploy', 'vps', 'env', 'not-for-secrets');
    const refused = await cli('--out', out);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("git doesn't ignore");
    expect(existsSync(out)).toBe(false);
  });
});
