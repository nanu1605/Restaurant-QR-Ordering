/**
 * Checks a night the owner downloaded from the bucket against its signed seal, on the owner's own
 * machine, before anything of it goes to a server (docs/RUNBOOK.md, Disaster recovery, step 2;
 * docs/DECISIONS.md VPS-43). A new server runs none of the kit's scripts until a night's settings
 * archive is unpacked into /srv/menumesh (compose needs its .env and images.env), and what the
 * archive holds becomes the server's settings, config/db/wal-spool.sh among them, which db runs as
 * root. Anyone holding the bucket's token and the age public key can put an archive of their own
 * under a night's name (a new version over the backup's, where the bucket keeps versions, or one
 * under a night that sealed none), and age proves nothing about who encrypted it: only the night's
 * seal, signed by the backup's key, says which archive the backup wrote. So the archive is checked
 * here first, as restore.sh checks a part before it reads one, from this repository, with nothing
 * but Node.
 *
 *   pnpm vps:verify-night <night id> <folder> [--keys <file>]
 *
 * The folder holds what the owner downloaded of the night, by name: its seal, seal-<id>.txt, its
 * settings archive, config-<id>.tar.age, and any other part of it. The keys are the
 * BACKUP_SIGNING_PUBLIC_KEY list the owner keeps with the age key: from --keys <file>, a file with
 * a BACKUP_SIGNING_PUBLIC_KEY=... line as pnpm vps:secrets prints it, or with the keys alone on one
 * line, separated by single spaces; else from the environment's BACKUP_SIGNING_PUBLIC_KEY. Never
 * from a settings archive, whose .env is what is being checked. The seal is read no further than a
 * byte past seal.sh's seal_max, held to seal_open's lines for that night and checked against each
 * key (scripts/vps-seal.mts, which vps:backup-test holds to seal.sh's verdicts). Then the seal must
 * list a settings archive, every file of the folder named as one of the night's parts must be one
 * the seal lists, at the size and sha256 it gives, and the settings archive must be there: one
 * file that is not refuses the folder, since its other files came from the same bucket. Files
 * named otherwise are left alone. Nothing is decrypted, no age key is needed, and nothing goes
 * over the network.
 *
 * On success it prints a line for each part it checked, with its sha256, and last the settings
 * archive's sha256, which sha256sum must print for the copy on the server before it is unpacked
 * there. Otherwise it prints one line saying why nothing in the folder can be trusted, and exits 1.
 * Every line it prints is fixed words, the night's id, part names, sizes and sha256s: no text of a
 * file, and no secret.
 */
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { NIGHT_ID, publicKeysOk, SEAL_MAX, sealOf, sealPartName, signedBy } from './vps-seal.mts';

const USAGE = 'usage: pnpm vps:verify-night <night id> <folder> [--keys <file>]';

/** The most a key file may hold, in bytes: a list of many keys is a few KiB. */
export const KEYS_MAX = 65536;

/** Why nothing in the folder can be trusted, in one line. */
type Refusal = { ok: false; line: string };

/** What a check says: the lines to print, or the one line of its refusal. */
export type Verdict = { ok: true; lines: string[] } | Refusal;

/** Where the keys come from: a key file, else the environment's BACKUP_SIGNING_PUBLIC_KEY. */
export type Keys = { file?: string; environment?: string };

const said = (line: string) => `verify-night: ${line}`;
const refused = (line: string): Refusal => ({ ok: false, line: said(line) });

/** The system's name for why a file could not be read (ENOENT, EACCES, ...): no path, no text. */
const why = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'an error';
};

/**
 * A file's first bytes, no more than one past max: read to its end, or until there is one byte
 * more than max, so that a longer file shows as one without being read whole.
 */
export function readCapped(path: string, max: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/** A file's size and sha256, read a MiB at a time. */
function digest(path: string): { bytes: number; sha256: string } {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    let bytes = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

/**
 * The BACKUP_SIGNING_PUBLIC_KEY list a key file holds: the value of its one
 * BACKUP_SIGNING_PUBLIC_KEY=... line, in quotes or not, as pnpm vps:secrets prints it for the owner
 * to keep; with no such line, the keys alone, the file's one line. Blank lines and # comments don't
 * count, nor any other line beside a BACKUP_SIGNING_PUBLIC_KEY= line, which is never read further.
 * A UTF-8 byte order mark and CRLF line ends are taken; any other byte that is not printable ASCII
 * makes the file none. The list as written, or what is wrong with the file, in a few words that
 * hold none of its text.
 */
export function fileKeys(bytes: Buffer): { keys: string } | { problem: string } {
  if (bytes.length > KEYS_MAX) {
    return { problem: `is longer than a list of keys (${KEYS_MAX} bytes)` };
  }
  let text = bytes.toString('latin1');
  if (text.startsWith('\xef\xbb\xbf')) text = text.slice(3);
  text = text.replaceAll('\r\n', '\n');
  if (/[^\n -~]/.test(text)) {
    return { problem: 'holds a byte that is not printable ASCII (keep it as plain text)' };
  }
  const kept = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const named = kept.filter((line) => line.startsWith('BACKUP_SIGNING_PUBLIC_KEY='));
  if (named.length > 1) return { problem: 'names BACKUP_SIGNING_PUBLIC_KEY more than once' };
  if (named.length === 1) {
    const value = named[0].slice('BACKUP_SIGNING_PUBLIC_KEY='.length);
    return { keys: /^(["'])(.*)\1$/.exec(value)?.[2] ?? value };
  }
  if (!kept.length) return { problem: 'holds no keys' };
  if (kept.length > 1) {
    return {
      problem:
        'holds more than one line of keys (put them on one line, separated by single spaces, or after BACKUP_SIGNING_PUBLIC_KEY=)',
    };
  }
  return { keys: kept[0] };
}

/**
 * The keys a check takes: those of the key file when one is given, else the environment's
 * BACKUP_SIGNING_PUBLIC_KEY; refused when neither is given, or when they are not one Ed25519
 * public key or several, as restore.sh refuses them.
 */
export function givenKeys({ file, environment }: Keys): { keys: string } | Refusal {
  let keys = environment ?? '';
  if (file !== undefined) {
    let bytes: Buffer;
    try {
      bytes = readCapped(file, KEYS_MAX);
    } catch (error) {
      return refused(`the keys file could not be read (${why(error)})`);
    }
    const read = fileKeys(bytes);
    if ('problem' in read) return refused(`the keys file ${read.problem}`);
    keys = read.keys;
  } else if (!keys) {
    return refused(
      'BACKUP_SIGNING_PUBLIC_KEY is not set: give the list kept with the age key, in a file (--keys <file>) or in BACKUP_SIGNING_PUBLIC_KEY',
    );
  }
  if (!publicKeysOk(keys)) {
    return refused(
      `BACKUP_SIGNING_PUBLIC_KEY${file !== undefined ? ' in the keys file' : ''} is not one Ed25519 public key or several, as pnpm vps:secrets writes it (base64 SPKI DER, separated by single spaces)`,
    );
  }
  return { keys };
}

/**
 * Checks the folder's files of a night against the night's seal, signed by one of the keys, as
 * the head of this file says: the night's id first, then the keys, then the seal, then each file.
 * What to print: a line per part checked and the settings archive's sha256 last, or the one line
 * saying why nothing in the folder can be trusted.
 */
export function verifyNight(night: string, folder: string, from: Keys): Verdict {
  if (!NIGHT_ID.test(night)) {
    return refused(
      "the night must be named by its id as the backup's journal line prints it, like 2026-11-11T2030Z-0f3c9a1b",
    );
  }
  const given = givenKeys(from);
  if (!('keys' in given)) return given;
  const { keys } = given;
  // The folder's names as they are, matched exactly: a file is opened only by a name read here,
  // so a name that differs in case is never taken for a part on a disk that ignores case.
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    return refused(`the folder could not be read (${why(error)})`);
  }
  /** A name's entry, when it is a file (not a folder, nor a link to anything). */
  const fileOf = (name: string) => {
    const stats = lstatSync(resolve(folder, name));
    return stats.isFile() ? stats : undefined;
  };

  // The seal, as restore.sh reads one: by its name, no further than a byte past seal_max, in
  // seal_open's lines for this night, and signed by one of the keys.
  const sealName = `seal-${night}.txt`;
  if (!names.includes(sealName)) {
    return refused(
      `the folder holds no ${sealName}: download it beside the settings archive, from the night's folder of the bucket; a night with no seal there is not signed by the backup's key (a backup that stopped before its seal, or someone else wrote to the bucket: the backup's journal names the nights it sealed)`,
    );
  }
  let text: string;
  try {
    if (!fileOf(sealName)) {
      return refused(
        `${sealName} in the folder is not a file, so nothing in the folder can be trusted`,
      );
    }
    text = readCapped(resolve(folder, sealName), SEAL_MAX).toString('latin1');
  } catch (error) {
    return refused(`${sealName} in the folder could not be read (${why(error)})`);
  }
  const seal = sealOf(text, night);
  const problem =
    typeof seal === 'string'
      ? seal
      : signedBy(keys, seal.body, seal.signature)
        ? ''
        : "is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys";
  if (typeof seal === 'string' || problem) {
    return refused(
      `the night of ${night} is not signed by the backup's key: its seal (${sealName}) ${problem}, so someone else wrote to the bucket, and nothing in the folder can be trusted`,
    );
  }

  // A night whose backup had no settings archive fresh enough sealed none, and anything under
  // that name is someone else's (restore.sh's test refuses such a night too).
  const config = `config-${night}.tar.age`;
  const sealed = new Map(seal.parts.map((part) => [part.name, part]));
  const configPart = sealed.get(config);
  if (!configPart) {
    return refused(
      `the night of ${night} has no settings archive in its seal (${config}): its backup had none fresh enough, and anything under that name is someone else's: name the night before it`,
    );
  }

  // Every file named as one of the night's parts, as the seal gives it: its size first, so that a
  // file of another size is never read, then its sha256. A night whose base backup failed seals
  // "base none", and what of its base went up before it stopped can still be in the bucket under
  // the base's name (VPS-43), unread by anything: the one name the seal leaves out that is not
  // someone else's for certain, though it is refused all the same.
  const parts = names.filter((name) => sealPartName(name, night)).sort();
  for (const name of parts) {
    const part = sealed.get(name);
    if (!part) {
      return refused(
        name === `base-${night}.tar.zst.age` && !seal.base
          ? `${name} is not in the seal of ${night}, whose base backup failed: what of a base went up before it stopped is never read, so take it out of the folder and check again`
          : `${name} is not in the seal of ${night}, so the backup did not write it: someone else wrote to the bucket, and nothing in the folder can be trusted`,
      );
    }
    let held: { bytes: number; sha256: string };
    try {
      const stats = fileOf(name);
      if (!stats) {
        return refused(
          `${name} in the folder is not a file, so nothing in the folder can be trusted`,
        );
      }
      held =
        stats.size === part.bytes
          ? digest(resolve(folder, name))
          : { bytes: stats.size, sha256: '' };
    } catch (error) {
      return refused(`${name} in the folder could not be read (${why(error)})`);
    }
    if (held.bytes !== part.bytes) {
      return refused(
        `${name} is not the part the backup sealed (${held.bytes} bytes, not ${part.bytes}): a download cut short, or someone else wrote to the bucket, and nothing in the folder can be trusted`,
      );
    }
    if (held.sha256 !== part.sha256) {
      return refused(
        `${name} is not the part the backup sealed (its sha256 is not the seal's): someone else wrote to the bucket, and nothing in the folder can be trusted`,
      );
    }
  }
  if (!parts.includes(config)) {
    return refused(
      `the folder holds no ${config}: download the night's settings archive beside its seal`,
    );
  }

  const checked = seal.parts.filter(({ name }) => parts.includes(name));
  const matched =
    checked.length === 1
      ? 'the 1 part here matches it'
      : `the ${checked.length} parts here match it`;
  return {
    ok: true,
    lines: [
      ...checked.map(({ name, bytes, sha256 }) =>
        said(`${name} is the part the backup sealed (${bytes} bytes, sha256 ${sha256})`),
      ),
      said(
        `the seal of ${night} is signed by the backup's key, and ${matched}: copy ${config} to the server, where sha256sum must print ${configPart.sha256} for it before it is unpacked`,
      ),
    ],
  };
}

if (import.meta.main) {
  // Paths as the owner typed them: pnpm runs a script in the repository, and keeps where it was
  // called from in INIT_CWD.
  const here = process.env.INIT_CWD || process.cwd();
  let args: { values: { keys?: string; help?: boolean }; positionals: string[] } | undefined;
  try {
    args = parseArgs({
      options: { keys: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    args = undefined;
  }
  const verdict: Verdict = !args
    ? refused(USAGE)
    : args.values.help
      ? { ok: true, lines: [said(USAGE)] }
      : args.positionals.length !== 2
        ? refused(USAGE)
        : verifyNight(args.positionals[0], resolve(here, args.positionals[1]), {
            file: args.values.keys === undefined ? undefined : resolve(here, args.values.keys),
            environment: process.env.BACKUP_SIGNING_PUBLIC_KEY,
          });
  if (verdict.ok) {
    for (const line of verdict.lines) console.log(line);
  } else {
    console.error(verdict.line);
    process.exitCode = 1;
  }
}
