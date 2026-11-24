/**
 * A night's seal, the record of a month's copy and the backup's signatures (docs/DECISIONS.md
 * VPS-43), read with Node's crypto: deploy/vps/backup/seal.sh's and backup.sh's rules, kept here
 * once for the two scripts that need them on this machine. scripts/vps-kit.mts holds the shell to
 * the same verdicts (vps:backup-test gives seal_open and sealOf the same texts) and checks every
 * night the rehearsal seals, and every record of a copy it keeps, with them;
 * scripts/vps-verify-night.mts checks a night the owner downloaded from the bucket, before its
 * settings archive goes to a new server. Nothing here reads a file, runs a program or uses the
 * network.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/** A night's id as backup.sh makes one: its stamp, a dash and 8 random hex characters. */
export const NIGHT_ID = /^\d{4}-\d\d-\d\dT\d{4}Z-[0-9a-f]{8}$/;

/**
 * Whether a base64url signature (64 bytes, in its one spelling) is one of the message by any of
 * the Ed25519 public keys (base64 SPKI DER, separated by spaces), as seal.sh checks one.
 */
export function signedBy(publicKeys: string, message: string, signature: string): boolean {
  const bytes = Buffer.from(signature, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== signature) return false;
  return publicKeys.split(' ').some((key) => {
    try {
      const der = Buffer.from(key, 'base64');
      const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
      return verify(null, Buffer.from(message), publicKey, bytes);
    } catch {
      return false;
    }
  });
}

/** base64url of an Ed25519 signature by a base64 PKCS #8 DER key, as seal.sh writes one. */
export const signedWith = (privateKey: string, message: string) =>
  sign(
    null,
    Buffer.from(message),
    createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' }),
  ).toString('base64url');

/** The longest seal seal.sh's seal_open takes (seal_max), in bytes: a reader fetches one past it. */
export const SEAL_MAX = 16384;

/** A part of a night as its seal lists it. */
export type SealPart = { sha256: string; bytes: number; name: string };

/** Where a night's base backup starts, as its seal's base line gives it. */
export type SealBase = { end: string; walfile: string; cluster: string };

/** A night's seal, read: its base (none without one), its parts, and the signed lines' text. */
export type Seal = { base?: SealBase; parts: SealPart[]; body: string; signature: string };

/** Whether a name is one of a night's parts as backup.sh names them (seal.sh's part()). */
export function sealPartName(name: string, night: string): boolean {
  const fixed = [
    'globals-%.sql.age',
    'storage-%.tar.age',
    'manifest-%.txt.age',
    'config-%.tar.age',
  ];
  if ([...fixed, 'base-%.tar.zst.age'].some((form) => form.replace('%', night) === name))
    return true;
  const suffix = `-${night}.dump.age`;
  if (name.length <= suffix.length || !name.endsWith(suffix)) return false;
  const db = name.slice(0, -suffix.length);
  return /^[a-z_][a-z0-9_]*$/.test(db) && db.length < 64 && !/^template[01]$/.test(db);
}

/**
 * A night's seal as seal.sh's seal_open reads one, but for the signature (signedBy checks it): the
 * seal, or the problem that makes the text none, in seal_open's own words, so the harness can hold
 * the shell to the same verdicts. The text is the file's bytes, one character each (latin1).
 */
export function sealOf(text: string, night: string): Seal | string {
  if (!text.length) return 'is empty';
  if (text.length > SEAL_MAX) return `is longer than a seal's ${SEAL_MAX} bytes`;
  if (/[^\n -~]/.test(text) || !text.endsWith('\n')) {
    return 'holds a byte that is not printable ASCII, or does not end in a newline';
  }
  const line = text.slice(0, -1).split('\n');
  if (line.length < 4) return 'has fewer lines than a seal';
  if (line[0] !== `menumesh seal 1 ${night}`) {
    return `does not begin with the line "menumesh seal 1 ${night}"`;
  }
  const based = /^base (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) ([0-9A-F]{24}) ([1-9]\d{0,19})$/.exec(
    line[1],
  );
  if (line[1] !== 'base none' && !based) return 'has no base line as a backup writes one';
  const parts: SealPart[] = [];
  for (let i = 2; i < line.length - 1; i++) {
    const part = /^part ([0-9a-f]{64}) ([1-9]\d{0,14}) (\S+)$/.exec(line[i]);
    if (!part || !sealPartName(part[3], night)) {
      return `has a line ${i + 1} that is not a part as a backup lists one`;
    }
    if (parts.some(({ name }) => name === part[3])) return 'lists a part twice';
    parts.push({ sha256: part[1], bytes: Number(part[2]), name: part[3] });
  }
  if (!based === parts.some(({ name }) => name === `base-${night}.tar.zst.age`)) {
    return 'has a base line that its parts do not match';
  }
  const signature = /^signature ([A-Za-z0-9_-]{86})$/.exec(line[line.length - 1])?.[1];
  if (!signature) return 'does not end in a signature line';
  return {
    ...(based ? { base: { end: based[1], walfile: based[2], cluster: based[3] } } : {}),
    parts,
    body: `${line.slice(0, -1).join('\n')}\n`,
    signature,
  };
}

/** What seal_open says of a seal: "ok", or its problem, the signature checked against the keys. */
export function sealVerdict(text: string, night: string, publicKeys: string): string {
  const seal = sealOf(text, night);
  if (typeof seal === 'string') return seal;
  return signedBy(publicKeys, seal.body, seal.signature)
    ? 'ok'
    : "is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys";
}

/** A seal as backup.sh writes one, signed by a base64 PKCS #8 DER Ed25519 key. */
export function sealText(
  night: string,
  base: SealBase | undefined,
  parts: readonly SealPart[],
  privateKey: string,
): string {
  const body = [
    `menumesh seal 1 ${night}`,
    base ? `base ${base.end} ${base.walfile} ${base.cluster}` : 'base none',
    ...parts.map(({ sha256, bytes, name }) => `part ${sha256} ${bytes} ${name}`),
    '',
  ].join('\n');
  return `${body}signature ${signedWith(privateKey, body)}\n`;
}

/** The longest record of a month's copy that backup.sh's whole_copy takes, in bytes: it reads one past. */
export const RECORD_MAX = 256;

/**
 * The line a record of a night's month's copy signs (backup.sh's record_message): the night, and
 * the sha256 of its seal, every byte of it (the seal's text, one byte a character).
 */
export const recordMessage = (night: string, seal: string) =>
  `menumesh copy 1 ${night} ${createHash('sha256').update(Buffer.from(seal, 'latin1')).digest('hex')}\n`;

/**
 * The record of a night's month's copy as backup.sh writes it last to monthly/copy-<night>.txt,
 * for the seal the copy holds, signed by a base64 PKCS #8 DER Ed25519 key.
 */
export function recordText(night: string, seal: string, privateKey: string): string {
  const message = recordMessage(night, seal);
  return `${message}signature ${signedWith(privateKey, message)}\n`;
}

/**
 * A record of a month's copy as backup.sh's whole_copy reads one, but for the signature (signedBy
 * checks it): at most RECORD_MAX bytes, and byte for byte the line built here from the night and
 * its seal's text, then "signature ", 86 base64url characters and a newline. Nothing is taken from
 * the record but the signature, as whole_copy takes nothing else: the line and the signature, or
 * the problem that makes the text none. The texts are the files' bytes, one character each.
 */
export function recordOf(
  text: string,
  night: string,
  seal: string,
): { message: string; signature: string } | string {
  if (!text.length) return 'is empty';
  if (text.length > RECORD_MAX) return `is longer than a record's ${RECORD_MAX} bytes`;
  const message = recordMessage(night, seal);
  const signature = text.slice(message.length + 'signature '.length, -1);
  if (text !== `${message}signature ${signature}\n` || !/^[A-Za-z0-9_-]{86}$/.test(signature)) {
    return "is not the record of that night's seal";
  }
  return { message, signature };
}

/** What whole_copy makes of a record: "ok", or its problem, the signature checked against the keys. */
export function recordVerdict(
  text: string,
  night: string,
  seal: string,
  publicKeys: string,
): string {
  const record = recordOf(text, night, seal);
  if (typeof record === 'string') return record;
  return signedBy(publicKeys, record.message, record.signature)
    ? 'ok'
    : "is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys";
}

/**
 * Whether a list is one Ed25519 public key or several, as pnpm vps:secrets writes
 * BACKUP_SIGNING_PUBLIC_KEY: base64 SPKI DER, 60 characters a key, separated by single spaces. The
 * shapes seal.sh's seal_public_keys_ok takes, each one a key Node's crypto reads.
 */
export function publicKeysOk(list: string): boolean {
  return list.split(' ').every((key) => {
    if (!/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/.test(key)) return false;
    try {
      const der = Buffer.from(key, 'base64');
      const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
      return publicKey.asymmetricKeyType === 'ed25519';
    } catch {
      return false;
    }
  });
}
