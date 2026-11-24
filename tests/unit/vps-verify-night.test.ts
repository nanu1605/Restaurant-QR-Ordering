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
import { ageKeyPair } from '../../scripts/vps-secrets.mts';
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
 * parts and its seal here. Stop C's re-review adds what a theft of the signing key leaves (finding
 * V1) and a key file that holds the age key, which age would refuse to read (design note 4).
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
      // A month's copy's record, which only backup.sh's month's copy reads, and never needs here.
      [`copy-${night}.txt`]: 'planted, not a record',
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
    // After a theft of the signing key (Stop C's re-review, finding V1), own stands for the key
    // that signed every night before the trouble, which the thief may hold, and other for the new
    // pair: the stolen key leaves the kept list at once, so a night from before the trouble is
    // refused with that list, and passes only with a file that holds the stolen key alone, kept
    // apart for that one check. A routine rotation keeps the whole list, which takes it too.
    const dir = temporary();
    const keyFile = (name: string, keys: string) => {
      writeFileSync(join(dir, name), `BACKUP_SIGNING_PUBLIC_KEY=${keys}\n`);
      return join(dir, name);
    };
    const before = folderOf(good);
    expect(verifyNight(night, before, { file: keyFile('kept.txt', other.publicKey) })).toEqual({
      ok: false,
      line: notSigned("is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys"),
    });
    for (const keys of [own.publicKey, `${other.publicKey} ${own.publicKey}`]) {
      expect(verifyNight(night, before, { file: keyFile('stolen.txt', keys) })).toEqual({
        ok: true,
        lines: passed([partOf(config)]),
      });
    }
  });

  it('keeps an older key that never leaked after the new one when a theft follows a rotation (Stop C’s re-review, finding U3)', () => {
    // K1 signed the nights before a routine rotation to K2; then K2 leaked. The theft's new list
    // puts the new key K3 first and keeps K1 after it, whose private half had left the server
    // before the trouble could begin (Rotation keeps each old key whose nights may be needed); the
    // stolen K2 leaves the list for a file of its own, kept apart. Throwaway pairs, made here.
    const [k1, k2, k3] = [pair(), pair(), pair()];
    const dir = temporary();
    const keyFile = (name: string, text: string) => {
      writeFileSync(join(dir, name), text);
      return join(dir, name);
    };
    const kept = keyFile('kept.txt', `BACKUP_SIGNING_PUBLIC_KEY=${k3.publicKey} ${k1.publicKey}\n`);
    const newAlone = keyFile('new-alone.txt', `BACKUP_SIGNING_PUBLIC_KEY=${k3.publicKey}\n`);
    const stolen = keyFile(
      'stolen.txt',
      `# stolen: for one run, nights from before the trouble only\nBACKUP_SIGNING_PUBLIC_KEY=${k2.publicKey}\n`,
    );
    const ofK1 = folderOf(sealText(night, base, parts, k1.privateKey));
    const ofK2 = folderOf(sealText(night, base, parts, k2.privateKey));
    const taken = { ok: true, lines: passed([partOf(config)]) };
    const refused = {
      ok: false,
      line: notSigned("is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys"),
    };
    // A night from before the rotation passes with the new list, and the new key alone drops it.
    expect(verifyNight(night, ofK1, { file: kept })).toEqual(taken);
    expect(verifyNight(night, ofK1, { file: newAlone })).toEqual(refused);
    // A night of the stolen key: refused with the new list, taken only with the stolen key's file.
    expect(verifyNight(night, ofK2, { file: kept })).toEqual(refused);
    expect(verifyNight(night, ofK2, { file: stolen })).toEqual(taken);
    expect(verifyNight(night, ofK1, { file: stolen })).toEqual(refused);
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
    // A night whose base backup failed may still hold what of its base went up: refused too, as
    // what it is, and the folder without it checks out.
    const baseName = `base-${night}.tar.zst.age`;
    const noBase = sealText(
      night,
      undefined,
      parts.filter(({ name }) => name !== baseName),
      own.privateKey,
    );
    expect(verdictOf(folderOf(noBase, [config], { [baseName]: randomBytes(4096) }))).toBe(
      `verify-night: ${baseName} is not in the seal of ${night}, whose base backup failed: what of a base went up before it stopped is never read, so take it out of the folder and check again`,
    );
    expect(verdictOf(folderOf(noBase, [config]))).toEqual(passed([partOf(config)]));
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

    // After a theft of the signing key (Stop C's re-review, finding V1): backup.sh by hand with the
    // new pair, at an hour when the host's settings archive of 20:20 is more than 2 hours old,
    // seals none, and is refused so with the kept list, which now holds the new key alone; made
    // after a fresh archive, it seals one and passes. The stolen key's file takes only the nights
    // from before the trouble.
    const byHand = '2026-11-14T0930Z-5e1d2c3b';
    const handConfig = `config-${byHand}.tar.age`;
    const archive = randomBytes(10440);
    const handBase: SealBase = { ...base, end: '2026-11-14T09:31:42Z' };
    const handParts = [
      `globals-${byHand}.sql.age`,
      `storage-${byHand}.tar.age`,
      `manifest-${byHand}.txt.age`,
      `postgres-${byHand}.dump.age`,
      `base-${byHand}.tar.zst.age`,
    ].map((name): SealPart => {
      const bytes = randomBytes(2048);
      return { sha256: sum(bytes), bytes: bytes.length, name };
    });
    const sealed: SealPart = { sha256: sum(archive), bytes: archive.length, name: handConfig };
    const handFolder = (listed: SealPart[], archived: boolean) => {
      const dir = temporary();
      writeFileSync(
        join(dir, `seal-${byHand}.txt`),
        sealText(byHand, handBase, listed, other.privateKey),
      );
      if (archived) writeFileSync(join(dir, handConfig), archive);
      return dir;
    };
    const handVerdict = (dir: string, keys: string) => {
      const verdict = verifyNight(byHand, dir, { environment: keys });
      return verdict.ok ? verdict.lines : verdict.line;
    };
    expect(handVerdict(handFolder(handParts, false), other.publicKey)).toBe(
      `verify-night: the night of ${byHand} has no settings archive in its seal (${handConfig}): its backup had none fresh enough, and anything under that name is someone else's: name the night before it`,
    );
    const whole = handFolder([...handParts, sealed], true);
    const handPassed = [
      `verify-night: ${handConfig} is the part the backup sealed (10440 bytes, sha256 ${sealed.sha256})`,
      `verify-night: the seal of ${byHand} is signed by the backup's key, and the 1 part here matches it: copy ${handConfig} to the server, where sha256sum must print ${sealed.sha256} for it before it is unpacked`,
    ];
    expect(handVerdict(whole, other.publicKey)).toEqual(handPassed);
    expect(handVerdict(whole, `${other.publicKey} ${own.publicKey}`)).toEqual(handPassed);
    expect(handVerdict(whole, own.publicKey)).toBe(
      `verify-night: the night of ${byHand} is not signed by the backup's key: its seal (seal-${byHand}.txt) is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys, so someone else wrote to the bucket, and nothing in the folder can be trusted`,
    );
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
      [`# kept beside the age key, 2026-11-13\n\n${list}\n`, list],
      // Another line beside the BACKUP_SIGNING_PUBLIC_KEY= line is left unread.
      [
        `# public key of the age key: age1example\nKeep this list apart from the age key.\nBACKUP_SIGNING_PUBLIC_KEY=${list}\n`,
        list,
      ],
    ];
    for (const [text, keys] of files) {
      expect(fileKeys(typeof text === 'string' ? Buffer.from(text, 'utf8') : text)).toEqual({
        keys,
      });
    }
  });

  it('refuses a key file that holds an age key, saying the list goes in a file of its own', () => {
    // age reads the file of its key as keys, comments and blank lines alone, so a restore given a
    // file that also holds the list refuses it: the list is never kept there, and a key file that
    // holds the age key is the wrong file (Stop C's re-review, design note 4). The refusal holds
    // nothing of the file.
    const { identityFile } = ageKeyPair();
    const identity = identityFile.trimEnd().split('\n')[2];
    expect(identity).toMatch(/^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/);
    const list = `${own.publicKey} ${other.publicKey}`;
    const refusal = {
      ok: false,
      line: "verify-night: the keys file holds an age key: keep the BACKUP_SIGNING_PUBLIC_KEY list in a file of its own, never in the age key's file, where age takes nothing but keys, comments and blank lines",
    };
    const dir = temporary();
    const files = [
      // The age key's file with the list in it, after the key or before it.
      `${identityFile}BACKUP_SIGNING_PUBLIC_KEY=${list}\n`,
      `BACKUP_SIGNING_PUBLIC_KEY=${list}\n\n${identityFile}`,
      // The age key's own file, given for the list's.
      identityFile,
      // The key's line alone, in either case, indented and saved on Windows, beside a bare list.
      `${identity}\n`,
      `${identity.toLowerCase()}\n`,
      `  ${identity}\r\n${list}\r\n`,
      // A plugin's key, as age-plugin-yubikey writes one.
      `AGE-PLUGIN-YUBIKEY-1QXZ6SZ\nBACKUP_SIGNING_PUBLIC_KEY=${list}\n`,
    ];
    for (const [n, text] of files.entries()) {
      const path = join(dir, `keys-${n}.txt`);
      writeFileSync(path, text);
      expect(fileKeys(Buffer.from(text, 'utf8'))).toEqual({
        problem:
          "holds an age key: keep the BACKUP_SIGNING_PUBLIC_KEY list in a file of its own, never in the age key's file, where age takes nothing but keys, comments and blank lines",
      });
      expect(givenKeys({ file: path })).toEqual(refusal);
      // Before anything of the folder is read: here, a folder that isn't.
      expect(verifyNight(night, join(dir, 'not-there'), { file: path })).toEqual(refusal);
    }
    // A comment that names the age key's public half is no key, and a file of the list alone is
    // the list's.
    expect(fileKeys(Buffer.from(`# beside the age key age1example\n${list}\n`))).toEqual({
      keys: list,
    });
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
    // An age key where the list goes is refused as an age key (the test above).
    for (const keys of [
      own.publicKey.slice(0, -2),
      own.privateKey,
      x25519,
      `${own.publicKey}  ${other.publicKey}`,
      `BACKUP_SIGNING_PUBLIC_KEY="${own.publicKey} "`,
      `BACKUP_SIGNING_PUBLIC_KEY=`,
      'BACKUP_SIGNING_PUBLIC_KEY=AGE-SECRET-KEY-1EXAMPLE',
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
      line: 'verify-night: BACKUP_SIGNING_PUBLIC_KEY is not set: give the list kept beside the age key, in a file of its own (--keys <file>) or in BACKUP_SIGNING_PUBLIC_KEY',
    });
    // The keys are refused before anything of the folder is read: here, a folder that isn't.
    expect(
      verifyNight(night, join(dir, 'not-there'), {
        file: file('bad.txt', `${own.privateKey}\n`),
      }),
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
    // The age key's file given for the list's, the list in it: one line, none of the file.
    const { identityFile } = ageKeyPair();
    const identityKeys = join(temporary(), 'menumesh-backup-key.txt');
    writeFileSync(identityKeys, `${identityFile}BACKUP_SIGNING_PUBLIC_KEY=${own.publicKey}\n`);
    expect(await cli([night, dir, '--keys', identityKeys])).toEqual({
      code: 1,
      stdout: '',
      stderr:
        "verify-night: the keys file holds an age key: keep the BACKUP_SIGNING_PUBLIC_KEY list in a file of its own, never in the age key's file, where age takes nothing but keys, comments and blank lines\n",
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
