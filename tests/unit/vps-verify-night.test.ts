import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import {
  SEAL_MAX,
  type SealBase,
  type SealPart,
  sealText,
  signedWith,
} from '../../scripts/vps-seal.mts';
import {
  fileKeys,
  givenKeys,
  KEYS_MAX,
  readCapped,
  verifyNight,
} from '../../scripts/vps-verify-night.mts';

/**
 * pnpm vps:verify-night (scripts/vps-verify-night.mts; Stop C's review, finding D1): disaster
 * recovery's step 2 unpacks a night's settings archive into a new server's /srv/menumesh, whose db
 * then runs its config/db/wal-spool.sh as root, and no kit script runs there before it. So the
 * owner checks the archive on their own machine against the night's seal, signed by the backup's
 * key, before it is copied: the seal read as seal.sh's seal_open reads one (scripts/vps-seal.mts,
 * which vps:backup-test holds to the shell's verdicts), every file named as a part of the night
 * as the seal gives it, and a settings archive listed and there. Each case builds its pair, its
 * parts and its seal here.
 */

const night = '2026-11-13T2030Z-3f9c0a1b';
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
};
const own = pair();
const other = pair();
const sum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vps-verify-night-'));
  dirs.push(dir);
  return dir;
};

// A whole night's parts as the backup uploads them (random bytes stand for age's), in its order.
const config = `config-${night}.tar.age`;
const sealName = `seal-${night}.txt`;
const bytesOf: Record<string, Buffer> = {
  [`globals-${night}.sql.age`]: randomBytes(7491),
  [`storage-${night}.tar.age`]: randomBytes(20680),
  [`manifest-${night}.txt.age`]: randomBytes(4266),
  [`postgres-${night}.dump.age`]: randomBytes(65_000),
  [config]: randomBytes(10440),
  [`base-${night}.tar.zst.age`]: randomBytes(150_000),
};
const partOf = (name: string): SealPart => ({
  sha256: sum(bytesOf[name]),
  bytes: bytesOf[name].length,
  name,
});
const parts = Object.keys(bytesOf).map(partOf);
const base: SealBase = {
  end: '2026-11-13T20:33:07Z',
  walfile: '0000000100000000000000B9',
  cluster: '7708084103783477285',
};
const good = sealText(night, base, parts, own.privateKey);
const bodyOf = (text: string) => text.slice(0, text.lastIndexOf('signature '));
const signed = (body: string) => `${body}signature ${signedWith(own.privateKey, body)}\n`;

/** A folder with a seal (its bytes as given, one a character), the night's files named, and more. */
function folderOf(
  seal: string | Buffer | undefined,
  names: string[] = [config],
  more: Record<string, string | Buffer> = {},
) {
  const dir = temporary();
  if (seal !== undefined) {
    writeFileSync(
      join(dir, sealName),
      typeof seal === 'string' ? Buffer.from(seal, 'latin1') : seal,
    );
  }
  for (const name of names) writeFileSync(join(dir, name), bytesOf[name]);
  for (const [name, bytes] of Object.entries(more)) writeFileSync(join(dir, name), bytes);
  return dir;
}

/** What the check says of a folder with the given keys: its lines, or its one refusal. */
const verdictOf = (dir: string, keys: string = own.publicKey) => {
  const verdict = verifyNight(night, dir, { environment: keys });
  return verdict.ok ? verdict.lines : verdict.line;
};
const notSigned = (problem: string) =>
  `verify-night: the night of ${night} is not signed by the backup's key: its seal (${sealName}) ${problem}, so someone else wrote to the bucket, and nothing in the folder can be trusted`;
const passed = (checked: SealPart[]) => [
  ...checked.map(
    ({ name, bytes, sha256 }) =>
      `verify-night: ${name} is the part the backup sealed (${bytes} bytes, sha256 ${sha256})`,
  ),
  `verify-night: the seal of ${night} is signed by the backup's key, and ${checked.length === 1 ? 'the 1 part here matches it' : `the ${checked.length} parts here match it`}: copy ${config} to the server, where sha256sum must print ${sum(bytesOf[config])} for it before it is unpacked`,
];

describe('pnpm vps:verify-night (Stop C’s review, finding D1)', () => {
  it('passes a night’s seal and settings archive, naming the archive’s sha256 last', () => {
    expect(verdictOf(folderOf(good))).toEqual(passed([partOf(config)]));
  });

  it('checks every part of the night in the folder, in its seal’s order, and leaves other names alone', () => {
    const dir = folderOf(good, [...Object.keys(bytesOf)].reverse(), {
      'notes.txt': 'the owner’s own',
      [`${config}.part`]: 'a download not finished',
      'config-2026-11-12T2030Z-0123abcd.tar.age': 'another night’s',
      [`${sealName}.bak`]: 'not the seal',
      'keys.txt': `BACKUP_SIGNING_PUBLIC_KEY=${own.publicKey}\n`,
    });
    expect(verdictOf(dir)).toEqual(passed(parts));
    // A night whose base failed seals "base none", and its settings archive still checks out.
    const noBase = parts.filter(({ name }) => !name.startsWith('base-'));
    expect(verdictOf(folderOf(sealText(night, undefined, noBase, own.privateKey)))).toEqual(
      passed([partOf(config)]),
    );
  });

  it('takes a seal any key of the list signed, the signer second, and no other key’s', () => {
    expect(verdictOf(folderOf(good), `${other.publicKey} ${own.publicKey}`)).toEqual(
      passed([partOf(config)]),
    );
    expect(verdictOf(folderOf(good), other.publicKey)).toBe(
      notSigned("is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys"),
    );
  });

  it('refuses each seal seal_open refuses, in its words, and prints none of its text', () => {
    const otherNight = '2026-11-14T2030Z-3f9c0a1b';
    const cases: [string | Buffer, string][] = [
      // A bad signature: another key's, or the backup's over other lines.
      [
        sealText(night, base, parts, other.privateKey),
        "is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys",
      ],
      [
        good.replace(` ${bytesOf[config].length} ${config}`, ` 10441 ${config}`),
        "is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys",
      ],
      [
        `${good.slice(0, -2)}${good.at(-2) === 'A' ? 'B' : 'A'}\n`,
        "is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys",
      ],
      // Another night's seal, signed by the backup, under this night's name.
      [
        sealText(
          otherNight,
          base,
          parts.map((part) => ({ ...part, name: part.name.replace(night, otherNight) })),
          own.privateKey,
        ),
        `does not begin with the line "menumesh seal 1 ${night}"`,
      ],
      [sealText(night, base, [...parts, parts[4]], own.privateKey), 'lists a part twice'],
      // Longer than seal_max: just past it, and by a MiB.
      [
        `${good}${'#'.repeat(SEAL_MAX + 1 - good.length)}`,
        `is longer than a seal's ${SEAL_MAX} bytes`,
      ],
      [`${good}${'#'.repeat(1 << 20)}`, `is longer than a seal's ${SEAL_MAX} bytes`],
      // A byte past printable ASCII, a control character, CR line ends, a NUL, no last newline.
      [
        Buffer.from(signed(bodyOf(good).replace('menumesh seal', 'menumésh seal')), 'utf8'),
        'holds a byte that is not printable ASCII, or does not end in a newline',
      ],
      [
        signed(bodyOf(good).replace('base ', 'base \x1b[2J')),
        'holds a byte that is not printable ASCII, or does not end in a newline',
      ],
      [
        signed(bodyOf(good).replaceAll('\n', '\r\n')),
        'holds a byte that is not printable ASCII, or does not end in a newline',
      ],
      [
        `${good.slice(0, 30)}\0${good.slice(31)}`,
        'holds a byte that is not printable ASCII, or does not end in a newline',
      ],
      [good.slice(0, -1), 'holds a byte that is not printable ASCII, or does not end in a newline'],
      ['', 'is empty'],
      [`menumesh seal 1 ${night}\nbase none\nsignature x\n`, 'has fewer lines than a seal'],
      [
        signed(bodyOf(good).replace(base.walfile, base.walfile.toLowerCase())),
        'has no base line as a backup writes one',
      ],
      [
        signed(bodyOf(good).replace(`part ${parts[0].sha256}`, `part  ${parts[0].sha256}`)),
        'has a line 3 that is not a part as a backup lists one',
      ],
      [
        sealText(
          night,
          base,
          [...parts, { ...parts[3], name: `template1-${night}.dump.age` }],
          own.privateKey,
        ),
        'has a line 9 that is not a part as a backup lists one',
      ],
      [
        sealText(night, undefined, parts, own.privateKey),
        'has a base line that its parts do not match',
      ],
      [`${good.slice(0, -1)}==\n`, 'does not end in a signature line'],
    ];
    for (const [seal, problem] of cases) {
      const line = verdictOf(folderOf(seal));
      expect(line).toBe(notSigned(problem));
      expect(line).not.toMatch(/[^ -~]/);
    }
  });

  it('refuses a part of another size or sha256 than its seal gives', () => {
    const name = `postgres-${night}.dump.age`;
    const longer = Buffer.concat([bytesOf[config], Buffer.from([0])]);
    const cut = bytesOf[config].subarray(0, 4096);
    const changed = Buffer.from(bytesOf[config]);
    changed[5000] ^= 1;
    const dump = Buffer.from(bytesOf[name]);
    dump[0] ^= 0x80;
    const sizes: [Record<string, Buffer>, string][] = [
      [
        { [config]: longer },
        `${config} is not the part the backup sealed (10441 bytes, not 10440)`,
      ],
      [{ [config]: cut }, `${config} is not the part the backup sealed (4096 bytes, not 10440)`],
    ];
    for (const [files, start] of sizes) {
      expect(verdictOf(folderOf(good, [], files))).toBe(
        `verify-night: ${start}: a download cut short, or someone else wrote to the bucket, and nothing in the folder can be trusted`,
      );
    }
    for (const [file, bytes] of [
      [config, changed],
      [name, dump],
    ] as const) {
      expect(
        verdictOf(
          folderOf(
            good,
            [config, name].filter((n) => n !== file),
            { [file]: bytes },
          ),
        ),
      ).toBe(
        `verify-night: ${file} is not the part the backup sealed (its sha256 is not the seal's): someone else wrote to the bucket, and nothing in the folder can be trusted`,
      );
    }
  });

  it('refuses a file named as a part of the night that its seal doesn’t list', () => {
    const fewer = sealText(
      night,
      base,
      parts.filter(({ name }) => !name.startsWith('globals-')),
      own.privateKey,
    );
    expect(verdictOf(folderOf(fewer, [config, `globals-${night}.sql.age`]))).toBe(
      `verify-night: globals-${night}.sql.age is not in the seal of ${night}, so the backup did not write it: someone else wrote to the bucket, and nothing in the folder can be trusted`,
    );
    expect(verdictOf(folderOf(good, [config], { [`planted-${night}.dump.age`]: 'planted' }))).toBe(
      `verify-night: planted-${night}.dump.age is not in the seal of ${night}, so the backup did not write it: someone else wrote to the bucket, and nothing in the folder can be trusted`,
    );
  });

  it('refuses a night whose seal lists no settings archive, saying to name the night before', () => {
    const noConfig = sealText(
      night,
      base,
      parts.filter(({ name }) => name !== config),
      own.privateKey,
    );
    const line = `verify-night: the night of ${night} has no settings archive in its seal (${config}): its backup had none fresh enough, and anything under that name is someone else's: name the night before it`;
    // With an archive planted under its name, which such a night leaves free, and without one.
    expect(verdictOf(folderOf(noConfig))).toBe(line);
    expect(verdictOf(folderOf(noConfig, []))).toBe(line);
  });

  it('refuses a folder without the night’s seal or its settings archive, or with either not a file', () => {
    expect(verdictOf(folderOf(undefined))).toBe(
      `verify-night: the folder holds no ${sealName}: download it beside the settings archive, from the night's folder of the bucket; a night with no seal there is not signed by the backup's key (a backup that stopped before its seal, or someone else wrote to the bucket: the backup's journal names the nights it sealed)`,
    );
    expect(verdictOf(folderOf(good, [`manifest-${night}.txt.age`]))).toBe(
      `verify-night: the folder holds no ${config}: download the night's settings archive beside its seal`,
    );
    const sealFolder = folderOf(undefined);
    mkdirSync(join(sealFolder, sealName));
    expect(verdictOf(sealFolder)).toBe(
      `verify-night: ${sealName} in the folder is not a file, so nothing in the folder can be trusted`,
    );
    const configFolder = folderOf(good, []);
    mkdirSync(join(configFolder, config));
    expect(verdictOf(configFolder)).toBe(
      `verify-night: ${config} in the folder is not a file, so nothing in the folder can be trusted`,
    );
    expect(verdictOf(join(temporary(), 'not-there'))).toBe(
      'verify-night: the folder could not be read (ENOENT)',
    );
  });

  it('takes only a night’s id as the backup prints it', () => {
    for (const id of [
      '2026-11-13T2030Z-3F9C0A1B',
      '2026-11-13T2030Z',
      '2026-11-13T20:30Z-3f9c0a1b',
      `../${night}`,
      `${night}\n`,
      '',
    ]) {
      expect(verifyNight(id, folderOf(good), { environment: own.publicKey })).toEqual({
        ok: false,
        line: "verify-night: the night must be named by its id as the backup's journal line prints it, like 2026-11-11T2030Z-0f3c9a1b",
      });
    }
  });

  it('reads the key list from a file as the owner keeps it', () => {
    const list = `${own.publicKey} ${other.publicKey}`;
    const files: [string | Buffer, string][] = [
      [`BACKUP_SIGNING_PUBLIC_KEY=${own.publicKey}\n`, own.publicKey],
      // The line as pnpm vps:secrets prints it, saved on Windows.
      [`  BACKUP_SIGNING_PUBLIC_KEY=${own.publicKey}\r\n`, own.publicKey],
      [`﻿BACKUP_SIGNING_PUBLIC_KEY="${list}"\n`, list],
      [`BACKUP_SIGNING_PUBLIC_KEY='${list}'`, list],
      [`# kept with the age key, 2026-11-13\n\n${list}\n`, list],
      // Beside the age key in one file: the other lines are left unread.
      [
        `# created: 2026-11-13T00:00:00Z\n# public key: age1example\nAGE-SECRET-KEY-1EXAMPLE\nBACKUP_SIGNING_PUBLIC_KEY=${list}\n`,
        list,
      ],
    ];
    for (const [text, keys] of files) {
      expect(fileKeys(typeof text === 'string' ? Buffer.from(text, 'utf8') : text)).toEqual({
        keys,
      });
    }
  });

  it('refuses a bad key file, a bad key, and no keys at all, before it reads the folder', () => {
    const dir = temporary();
    const file = (name: string, text: string | Buffer) => {
      writeFileSync(join(dir, name), text);
      return join(dir, name);
    };
    const problems: [string | Buffer, string][] = [
      [
        `BACKUP_SIGNING_PUBLIC_KEY=${own.publicKey}\nBACKUP_SIGNING_PUBLIC_KEY=${other.publicKey}\n`,
        'names BACKUP_SIGNING_PUBLIC_KEY more than once',
      ],
      ['', 'holds no keys'],
      ['# only a comment\n\n', 'holds no keys'],
      [
        `${own.publicKey}\n${other.publicKey}\n`,
        'holds more than one line of keys (put them on one line, separated by single spaces, or after BACKUP_SIGNING_PUBLIC_KEY=)',
      ],
      [
        Buffer.from(`BACKUP_SIGNING_PUBLIC_KEY=${own.publicKey}\n`, 'utf16le'),
        'holds a byte that is not printable ASCII (keep it as plain text)',
      ],
      [
        `BACKUP_SIGNING_PUBLIC_KEY=${own.publicKey}\t\n`,
        'holds a byte that is not printable ASCII (keep it as plain text)',
      ],
      [
        `${own.publicKey}\n${'#'.repeat(KEYS_MAX)}\n`,
        `is longer than a list of keys (${KEYS_MAX} bytes)`,
      ],
    ];
    for (const [text, problem] of problems) {
      expect(givenKeys({ file: file('keys.txt', text) })).toEqual({
        ok: false,
        line: `verify-night: the keys file ${problem}`,
      });
    }
    const malformed =
      'BACKUP_SIGNING_PUBLIC_KEY in the keys file is not one Ed25519 public key or several, as pnpm vps:secrets writes it (base64 SPKI DER, separated by single spaces)';
    const x25519 = generateKeyPairSync('x25519')
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64');
    for (const keys of [
      own.publicKey.slice(0, -2),
      own.privateKey,
      x25519,
      `${own.publicKey}  ${other.publicKey}`,
      `BACKUP_SIGNING_PUBLIC_KEY="${own.publicKey} "`,
      `BACKUP_SIGNING_PUBLIC_KEY=`,
      'AGE-SECRET-KEY-1EXAMPLE',
    ]) {
      expect(givenKeys({ file: file('keys.txt', `${keys}\n`) })).toEqual({
        ok: false,
        line: `verify-night: ${malformed}`,
      });
    }
    // In the environment, as restore.sh takes it: no space before, after or doubled.
    for (const keys of [
      `${own.publicKey} `,
      ` ${own.publicKey}`,
      `${own.publicKey},${other.publicKey}`,
    ]) {
      expect(givenKeys({ environment: keys })).toEqual({
        ok: false,
        line: 'verify-night: BACKUP_SIGNING_PUBLIC_KEY is not one Ed25519 public key or several, as pnpm vps:secrets writes it (base64 SPKI DER, separated by single spaces)',
      });
    }
    expect(givenKeys({ file: join(dir, 'not-there') })).toEqual({
      ok: false,
      line: 'verify-night: the keys file could not be read (ENOENT)',
    });
    expect(givenKeys({})).toEqual({
      ok: false,
      line: 'verify-night: BACKUP_SIGNING_PUBLIC_KEY is not set: give the list kept with the age key, in a file (--keys <file>) or in BACKUP_SIGNING_PUBLIC_KEY',
    });
    // The keys are refused before anything of the folder is read: here, a folder that isn't.
    expect(
      verifyNight(night, join(dir, 'not-there'), { file: file('bad.txt', 'AGE-SECRET-KEY-1X\n') }),
    ).toEqual({ ok: false, line: `verify-night: ${malformed}` });
  });

  it('takes the key file’s list over the environment’s', () => {
    const dir = temporary();
    const ownFile = join(dir, 'own.txt');
    const otherFile = join(dir, 'other.txt');
    writeFileSync(ownFile, `BACKUP_SIGNING_PUBLIC_KEY=${own.publicKey}\n`);
    writeFileSync(otherFile, `BACKUP_SIGNING_PUBLIC_KEY=${other.publicKey}\n`);
    expect(verifyNight(night, folderOf(good), { file: ownFile, environment: 'not a key' })).toEqual(
      {
        ok: true,
        lines: passed([partOf(config)]),
      },
    );
    expect(
      verifyNight(night, folderOf(good), { file: otherFile, environment: own.publicKey }),
    ).toEqual({
      ok: false,
      line: notSigned("is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys"),
    });
  });

  it('reads a seal no further than a byte past seal_max, and a key file past its own cap', () => {
    const dir = temporary();
    writeFileSync(join(dir, 'big'), Buffer.alloc(5 << 20, 0x23));
    writeFileSync(join(dir, 'small'), good);
    expect(readCapped(join(dir, 'big'), SEAL_MAX).length).toBe(SEAL_MAX + 1);
    expect(readCapped(join(dir, 'small'), SEAL_MAX).toString('latin1')).toBe(good);
    // The seal and the key file are read so, and nothing else is read whole but a part the seal
    // gives the size of.
    const source = readFileSync('scripts/vps-verify-night.mts', 'utf8');
    expect(source).toContain(
      "    text = readCapped(resolve(folder, sealName), SEAL_MAX).toString('latin1');\n",
    );
    expect(source).toContain('      bytes = readCapped(file, KEYS_MAX);\n');
    expect(source.match(/(?<![.\w])(readCapped|digest)\(|readFileSync|createReadStream/g)).toEqual([
      'readCapped(',
      'digest(',
      'readCapped(',
      'readCapped(',
      'digest(',
    ]);
  });

  it('runs as pnpm vps:verify-night does: its lines and exit 0, or one line on stderr and exit 1', async () => {
    const run = promisify(execFile);
    const environment = { ...process.env };
    delete environment.BACKUP_SIGNING_PUBLIC_KEY;
    delete environment.INIT_CWD;
    const cli = async (args: string[], extra: Record<string, string> = {}) => {
      try {
        const { stdout, stderr } = await run(
          process.execPath,
          [
            '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
            'scripts/vps-verify-night.mts',
            ...args,
          ],
          { encoding: 'utf8', env: { ...environment, ...extra } },
        );
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failed = error as { code: number; stdout: string; stderr: string };
        return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
      }
    };
    const keys = join(temporary(), 'keys.txt');
    writeFileSync(keys, `BACKUP_SIGNING_PUBLIC_KEY=${own.publicKey}\n`);
    const dir = folderOf(good);
    const lines = `${passed([partOf(config)]).join('\n')}\n`;
    expect(await cli([night, dir, '--keys', keys])).toEqual({ code: 0, stdout: lines, stderr: '' });
    expect(await cli(['--keys', keys, night, dir])).toEqual({ code: 0, stdout: lines, stderr: '' });
    expect(await cli([night, dir], { BACKUP_SIGNING_PUBLIC_KEY: own.publicKey })).toEqual({
      code: 0,
      stdout: lines,
      stderr: '',
    });
    expect(
      await cli([night, folderOf(good, [], { [config]: randomBytes(10440) }), '--keys', keys]),
    ).toEqual({
      code: 1,
      stdout: '',
      stderr: `verify-night: ${config} is not the part the backup sealed (its sha256 is not the seal's): someone else wrote to the bucket, and nothing in the folder can be trusted\n`,
    });
    const usage =
      'verify-night: usage: pnpm vps:verify-night <night id> <folder> [--keys <file>]\n';
    for (const args of [[], [night], [night, dir, 'more'], [night, dir, '--key', keys]]) {
      expect(await cli(args)).toEqual({ code: 1, stdout: '', stderr: usage });
    }
    expect(await cli(['--help'])).toEqual({ code: 0, stdout: usage, stderr: '' });
    // As package.json runs it.
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(scripts['vps:verify-night']).toBe(
      'node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/vps-verify-night.mts',
    );
  });

  it('reads files with Node alone: no program, no age key, no network', () => {
    const allowed = ['node:crypto', 'node:fs', 'node:path', 'node:util', './vps-seal.mts'];
    for (const path of ['scripts/vps-verify-night.mts', 'scripts/vps-seal.mts']) {
      const source = readFileSync(path, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      const imported = [...code.matchAll(/\bfrom '([^']+)'/g)].map((match) => match[1]);
      expect(imported.length, path).toBeGreaterThan(0);
      expect(
        imported.filter((name) => !allowed.includes(name)),
        path,
      ).toEqual([]);
      expect(code, path).not.toMatch(
        /\bimport\(|\brequire\(|\bfetch\(|\bWebSocket\b|process\.binding|AGE_IDENTITY|--decrypt/,
      );
    }
  });
});
