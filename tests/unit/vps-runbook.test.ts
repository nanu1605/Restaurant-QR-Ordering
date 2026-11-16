import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SIGNING_PAIR_CHECK } from '../../scripts/vps-kit.mts';

/**
 * The steps of docs/RUNBOOK.md's "The shared server (VPS)" that no script runs: the owner follows
 * them by hand, on the server or in a disaster, so a step that went missing would show only then.
 * These text rules pin the procedure fixes of Stop C's re-reviews (docs/DECISIONS.md VPS-60 to
 * VPS-65, VPS-67, VPS-68 to VPS-76 and VPS-78 to VPS-94): every backup.sh run by hand comes right
 * after a settings archive made for it, and a new server enables the archive's timer (finding V3);
 * disaster recovery's step 2.4 puts the signing key's private half in, and step 4 stops backup
 * until db runs (V4) and checks the signing pair with SIGNING_PAIR_CHECK, character for character
 * (V2), quoting each line it prints, as the night's and the shipper's alerts quote the values that
 * are no keys (U4), and says what else the pair's refusal can mean (the third re-review's design
 * notes); step 2.2 takes a night from before a theft of the signing key with the stolen key's file
 * (V1), its versions of before the trouble made current before anything of it is downloaded or
 * recovered (U1), and its logical recovery gets that file's list for the one run (U2), but a night
 * an older key of the kept list signed takes the kept list (G3); after a theft the list keeps the
 * older keys that never leaked (U3), the backup's own records go new and name a night from before
 * only by what was recorded before (U5), every value of a leaked .env goes new (G2), and a server
 * reached as root is rebuilt with none of its nights taken (N1) and no private key put on it, its
 * backup key counted as stolen too once it was there (G1), its new pair made before the rebuild and
 * put in before the archive's timer and backup start (the fourth re-review's K1), and 2.4 puts the
 * newest backup public key in .env, whatever the archive held (the fifth re-review's M4); the key
 * list is kept in a file of its own, never in the age key's (design note 4); the month's copy is
 * named by either of the backup's lines (B1), each step of it that fails is quoted, with what it
 * found, and the way to the stolen-token steps (R1), where a line, an alert or a ping only keeps
 * the night it names and every other id is judged by its seal alone, downloaded byte for byte and
 * checked with each list, never by the journal (H1, and the fifth re-review's M2 and M3, which undo
 * E1's and K2's deletion of the names an alert lists), and step 3 lifts no lock after a reach as
 * root until the rebuild (the fifth re-review's M1), when step 2 is done again, as root could write
 * until then (the sixth re-review's theft design note 3); under versioning step 2 puts back every
 * version written over the backup's own, or deleted, whether or not a line keeps its night (the
 * sixth re-review's P2); a night a restore test or drill takes that no
 * record names, one stamped later than now and one passed over are signs of theft, and a seal a
 * list verifies that no record names takes its key for stolen (the sixth re-review's P1, which
 * puts back the sign the fifth took away); the drill names each of pitr.sh's refusals of
 * a base whose timeline a rewind left (M1), the recovery quotes what pitr.sh tells a point a cut
 * stops short of (T1), the way past the nights a rewind left takes out each one's seal in turn (T2)
 * and promises no point on the stretch it abandoned (F2), whose drill or recovery ends done only
 * once every left night's seal before it is out (the fourth re-review's design notes), a bad
 * release's point is taken from before its deploy began (the fifth re-review's deploy design
 * note 1), before the first attempt of it that ran its migrations, on a new server too (the sixth
 * re-review's N3), and step 7 deploys a release without a migrate reference, the one before a
 * rewind's after a settings archive from before it (F1), and after a night recovered on the same
 * server the one deploys.log names before its stamp, read in UTC, with Production's token (the
 * fourth re-review's J1), then sends out again only the newest release that stayed live (the fifth
 * re-review's L1 and L2), all by the state the recovery brought back, not by its kind: after
 * `latest` that ended at a cut the release from deploys.log, from before a bad release's deploy no
 * release made since it, ever, and with no release since nothing more (the sixth re-review's N1,
 * N2, N4 and N5).
 * Every rule also refuses a copy with one mistake, as tests/unit/vps-kit.test.ts does, among them
 * the RUNBOOK's text as it was before the fix. Every phrase is compared with its white space
 * folded, so a sentence wrapped again is still found, and a place whose end is missing is reported,
 * never read to the end of the section.
 */

const RUNBOOK = readFileSync(join('docs', 'RUNBOOK.md'), 'utf8');
const PITR = readFileSync(join('deploy', 'vps', 'backup', 'pitr.sh'), 'utf8');
const BACKUP = readFileSync(join('deploy', 'vps', 'backup', 'backup.sh'), 'utf8');
const SHIPPER = readFileSync(join('deploy', 'vps', 'backup', 'wal-ship.sh'), 'utf8');
const SEAL = readFileSync(join('deploy', 'vps', 'backup', 'seal.sh'), 'utf8');

/** `text` with `from` replaced by `to`; `from` must occur exactly once, so the bad copy applies. */
function swap(text: string, from: string, to: string): string {
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`${JSON.stringify(from)} occurs ${count} times`);
  return text.replace(from, () => to);
}

/** A rule's problems on a bad copy, which must hold `problem`. */
function refuses(rule: (text: string) => string[], bad: string, problem: string) {
  expect(rule(bad).join('\n')).toContain(problem);
}

/** The text from the first `from` to the first `to` after it, or undefined when either is missing. */
function part(text: string, from: string, to: string): string | undefined {
  const start = text.indexOf(from);
  if (start < 0) return undefined;
  const end = text.indexOf(to, start + from.length);
  return end < 0 ? undefined : text.slice(start, end);
}

/** `part`, which must be there: a refusal built from it applies. */
function cut(text: string, from: string, to: string): string {
  const found = part(text, from, to);
  if (found === undefined) throw new Error(`no ${JSON.stringify(from)} … ${JSON.stringify(to)}`);
  return found;
}

/**
 * `text` with each run of white space, line breaks among them, as one space: a rule reads a
 * sentence the same however the RUNBOOK wraps it (Stop C's second re-review, theft-docs design
 * note 2).
 */
const flat = (text: string) => text.replace(/\s+/g, ' ');

/** Whether `text` holds `phrase`, both read with their white space folded. */
const has = (text: string, phrase: string) => flat(text).includes(flat(phrase));

/** `text` as a literal in a regular expression. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The RUNBOOK's places that a rule reads, each from its first words to the next place's. */
const PLACES = {
  vps: ['## The shared server (VPS)', '\n## Razorpay live switch'],
  firstKey: ['1. **The backup key**', '2. **The bucket:**'],
  secrets: ['6. **The secrets**', '7. **The deploy key**'],
  tokenBullet: ["- The bucket's token, Telegram and the heartbeat addresses", '- The backup key:'],
  backupKey: ['- The backup key:', '- The signing key (after the server may have been reached'],
  rotation: ['- The signing key (after the server may have been reached', "- Staging's password"],
  lastNight: ["- **Last night's backup:**", '- **The monthly restore test**'],
  restoreTest: ['- **The monthly restore test**', '- **The monthly point-in-time drill**'],
  oldNight: ['**29 days old or more**', '**365 days old or more**'],
  drill: ['- **The monthly point-in-time drill**', '- **Disaster recovery**'],
  recovery: ['- **Disaster recovery**', '### A stolen or leaked bucket token (VPS)'],
  newServer: ['1. A new server:', "2. The night's id"],
  download: ['1. **Download**', '2. **Check**'],
  check: ['2. **Check**', '3. **Unpack**'],
  keyList: ['4. **The key list', '\n  3. `sudo app-apply menumesh compose'],
  backupImage: ['\n  4. The backup image that `images.env` names', '\n  5. The recovery'],
  fallback: ["**The fallback, a night's logical recovery**", '\n  6. `wal-spool` must be new'],
  start: ['\n  6. `wal-spool` must be new', '\n  7. '],
  release: ["\n  7. Production's image", '\n  8. The edge'],
  rerun: ['\n  9. The key off the ramfs', '### A stolen or leaked bucket token (VPS)'],
  stolen: ['### A stolen or leaked bucket token (VPS)', '1. **Rotate the token**'],
  cleanup: ['2. **Check the', '3. **Remove what the token holder wrote**'],
  remove: ['3. **Remove what the token holder wrote**', '4. **A restore test of a named night**'],
  theftTest: ['4. **A restore test of a named night**', '5. **If the server itself may have been'],
  theft: ['5. **If the server itself may have been reached**', '### Logs and alerts (VPS)'],
  walAlerts: ['- **WAL alerts**', '### Checking the kit here'],
  migrations: ['## Database migrations', '## Rolling back'],
} as const;

type Place = keyof typeof PLACES;

/** A place of the RUNBOOK, and what a rule says when it is missing. */
function place(runbook: string, name: Place): { text: string } | { problem: string } {
  const [from, to] = PLACES[name];
  const text = part(runbook, from, to);
  return text === undefined
    ? { problem: `the RUNBOOK has no ${name} (from ${JSON.stringify(from)})` }
    : { text };
}

/** Each place's text, or the problems of those missing; `check` sees only places that exist. */
function inPlaces(
  runbook: string,
  names: Place[],
  check: (texts: Record<Place, string>) => string[],
): string[] {
  const texts = {} as Record<Place, string>;
  const missing: string[] = [];
  for (const name of names) {
    const found = place(runbook, name);
    if ('problem' in found) missing.push(found.problem);
    else texts[name] = found.text;
  }
  return missing.length ? missing : check(texts);
}

const BY_HAND = 'sudo app-compose menumesh run --rm --no-deps -T backup /usr/local/bin/backup.sh';
const ARCHIVE = 'sudo systemctl start app-config-archive@menumesh.service';
const TIMER = 'sudo systemctl enable --now app-config-archive@menumesh.timer';

/** A run of backup.sh by hand: where it is, whether it is a line of a command block, whether that
 * line is BY_HAND as it is, and whether an earlier line of that block makes the settings archive. */
type Run = { line: number; inBlock: boolean; exact: boolean; archived: boolean };

/**
 * Each run of backup.sh in `text`: a line of a command block that names it, whatever its path, and
 * outside the blocks a span of code that names it with a compose `run` or `exec`, even one a line
 * break splits (Stop C's second re-review, theft-docs design note 2: the rule saw only the lines
 * naming /usr/local/bin/backup.sh, so `… backup backup.sh` escaped it).
 */
function byHandRuns(text: string): Run[] {
  const runs: Run[] = [];
  const names = (line: string) => /\bbackup\.sh\b/.test(line);
  let block: string[] | undefined;
  let prose: { start: number; lines: string[] } | undefined;
  const spans = () => {
    if (!prose) return;
    const joined = prose.lines.join('\n');
    for (const match of joined.matchAll(/`([^`]+)`/g)) {
      if (names(match[1]) && /\b(?:run|exec)\b/.test(match[1])) {
        const line = prose.start + joined.slice(0, match.index).split('\n').length - 1;
        runs.push({ line, inBlock: false, exact: false, archived: false });
      }
    }
    prose = undefined;
  };
  text.split('\n').forEach((line, at) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      spans();
      block = block ? undefined : [];
      return;
    }
    if (block) {
      if (names(line)) {
        runs.push({
          line: at + 1,
          inBlock: true,
          exact: trimmed === BY_HAND,
          archived: block.includes(ARCHIVE),
        });
      }
      block.push(trimmed);
    } else if (trimmed === '') {
      spans();
    } else {
      prose ??= { start: at + 1, lines: [] };
      prose.lines.push(line);
    }
  });
  spans();
  return runs;
}

/**
 * backup.sh fails a night whose settings archive is more than 2 hours old and seals none, and the
 * host makes one at 20:20 UTC only: so every backup.sh the RUNBOOK runs by hand is the command in a
 * block of its own, after the archive's start, in each place that runs one (Stop C's re-review,
 * finding V3); and a new server enables the archive's timer once .env is in place.
 */
const archiveFirst = (runbook: string) => [
  ...byHandRuns(runbook).flatMap(({ line, inBlock, exact, archived }) =>
    !inBlock
      ? [`line ${line} runs backup.sh by hand outside a command block of its own`]
      : !exact
        ? [`line ${line} runs backup.sh by hand, but not as ${JSON.stringify(BY_HAND)}`]
        : !archived
          ? [`line ${line} runs backup.sh by hand with no settings archive made before it`]
          : [],
  ),
  ...inPlaces(runbook, ['lastNight', 'drill', 'rerun', 'theft', 'walAlerts'], (texts) =>
    Object.entries(texts)
      .filter(
        ([, text]) => !byHandRuns(text).some((run) => run.inBlock && run.exact && run.archived),
      )
      .map(([name]) => `${name} runs no backup.sh by hand after a settings archive`),
  ),
  ...inPlaces(runbook, ['recovery'], ({ recovery }) =>
    has(recovery, TIMER) ? [] : ['disaster recovery never enables the settings archive’s timer'],
  ),
];

/** The one-off the owner runs, with SIGNING_PAIR_CHECK between its quotes. */
const PAIR_COMMAND = `sudo app-compose menumesh run --rm --no-deps -T backup sh -c '${SIGNING_PAIR_CHECK}'`;
/** What SIGNING_PAIR_CHECK prints for a pair: its one echo to stdout, every other one to stderr. */
const PAIR_SIGNS = /echo "([^"]+)";/.exec(SIGNING_PAIR_CHECK)?.[1] ?? '';
/** Every line SIGNING_PAIR_CHECK prints, the pass and each refusal. */
const PAIR_LINES = [...SIGNING_PAIR_CHECK.matchAll(/echo "([^"]+)"/g)].map((match) => match[1]);
/** What seal.sh prints when openssl can't sign the check's probe with a key of the right shape. */
const OPENSSL_LINE = 'seal: openssl could not sign probe';

/**
 * A settings archive from before a rotation holds the private key of before it, which the kept
 * list put in its place no longer begins with: backup.sh would seal no night and wal-ship.sh ship
 * no WAL (finding V2). So step 2.4 puts in BACKUP_SIGNING_KEY's private half from the password
 * manager, where Rotation keeps the new one, and step 4 checks the pair with SIGNING_PAIR_CHECK as
 * it is, before step 5, once the backup image is there. The pair's refusal also comes for a list
 * shaped as keys but not the kept one, out of order or with its first key mistyped, while a later
 * key mistyped passes, and a private key openssl can't load prints openssl's lines and seal.sh's
 * before it (Stop C's third re-review, docs design note 3 and backup design note 1): step 4 says so.
 * Since the fifth re-review 2.4 names the password manager for the backup key too (finding M4), so
 * the private key's sentence is read whole.
 */
const pairChecked = (runbook: string) =>
  inPlaces(
    runbook,
    ['keyList', 'backupImage', 'rotation'],
    ({ keyList, backupImage, rotation }) => [
      ...(has(
        keyList,
        "put in `BACKUP_SIGNING_KEY` the private half of the kept list's first key, from the password manager",
      )
        ? []
        : ['step 2.4 doesn’t put in BACKUP_SIGNING_KEY’s private half from the password manager']),
      ...(has(backupImage, PAIR_COMMAND)
        ? []
        : ['step 4 doesn’t check the signing pair with SIGNING_PAIR_CHECK as it is']),
      ...(PAIR_SIGNS && has(backupImage, `\`${PAIR_SIGNS}\``)
        ? []
        : ['step 4 doesn’t say what the signing pair’s check prints for a pair']),
      ...(has(rotation, 'password manager') && has(rotation, 'Disaster recovery, step 4')
        ? []
        : ['Rotation doesn’t keep the new private key in the password manager and check the pair']),
      ...(has(backupImage, 'its keys out of order (the new key goes first)') &&
      has(backupImage, 'its first key mistyped') &&
      has(backupImage, 'A mistyped later key passes this check')
        ? []
        : ['step 4 blames the private key alone for a list shaped as keys but not the kept one']),
      ...(has(backupImage, `\`${OPENSSL_LINE}\``)
        ? []
        : ['step 4 promises one line where a private key openssl can’t load prints more']),
    ],
  );

/** How backup.sh and wal-ship.sh begin the lines that name a signing value that is no key. */
const NO_LIST = 'BACKUP_SIGNING_PUBLIC_KEY is not one Ed25519 public key or several';
const NO_KEY = 'BACKUP_SIGNING_KEY is not an Ed25519 private key';

/**
 * A key list not shaped as keys made the pair check blame the private key, and backup.sh and the
 * shipper name the pair (Stop C's second re-review, finding U4): each now names the value, so step
 * 4 quotes every line the check prints, and the night's alerts and the WAL alerts quote the lines
 * of the list and of the private key as backup.sh and wal-ship.sh begin them.
 */
const valuesNamed = (runbook: string, backup: string, shipper: string) => [
  ...[NO_LIST, NO_KEY]
    .filter(
      (words) => !backup.includes(`fail "${words}, `) || !shipper.includes(`halted "${words}, `),
    )
    .map((words) => `backup.sh or wal-ship.sh no longer says “${words}”`),
  ...inPlaces(runbook, ['backupImage', 'lastNight', 'walAlerts'], (texts) => [
    ...PAIR_LINES.filter((line) => !has(texts.backupImage, `\`${line}\``)).map(
      (line) => `step 4 doesn’t quote the pair check’s “${line}”`,
    ),
    ...[NO_LIST, NO_KEY].flatMap((words) =>
      (['lastNight', 'walAlerts'] as const)
        .filter((name) => !has(texts[name], `\`${words}, …\``))
        .map((name) => `${name} doesn’t quote “${words}, …”`),
    ),
  ]),
];

/**
 * The RUNBOOK's sentence that makes a night's versions of before a theft the current ones, in the
 * words of each version of it.
 */
const VERSIONS =
  /make the versions? of [^.]*?went up before the trouble[^.]*? the current ones? again/;

/**
 * After a theft of the signing key the kept list takes only the nights made since, and a night of
 * the new key holds an archive of whatever a host reached as root held: so step 2.2 takes the night
 * from before the trouble, its versions of then made current first, checked with the stolen key's
 * file, which the theft's step 5 keeps apart, marked stolen (finding V1).
 */
const theftNight = (runbook: string) =>
  inPlaces(runbook, ['download', 'check', 'theft'], ({ download, check, theft }) => [
    ...(has(check, "pnpm vps:verify-night <id> <folder> --keys <the stolen key's file>")
      ? []
      : ['step 2.2 doesn’t check a night from before a theft with the stolen key’s file']),
    ...(VERSIONS.test(flat(download))
      ? []
      : ['step 2 doesn’t make the night’s versions of before the trouble current first']),
    ...(/reached as root/.test(flat(check))
      ? []
      : ['step 2.2 doesn’t say why a night of the new key is not the one after a reach as root']),
    ...(has(theft, 'marked stolen')
      ? []
      : ['the theft’s step 5 doesn’t keep the stolen key apart, marked stolen, out of the list']),
  ]);

/** The recover command of a night from before a theft, with any key given for the one run. */
const RECOVER_ONE_RUN =
  /--profile recover run --rm -e RESTORE_STAMP=<id> -e "?BACKUP_SIGNING_PUBLIC_KEY=/;

/**
 * Disaster recovery downloaded the night from before a theft (2.1) before 2.2 made its versions
 * of then current, and checked that folder with the stolen key's file, which passes whatever the
 * thief put over them with that key; the theft's step 5 recovered that night before it said so
 * (Stop C's second re-review, finding U1). So the versions are made current before 2.2's check, in
 * 2.1, and before the theft's recover command and its restore test.
 */
const theftOrder = (runbook: string) =>
  inPlaces(runbook, ['recovery', 'theft'], ({ recovery, theft }) => {
    const steps = flat(recovery);
    const checked = steps.indexOf('2. **Check**');
    const unpacked = steps.indexOf('3. **Unpack**');
    const inCheck = steps.slice(checked, unpacked);
    const made = steps.search(VERSIONS);
    const late = VERSIONS.test(inCheck) && !inCheck.includes('download them again');
    const fifth = flat(theft);
    const madeFirst = fifth.search(VERSIONS);
    const recovered = fifth.search(RECOVER_ONE_RUN);
    const tested = fifth.indexOf('Its restore test');
    return [
      ...(made >= 0 && checked >= 0 && made < checked && !late
        ? []
        : [
            'disaster recovery downloads a night from before a theft before its versions of then are current',
          ]),
      ...(madeFirst >= 0 &&
      recovered >= 0 &&
      madeFirst < recovered &&
      (tested < 0 || madeFirst < tested)
        ? []
        : [
            'the theft’s step 5 recovers the night from before the trouble before its versions of then are current',
          ]),
    ];
  });

/** The logical recovery of a night from before a theft, with the stolen key's file's list. */
const STOLEN_RECOVER = `sudo app-compose menumesh --profile recover run --rm -e RESTORE_STAMP=<id> -e "BACKUP_SIGNING_PUBLIC_KEY=<the stolen key's file's list>" -v /run/age:/run/age:ro recover`;

/**
 * Step 2.2 checked the night from before a theft "once" with the stolen key's file, and step 5's
 * fallback, its logical recovery, ran with .env's list, which refuses it (Stop C's second
 * re-review, finding U2): the fallback gives that file's list for the one run, quoted as it may
 * hold several keys, and the restore test of that night the same, as the theft's step 5 does.
 */
const oneRunKey = (runbook: string) =>
  inPlaces(runbook, ['fallback', 'check', 'theft'], ({ fallback, check, theft }) => [
    ...(has(fallback, STOLEN_RECOVER)
      ? []
      : ['step 5’s fallback gives a night from before a theft no key for that one run']),
    ...(has(fallback, 'a restore test of that night takes the same two `-e`')
      ? []
      : ['step 5’s fallback gives the restore test of such a night no key for its one run']),
    ...(has(theft, STOLEN_RECOVER)
      ? []
      : ['the theft’s step 5 doesn’t give the stolen key’s file’s list, quoted, for that one run']),
    ...(/check it once/.test(flat(check))
      ? [
          'step 2.2 checks the night from before the trouble once, though its recovery needs the file again',
        ]
      : []),
  ]);

/**
 * The theft's step 5 put "the new public key alone" in the list and the kept list's file, so an
 * older key kept for its nights, whose private half had left the server at its own rotation, was
 * dropped and kept nowhere (Stop C's second re-review, finding U3): the new key comes first, then
 * each older key that left the server before the trouble could have begun, never the stolen one,
 * and an older key that may have leaked goes into the stolen key's file with it. Two statements
 * still took that list for the new key alone (Stop C's third re-review, finding G3): the night by
 * hand names a month's copy an older key of the list recorded, and a night from before the trouble
 * that such a key signed is checked with the kept list and recovered with .env's, which the stolen
 * key's file refuses.
 */
const theftList = (runbook: string) =>
  inPlaces(
    runbook,
    ['theft', 'check', 'rotation', 'fallback'],
    ({ theft, check, rotation, fallback }) => [
      ...(has(
        theft,
        'the new public key first, then each older key of the list whose private half had left the server before the trouble could have begun',
      ) && has(theft, 'never the stolen key')
        ? []
        : ['the theft’s step 5 doesn’t keep the older keys that never leaked after the new one']),
      ...(has(
        theft,
        '`BACKUP_SIGNING_PUBLIC_KEY=<the stolen key> <each older key that may have leaked>`',
      )
        ? []
        : [
            'the theft’s step 5 doesn’t keep an older key that may have leaked apart with the stolen one',
          ]),
      ...(has(
        check,
        'holds the new key first, then only the older keys whose private half had left the server',
      )
        ? []
        : [
            'step 2.2 doesn’t say the kept list holds the new key first and the older keys after it',
          ]),
      ...(has(
        rotation,
        'whose private half had left the server before the trouble could have begun stays',
      )
        ? []
        : ['Rotation drops an older key a thief never held with the stolen one']),
      ...([theft, check, rotation].some((text) => /the new (?:public )?key alone/.test(flat(text)))
        ? ['the new list holds the new key alone, which drops every older key and keeps it nowhere']
        : []),
      ...(has(theft, "unless an older key the list still holds recorded this month's copy") &&
      !has(theft, "so the first night of the new key is the month's copy again")
        ? []
        : [
            'the theft’s night by hand makes the month’s copy again where an older key of the list recorded it',
          ]),
      ...(has(
        check,
        'That file is for a night the stolen key, or an older key that may have leaked, signed: one that an older key of the kept list signed is checked with the kept list',
      )
        ? []
        : [
            'step 2.2 checks a night an older key of the kept list signed with the stolen key’s file',
          ]),
      ...(has(fallback, 'that the stolen key, or an older key that may have leaked, signed') &&
      has(fallback, "One that an older key of the kept list signed is recovered with `.env`'s list")
        ? []
        : [
            'step 5’s fallback recovers a night an older key of the kept list signed with the stolen key’s file',
          ]),
      ...(has(
        theft,
        "one that an older key of the kept list signed is recovered with `.env`'s list",
      )
        ? []
        : [
            'the theft’s step 5 recovers a night an older key of the kept list signed with the stolen key’s file',
          ]),
    ],
  );

/**
 * The leaked .env held the backup monitor's address and the Telegram bot's token too, and the
 * steps took the night from before the trouble from the monitor's log, where a thief could ping a
 * night of their own (Stop C's second re-review, finding U5): the theft's step 5 keeps the log,
 * makes both heartbeat addresses and the bot's token new, and names that night only from records
 * made before the trouble could have begun; disaster recovery's step 2 says so too.
 */
const theftRecords = (runbook: string) =>
  inPlaces(runbook, ['theft', 'recovery'], ({ theft, recovery }) => [
    ...[
      ['a new address for `HEARTBEAT_BACKUP_URL`', 'HEARTBEAT_BACKUP_URL'],
      ['`HEARTBEAT_WAL_URL`', 'HEARTBEAT_WAL_URL'],
      ['a new token for the Telegram bot', 'the Telegram bot’s token'],
    ]
      .filter(([phrase]) => !has(theft, phrase))
      .map(([, what]) => `the theft’s step 5 doesn’t make ${what} new`),
    ...(has(theft, "copy the backup monitor's log off it")
      ? []
      : [
          'the theft’s step 5 doesn’t keep the monitor’s log before the leaked address can push it out',
        ]),
    ...(has(theft, 'Name it only from records made before the trouble could have begun') &&
    has(theft, 'never a ping received since')
      ? []
      : [
          'the theft’s step 5 names the night from before the trouble from records a thief could make',
        ]),
    ...(has(
      theft,
      "Two `backup` lines in one night's window, or an id that no record from before names, mean a night of the thief's: take the night before it",
    )
      ? []
      : ['the theft’s step 5 doesn’t pass over a night a thief may have pinged']),
    ...(has(recovery, 'named only from records made before the trouble could have begun')
      ? []
      : ['disaster recovery’s step 2 names a night from before a theft from any record']),
  ]);

/** What a leaked .env held besides the backup's own values, each with Rotation's step for it. */
const LEAKED = [
  'both cron secrets',
  "the schedulers' heartbeat addresses",
  "hosted staging's pooler login",
  'the API keys',
  '`POSTGRES_PASSWORD`',
];

/**
 * The theft's step 5 and Rotation's bullet for the bucket's token made only the backup's values of
 * a leaked .env new, though it held every value Secrets (VPS) lists: the API keys' set, the
 * database's password, both cron secrets, the schedulers' heartbeat addresses and hosted staging's
 * pooler login (Stop C's third re-review, finding G2). Both now say a leaked .env leaked every
 * value in it and send the rest to Rotation, which gains a step for the pooler login.
 */
const envLeaked = (runbook: string) =>
  inPlaces(runbook, ['theft', 'tokenBullet', 'vps'], ({ theft, tokenBullet, vps }) => {
    // The lead-in ends at sub-step 1: with that title gone it is missing, never the whole step,
    // whose sub-steps would then pass for it (Stop C's fourth re-review, theft design note 3).
    const lead = part(flat(theft), '5. **If the server itself', '1. **The signing key**');
    return [
      ...(lead === undefined
        ? ['the theft’s step 5 has no sub-step 1 (“1. **The signing key**”) to end its lead-in']
        : []),
      ...[
        ['the theft’s step 5', lead ?? ''],
        ['Rotation’s bullet for the bucket’s token', tokenBullet],
      ].flatMap(([name, text]) => [
        ...(has(text, 'leaked `.env` leaked every value in it')
          ? []
          : [`${name} doesn’t say a leaked .env leaked every value in it`]),
        ...LEAKED.filter((value) => !has(text, value)).map(
          (value) => `${name} leaves ${value} of a leaked .env as it was`,
        ),
      ]),
      ...(has(vps, "- Hosted staging's pooler login (`STAGING_DB_*`): a new database password")
        ? []
        : ['Rotation has no step for hosted staging’s pooler login']),
    ];
  });

/**
 * Where the old server may have been reached as root, its night of the new key carries its data
 * folder, ALTER SYSTEM settings and planted files and all, which a point-in-time recovery puts back
 * for db, and the new key went into its .env (Stop C's second re-review, N1): nothing it made after
 * the trouble is trusted, it is rebuilt with a fresh signing pair, and the night from before the
 * trouble is recovered logically, as none of that server's nights may be taken by a point-in-time
 * recovery (the third re-review, docs design note 6: "none … may be taken" alone forbade that
 * logical recovery too).
 */
const rootReach = (runbook: string) =>
  inPlaces(runbook, ['theft', 'recovery', 'check'], ({ theft, recovery, check }) => [
    ...(has(theft, 'nothing it made after the trouble could have begun is trusted')
      ? []
      : ['the theft’s step 5 trusts what a server reached as root made after the trouble']),
    ...(has(theft, 'never by a point-in-time recovery from the reached server')
      ? []
      : [
          'the theft’s step 5 lets a point-in-time recovery start from the reached server’s nights',
        ]),
    ...(has(theft, 'gets a fresh signing pair') &&
    has(theft, "goes into no list and not into the stolen key's file")
      ? []
      : ['the theft’s step 5 keeps the signing key the reached server held']),
    ...(has(
      recovery,
      "none of that server's nights may be taken by a point-in-time recovery, the new key's included",
    )
      ? []
      : ['disaster recovery’s first choice may start from a night of a server reached as root']),
    ...(has(check, 'nothing it made after the trouble could have begun is taken')
      ? []
      : ['step 2.2 distrusts only the archive of a night a server reached as root made']),
  ]);

/** `text` from the first `from` on, or '' when it is missing. */
const after = (text: string, from: string) => {
  const at = text.indexOf(from);
  return at < 0 ? '' : text.slice(at);
};

/**
 * After a possible reach as root the theft's steps still ran the restore test and the drill on the
 * reached server, at its step 4, at the end of Rotation and in its sub-step 4, each putting the
 * backup key's private half on that server's ramfs; and the rebuilt list kept the older signing
 * keys, whose private halves are in every settings archive that key opens (Stop C's third
 * re-review, finding G1). Where root may have reached the server they run on the rebuilt one only,
 * and a backup key that was on that server since the trouble could have begun counts as stolen too:
 * a new backup pair, and every older key in the stolen key's file, not the rebuilt list. That new
 * pair came only "the same day", while disaster recovery's step 1 fills the admin's
 * BACKUP_RECIPIENT, which app-config-archive encrypts each archive to, and 2.4 enables its timer:
 * the rebuilt server's first archive, its fresh signing key inside, could go to the stolen key
 * (Stop C's fourth re-review, finding K1). The pair is now made before the recovery begins, in the
 * admin's conf at step 1 and in .env at 2.4, before the timer and backup start, and 2.4 checks the
 * conf against .env first; the list's clauses that keep the older keys out are pinned (theft design
 * note 1), and Rotation says a run across a backup-key switch needs both private keys (theft design
 * note 4). Yet step 3 lifted a folder's lock before the rebuild, while root could read the token
 * step 1 put into the reached server's .env and delete under that lock with it (Stop C's fifth
 * re-review, finding M1): step 3, step 5's lead-in and sub-step 5 now lift no lock until the
 * rebuild, once step 1's token is revoked and the bucket's only token is the rebuilt server's; and
 * sub-step 5 revokes it before disaster recovery's step 2 reads the bucket, as with it root could
 * put a night of the stolen key over the versions 2.1 makes current (seen while fixing M1). And 2.4
 * settled a conf that differs from .env toward the archive's .env, whose key is the retired one
 * after a rotation of the backup key (finding M4): .env takes the newest backup public key first,
 * whatever the archive held, and the conf must print it; step 1's sentence on the new pair and
 * 2.4's remedy are pinned (theft design note 1). But step 2 was still judged before that
 * revocation, so what root wrote with step 1's token after it, versions over the backup's own
 * among them, stayed (Stop C's sixth re-review, theft design note 3): step 2, its versions among
 * them, is done again once the token is revoked, before step 3. Step 3 now waits for the only token
 * that can write or delete, as disaster recovery's read-only token for a download may stay (theft
 * design note 4), and sub-step 5 says the reached server alerts from the revocation on, and gets
 * no token (finding P3).
 */
const rootKeys = (runbook: string) =>
  inPlaces(
    runbook,
    ['theftTest', 'theft', 'rotation', 'check', 'keyList', 'backupKey', 'remove', 'newServer'],
    ({ theftTest, theft, rotation, check, keyList, backupKey, remove, newServer }) => {
      const steps = flat(theft);
      const lead = part(steps, '5. **If the server itself', '1. **The signing key**') ?? '';
      const fourth =
        part(steps, '4. **A night from before the trouble**', '5. **If root may have reached') ??
        '';
      const fifth = after(steps, '5. **If root may have reached the server**');
      const pair = after(fifth, "If the backup key's private half was on that server since");
      const keys = flat(keyList);
      const conf = keys.indexOf("grep '^BACKUP_RECIPIENT=' /etc/apps/menumesh.conf");
      return [
        ...(has(theftTest, 'they run on the rebuilt server only')
          ? []
          : [
              'the stolen-token step 4 runs the restore test and the drill on a server root may still hold',
            ]),
        ...(has(theft, 'no private key that outlives the rebuild (sub-step 5) goes on it')
          ? []
          : ['the theft’s step 5 puts private keys on a server root may still hold']),
        ...(has(rotation, 'they run on the rebuilt server only')
          ? []
          : ['Rotation runs its closing tests on a server root may still hold']),
        ...(fourth.includes('run on the rebuilt server only')
          ? []
          : ['the theft’s sub-step 4 recovers and tests a night on a server root may still hold']),
        ...(fifth.includes('the backup key counts as stolen too') &&
        fifth.includes('a new backup pair')
          ? []
          : ['the theft’s step 5 never counts the backup key as stolen after a reach as root']),
        ...(fifth.includes(
          "every older key of sub-step 1 goes into the stolen key's file, not the rebuilt list",
        )
          ? []
          : [
              'the theft’s step 5 keeps the older keys in the rebuilt list, though the backup key opens their private halves',
            ]),
        ...(has(check, 'the backup key counts as stolen too')
          ? []
          : ['step 2.2 never counts the backup key as stolen after a reach as root']),
        ...(pair.includes('made as in First install, step 1, before Disaster recovery begins') &&
        pair.includes(
          "its public key goes to the admin for `BACKUP_RECIPIENT` at Disaster recovery, step 1, and into `.env`'s `BACKUP_AGE_RECIPIENT` at step 2.4",
        ) &&
        pair.includes(
          "before 2.4 checks the admin's conf and enables the settings archive's timer and before step 6 starts `backup`",
        )
          ? []
          : [
              'the theft’s step 5 doesn’t make the new backup pair before the rebuild and put it in before the archive’s timer and backup start',
            ]),
        ...(pair.includes('the same day')
          ? [
              'the theft’s step 5 puts the new backup pair in only the same day, after the rebuilt server’s first archive may be made',
            ]
          : []),
        ...(has(check, 'new backup pair, made before this recovery began') &&
        has(check, "before the settings archive's timer and `backup` start")
          ? []
          : [
              'step 2.2 doesn’t put the new backup pair in before the archive’s timer and backup start',
            ]),
        ...(fifth.includes('(none when the backup key counts as stolen too, below)')
          ? []
          : [
              'the theft’s step 5 keeps the older keys in the rebuilt list where the backup key counts as stolen',
            ]),
        ...(has(check, "every older key leaves the kept list for the stolen key's file")
          ? []
          : [
              'step 2.2 keeps the older keys in the kept list where the backup key counts as stolen',
            ]),
        ...(conf >= 0 &&
        conf < keys.indexOf(TIMER) &&
        keys.includes("sudo grep '^BACKUP_AGE_RECIPIENT=' /srv/menumesh/.env")
          ? []
          : [
              'step 2.4 enables the archive’s timer without checking that the admin’s conf names .env’s backup key',
            ]),
        ...(keys.includes(
          '`BACKUP_AGE_RECIPIENT` becomes the newest backup public key here, whatever the archive held',
        ) &&
        keys.includes(
          "the new pair's where the backup key counts as stolen too (2.2), else the one whose private half is the newest in the password manager",
        ) &&
        keys.includes('first check that it is that same key') &&
        keys.includes('or the admin puts that key in the conf')
          ? []
          : [
              'step 2.4 puts in the admin’s conf the backup key the archive’s .env held, a retired one after a rotation',
            ]),
        ...(has(
          newServer,
          "Where the backup key counts as stolen (2.2), its new pair is made before this step, and the admin's `BACKUP_RECIPIENT` (First install, step 9) is the new public key",
        )
          ? []
          : [
              'disaster recovery’s step 1 fills the admin’s BACKUP_RECIPIENT before the new backup pair is made',
            ]),
        ...(has(backupKey, 'needs both private keys in `identity.txt`')
          ? []
          : [
              'Rotation’s backup key step doesn’t say a run across the switch needs both private keys',
            ]),
        ...(has(
          remove,
          'Where root may have reached the server (step 5), lift no lock while a token that server held or could read is valid',
        ) &&
        has(remove, "this step waits for sub-step 5's rebuild, once step 1's token is revoked") &&
        lead.includes(
          "(step 3, where root may have reached the server, only after sub-step 5's rebuild)",
        ) &&
        fifth.includes(
          "The bucket's token goes new once more, into the rebuilt server's `.env` alone, and step 1's token is revoked",
        )
          ? []
          : [
              'step 3 lifts a folder’s lock while a token the server reached as root could read is valid',
            ]),
        ...(fifth.includes(
          "step 1's token is revoked before Disaster recovery, step 2, reads the bucket",
        )
          ? []
          : [
              'the theft’s step 5 leaves step 1’s token valid while disaster recovery makes the night’s versions current and downloads it',
            ]),
        ...(has(
          remove,
          "once step 1's token is revoked and the only token that can write or delete is the rebuilt server's",
        )
          ? []
          : [
              'step 3 waits for the bucket’s only token to be the rebuilt server’s, which a read-only token for a download never lets be true',
            ]),
        ...(has(
          remove,
          "and step 2 is done again first, its versions among them, as root could write with step 1's token until then",
        ) && fifth.includes('so only then is step 2 done again, its versions among them')
          ? []
          : [
              'step 2 judges the bucket only while root may still write to it with step 1’s token, so what root wrote since stays',
            ]),
        ...(fifth.includes('that is expected, and it gets no token')
          ? []
          : [
              'the theft’s step 5 says nothing of what the reached server alerts once step 1’s token is revoked',
            ]),
      ];
    },
  );

/**
 * On a new server app-deploy's switch starts backup before db exists, whose shipper then alerts
 * every hour and whose night fails (finding V4): step 4 stops it right after the deploy and before
 * the pair's check, and step 6 starts it after db.
 */
const backupStopped = (runbook: string) =>
  inPlaces(runbook, ['backupImage', 'start'], (texts) => {
    const image = flat(texts.backupImage);
    const start = flat(texts.start);
    const deployed = image.indexOf('app-deploy menumesh backup');
    const stopped = image.indexOf('sudo app-compose menumesh stop backup');
    const checked = image.indexOf(flat(PAIR_COMMAND));
    return [
      ...(stopped > deployed && deployed >= 0 && (checked < 0 || stopped < checked)
        ? []
        : ['step 4 doesn’t stop backup right after the deploy, before the pair’s check']),
      ...(start.includes('already running')
        ? ['step 6 still takes backup for running since step 4']
        : []),
      ...(start.indexOf('up -d db') >= 0 &&
      start.indexOf('up -d db') < start.indexOf('api-gw backup')
        ? []
        : ['step 6 doesn’t start backup after db']),
    ];
  });

/**
 * age reads the file of its key as keys, comments and blank lines alone, so the key list is kept
 * beside the age key in a file of its own and never inside it (design note 4): nothing of the
 * RUNBOOK's VPS part says "with the age key", and install's steps 1 and 6 and Rotation say so.
 * Each phrase is read with its white space folded, as every rule's is (Stop C's third re-review,
 * finding G4: these matched spaces they spelled out, so a sentence wrapped again failed them, and
 * "with the age key" wrapped again escaped).
 */
const listApart = (runbook: string) =>
  inPlaces(runbook, ['vps', 'firstKey', 'secrets', 'rotation'], (texts) => [
    ...[...flat(texts.vps).matchAll(/with the age key/g)].map(
      () => 'the RUNBOOK keeps the key list with the age key',
    ),
    ...(['firstKey', 'secrets', 'rotation'] as const)
      .filter((name) => !has(texts[name], 'file of its own'))
      .map((name) => `${name} doesn’t keep the key list in a file of its own`),
    ...(has(texts.secrets, "never in the age key's file") &&
    has(texts.firstKey, 'never inside `menumesh-backup-key.txt`')
      ? []
      : ['install doesn’t keep the key list out of the age key’s file']),
  ]);

const RELIED = "the month's copy is <id>";
const MADE = "kept in monthly/ as the month's copy";

/**
 * The night that makes the month's copy says so in a line of its own, and every later whole night
 * names the copy it found (finding B1): the monthly check, naming a night 29 days old or more and
 * step 2.1's download from monthly/ take either line, and nobody copies a night by hand, as a copy
 * without its record is never counted, however the sentence that did is wrapped (finding G4).
 */
const copyNamed = (runbook: string) =>
  inPlaces(runbook, ['restoreTest', 'oldNight', 'download'], (texts) => [
    ...(['restoreTest', 'oldNight', 'download'] as const)
      .filter((name) => !has(texts[name], RELIED) || !has(texts[name], MADE))
      .map((name) => `${name} doesn’t take both of the backup’s lines for the month’s copy`),
    ...(has(texts.restoreTest, 'its parts first and its seal last')
      ? ['the restore test still copies a night to monthly/ by hand']
      : []),
  ]);

/** The reasons backup.sh gives the steps of the month's copy, from its first to the removal. */
const copyReasons = (backup: string) =>
  [
    ...(
      part(backup, "reason='the monthly copy'", "reason='the removal of old copies'") ?? ''
    ).matchAll(/reason=(['"])(.+?)\1/g),
  ].map((match) => match[2]);

/** How backup.sh ends the line that stops a night on a name of its copy already in monthly/. */
const plantedEndings = (backup: string) =>
  [
    ...backup.matchAll(/fail "someone else wrote to the bucket: monthly\/ holds \$there ([^"]+)"/g),
  ].map((match) => match[1]);

/**
 * What the steps of the month's copy find, which the alert gives in place of the step's reason:
 * each `fail` line of backup.sh from the copy's first step to the removal, but those that stop a
 * night on a planted name, with the night's id as <id> and a part's name as <name>.
 */
const copyFindings = (backup: string) =>
  [
    ...(
      part(backup, "reason='the monthly copy'", "reason='the removal of old copies'") ?? ''
    ).matchAll(/\bfail (["'])(.+?)\1/g),
  ]
    .map((match) => match[2])
    .filter((line) => !line.includes('$there'))
    .map((line) => line.replaceAll('$night', '<id>').replaceAll('$name', '<name>'));

/**
 * Whether every name backup.sh looks up before a line that stops a night on a name someone else
 * wrote is one of that night's own: each part `expected` gains, and each name the three lookups add
 * to it, carries `$night`. So such a line lists that night's names alone.
 */
const ownNamesLookedUp = (backup: string) => {
  const parts = [...backup.matchAll(/\bexpected="([^"]*)"/g)]
    .flatMap((match) => match[1].split(' '))
    .filter((name) => name !== '$expected');
  const lookups = [...backup.matchAll(/\bthere=\$\(([\s\S]*?)\|\s*held /g)].map(
    (match) => match[1],
  );
  const named = lookups.flatMap((lookup) =>
    [...lookup.matchAll(/"([^"$]*\$[^"]*)"/g)]
      .map((match) => match[1])
      .filter((name) => !name.startsWith('${')),
  );
  return (
    lookups.length === 3 &&
    parts.length > 0 &&
    named.length > 0 &&
    [...parts, ...named].every((name) => name.includes('-$night.'))
  );
};

/**
 * A name put under one of tonight's monthly/ names failed the copy with a reason that never said
 * so, and the RUNBOOK sent every such alert to wait for the next night (Stop C's second re-review,
 * finding R1): Last night's backup quotes each reason backup.sh gives a step of the copy and the
 * lines that stop a night on a planted name, and sends a lock's refusal or the same step night after
 * night to the stolen-token steps, whose list takes it so; the restore test's remedy says no night
 * was whole only of nights that failed before their seal, and waits for a night of the month. Since
 * the third re-review: Last night's backup quotes every line a step of the copy gives in place of
 * its reason, one an alert, never a step and what it found together (docs design note 2); the
 * restore test's remedy names the nights sealed and then failed at the end (docs design note 1);
 * and the stolen-token steps took the names a stopped night's alert lists for the token holder's,
 * which the backup writes too and which, left there, can fill the month's candidates (finding E1).
 * But a leaked .env sends that alert and root writes the journal, so since Stop C's fifth re-review
 * an alert only keeps the night it names, and those names stay, a cost only of extra copies for the
 * rest of their month: the steps no longer take them, and backup.sh still lists that night's own
 * names alone, as Last night's backup says.
 */
const copySteps = (runbook: string, backup: string) => {
  const reasons = copyReasons(backup);
  const endings = plantedEndings(backup);
  const findings = copyFindings(backup);
  return [
    ...(reasons.length ? [] : ['backup.sh gives the month’s copy no step of its own']),
    ...(endings.length
      ? []
      : ['backup.sh stops no night on a name of its copy already in monthly/']),
    ...(ownNamesLookedUp(backup)
      ? []
      : ['backup.sh looks up a name of another night before a line that says someone holds it']),
    ...inPlaces(runbook, ['lastNight', 'restoreTest', 'stolen', 'cleanup'], (texts) => {
      const night = flat(texts.lastNight);
      const test = flat(texts.restoreTest);
      const taken = part(flat(texts.stolen), 'Take it as stolen when', "shouldn't be.") ?? '';
      return [
        ...findings
          .filter((line) => !night.includes(`\`${line}\``))
          .map(
            (line) => `Last night’s backup doesn’t quote what a step of the copy found, “${line}”`,
          ),
        ...(night.includes('with what it found') || !night.includes('or in its place')
          ? ['Last night’s backup reads as if one alert carried a step and what it found']
          : []),
        ...(test.includes('Nights sealed and then failed at the end')
          ? []
          : ['the restore test says nothing of the nights sealed and then failed at the end']),
        ...(has(texts.cleanup, "the names a night's alert lists")
          ? [
              'the stolen-token steps delete the names a night’s alert lists, though an alert only keeps the night it names',
            ]
          : []),
        ...reasons
          .filter((reason) => !night.includes(`\`${reason}\``))
          .map((reason) => `Last night’s backup doesn’t quote the copy’s step “${reason}”`),
        ...endings
          .filter(
            (ending) =>
              !new RegExp(
                `\`someone else wrote to the bucket: monthly/ holds [^\`]+ ${literal(ending)}\``,
              ).test(night),
          )
          .map((ending) => `Last night’s backup doesn’t quote “… monthly/ holds … ${ending}”`),
        ...(night.includes("a lock's refusal") &&
        night.includes('two nights running') &&
        night.includes('follow A stolen or leaked bucket token (VPS)')
          ? []
          : [
              'Last night’s backup doesn’t send a copy step refused by a lock, or failing night after night, to the stolen-token steps',
            ]),
        ...(taken.includes("month's copy") && taken.includes('night after night')
          ? []
          : [
              'the stolen-token steps don’t take a copy step refused by a lock, or failing night after night, for a stolen token',
            ]),
        ...(test.includes('no night of the month has been whole') ||
        !test.includes('before their seal')
          ? ['the restore test takes a month with no copy for one whose nights were never whole']
          : []),
        ...(test.includes('on the 1st before 20:30 UTC')
          ? []
          : ['the restore test looks for the month’s copy before a night of the month has run']),
      ];
    }),
  ];
};

/**
 * The stolen-token step 2 took every id in the bucket that no line of its 30 days' journal names
 * for the token holder's, and step 3 deletes those past the folder's lock. But monthly/ keeps each
 * month's copy 366 days, each night's line names only its own month's copy, and the journal keeps
 * 180 to 187 days: up to ten genuine month's copies were the holder's (Stop C's fourth re-review,
 * finding H1). Now the lines shown name daily/'s nights and the copies of their months; daily/'s
 * ids no line names, failed nights' alert lines among the lines, are the holder's but for those
 * stamped before the 30 days; an id of monthly/ no line shown names is checked by its seal and
 * settings archive with pnpm vps:verify-night, and only a seal both lists refuse goes (or its
 * version from before the trouble comes back), the rest of that id staying, its record among them,
 * which under versioning may be the backup's; and the triggers take only daily/'s ids for a sign of
 * a stolen token. Still the journal condemned daily/'s ids, though a rebuilt server's begins at the
 * rebuild, root can empty it and a night stopped after its seal has no line (Stop C's fifth
 * re-review, finding M2); a seal verify-night refused for its form, as after a CRLF or cut-short
 * download, went as one signed by no key, since both refusals open alike (finding M3); and the
 * stolen key's file was one, though each theft leaves one (theft design note 3). Now a line, an
 * alert or a ping only keeps the night it names, every other id of daily/ and monthly/ is judged by
 * its seal alone, downloaded byte for byte at the size the bucket lists, with the kept list and
 * each stolen key's file, and only a seal every list refuses as signed by none of the keys, or for
 * its form, goes; an older version a list verifies comes back in its place, after a leaked .env
 * only one from before the trouble (theft design note 2); a pass or a refusal past the seal keeps
 * the id, as step 3 keeps the backup's own month's copies (theft design note 1); and no trigger
 * takes ids no line names. With that trigger gone, a restore test or drill that took a night no
 * record names, signed by a key stolen unnoticed, led nowhere near these steps, and neither did a
 * night stamped later than now nor one, or WAL objects, the drill passed over (Stop C's sixth
 * re-review, finding P1, and theft design note 6): each is a trigger now, which condemns nothing,
 * and step 2 takes the key that signed a seal no whole record names for stolen. Under versioning,
 * a seal or part put over the backup's own in a night a line keeps, and a delete marker, stayed
 * current, so step 4's restore test of that night failed and sent the owner back to step 2 (finding
 * P2): step 2 now lists every folder's versions and puts the backup's back for every name written
 * twice, whether or not a line keeps its night. "Only a seal that every list refuses" and the
 * wal/ names that stay are pinned too (theft design notes 1 and 2).
 */
const oldCopies = (runbook: string) =>
  inPlaces(runbook, ['stolen', 'cleanup', 'remove'], ({ stolen, cleanup, remove }) => {
    const taken = part(flat(stolen), 'Take it as stolen when', "shouldn't be.") ?? '';
    return [
      ...(has(cleanup, 'Ids in the bucket that no line names')
        ? [
            'the stolen-token steps take every id no line shown names for the token holder’s, older month’s copies among them',
          ]
        : []),
      ...(has(cleanup, 'so are ids no line names')
        ? [
            'the stolen-token steps take daily/’s ids no line shown names for the token holder’s, though a rebuilt server’s journal, or one root emptied, names none',
          ]
        : []),
      ...(has(cleanup, 'only keeps the night it names, and never condemns one') &&
      has(cleanup, 'So nothing goes because no line names it, or because an alert names it') &&
      has(cleanup, 'Every other id in `daily/` and `monthly/` is judged by its seal alone') &&
      has(cleanup, '`[menumesh] backup failed (exit …) at <id>: …` line a night that failed')
        ? []
        : [
            'the stolen-token steps let a line, an alert or a ping, or the lack of one, condemn an id, though the holder, root or a rebuild can forge or lose them',
          ]),
      ...(has(
        cleanup,
        'Download its `seal-<id>.txt` and `config-<id>.tar.age` from that folder into an empty folder, as in Disaster recovery, step 2.1',
      ) &&
      has(cleanup, "pnpm vps:verify-night <id> <folder> --keys <the list's file>") &&
      has(cleanup, "Its record and parts stay, as they may be the backup's") &&
      has(cleanup, 'as does an id with no seal at all')
        ? []
        : ['the stolen-token steps delete an id no line keeps without checking its seal']),
      ...(has(
        cleanup,
        "with the provider's download, byte for byte and never from a text preview",
      ) &&
      has(cleanup, "seal's size is the one the bucket lists") &&
      has(
        cleanup,
        "`its seal (seal-<id>.txt) is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys`",
      ) &&
      !has(cleanup, "`the night of <id> is not signed by the backup's key: its seal …`")
        ? []
        : [
            'the stolen-token steps take a seal refused for its form, as a download that is not byte for byte is, for one signed by no key',
          ]),
      ...(has(cleanup, "with each stolen key's file kept (one for each theft") &&
      !has(cleanup, "with the stolen key's file where there is one")
        ? []
        : [
            'the stolen-token steps check a seal with one stolen key’s file, though each theft leaves one',
          ]),
      ...(has(
        cleanup,
        'where the bucket kept an older version of it that a list verifies, make that one current again instead',
      ) &&
      has(
        cleanup,
        'make that one current again instead (after a leaked `.env`, step 5, only a version from before the trouble',
      )
        ? []
        : [
            'the stolen-token steps delete a refused seal whose older version a list verifies, or keep it hidden in a token-only theft',
          ]),
      ...(has(
        cleanup,
        'A pass, or a refusal past the seal (of the settings archive or a part), means a key of a list signed its seal: that id stays',
      )
        ? []
        : ['the stolen-token steps delete an id whose seal a key of a list signed']),
      ...(has(remove, "The backup's own nights, month's copies and WAL stay")
        ? []
        : ['the stolen-token step 3 deletes the backup’s own nights, month’s copies or WAL']),
      ...(!taken.includes('no journal line names') &&
      taken.includes('when the bucket holds names the backup never writes')
        ? []
        : [
            'the stolen-token steps take ids no journal line names for a sign of a stolen token, as every night before a rebuild is',
          ]),
      ...(taken.includes(
        "when a restore test, drill or recovery takes a night that none of the backup's own records names",
      ) &&
      taken.includes('`restore: not taking the night of <id>, stamped later than now`') &&
      taken.includes(
        "`pitr: not taking the night of <id>: its seal …, so it is not the backup's`",
      ) &&
      taken.includes("`<n> objects passed over, not the backup's`, n above 0")
        ? []
        : [
            'the stolen-token steps take no night a restore takes that no record names, or stamped later than now, or a night or WAL objects passed over, for a sign of a stolen token',
          ]),
      ...(has(
        cleanup,
        "Where the bucket keeps versions (versioning, or S3 Object Lock), list each folder's versions too, delete markers among them",
      ) &&
      has(
        cleanup,
        'so a name with more than one version, or a delete marker, is one someone else',
      ) &&
      has(
        cleanup,
        'For each such name, whether or not a line keeps its night, make current again',
      ) &&
      has(cleanup, 'A line only keeps an id from going, never a version put over the backup')
        ? []
        : [
            'the stolen-token steps leave current a version put over the backup’s own, or a delete marker, in a night a line keeps',
          ]),
      ...(has(cleanup, 'Only a seal that every list refuses')
        ? []
        : [
            'the stolen-token steps delete a seal only the kept list refuses, though a stolen key’s file verifies it',
          ]),
      ...(has(
        cleanup,
        'The drill passes over any other name in `wal/` whose signature does not verify (it names how many): a cost only',
      ) && !has(cleanup, "In `wal/`, a name whose signature does not verify is the holder's")
        ? []
        : [
            'the stolen-token steps take a WAL name whose signature does not verify for the holder’s, though a stolen key signed the backup’s own',
          ]),
      ...(has(cleanup, 'A seal a list verifies that no record of the backup names') &&
      has(
        cleanup,
        'that a key of that list signed a night the backup never ran: take that key for stolen (step 5)',
      )
        ? []
        : [
            'the stolen-token steps keep trusting the key that signed a night no record of the backup names',
          ]),
    ];
  });

/** The stolen-token steps 2 and 3 of a RUNBOOK, from step 2's title to step 4's. */
const cleanupOf = (runbook: string) =>
  cut(runbook, "2. **Check the bucket's nights**", '\n\n4. **A restore test of a named night**');

/** The stolen-token steps 2 and 3 as the fourth re-review's fixes left them (aec5f24). */
const ROUND_5_CLEANUP = [
  "2. **Check the last nights** against the backup's own lines. Each `backup <id>: …` line in the",
  "   journal names a whole night, as the backup monitor's log does, and each",
  '   `[menumesh] backup failed (exit …) at <id>: …` line a night that failed, its seal up or not:',
  '',
  '   ```sh',
  '   sudo journalctl COM_DOCKER_COMPOSE_PROJECT=menumesh COM_DOCKER_COMPOSE_SERVICE=backup --since -30d -o cat',
  '   ```',
  '',
  "   The lines shown name `daily/`'s nights and the month's copies of the months they fall in. Names",
  "   the backup never writes and floods are the token holder's, in any folder. In `daily/`, so are ids",
  '   no line names, but those stamped before these 30 days (no restore reads them, and the removal',
  "   takes them). So are the names a night's alert lists after",
  '   `someone else wrote to the bucket: monthly/ holds`, though the backup writes such names: they',
  "   were there before the night's own (Last night's backup). Take them only from that alert's line in",
  "   the journal, never from a Telegram message alone, as a leaked `.env` holds the bot's token; only",
  "   when each name carries that line's own night id, as `backup.sh` lists no other night's names",
  '   there; and only when that night, stamped in these 30 days, has no `backup <id>:` line. Left in',
  "   `monthly/`, one under a night's record name, beside that night's own seal, makes a pair that",
  '   later nights try, and five such pairs make every later night of the month copy itself again:',
  '   extra copies, a cost only. So where root may have reached the server (step 5), as root can write',
  '   the journal, take no deletion in `monthly/` from it at all.',
  '',
  "   `monthly/` keeps each month's copy 366 days and the journal its lines 180 to 187 days, so an id",
  "   there that no line shown names can still be the backup's: an older month's copy, or a night",
  '   stopped at a step of its copy, its parts and seal left there. Download its `seal-<id>.txt` and',
  '   `config-<id>.tar.age` from `monthly/` into an empty folder, as in Disaster recovery, step 2.1,',
  "   and check them on the owner's machine as in step 2.2, with the kept list's file, then, if that",
  "   refuses the seal, with the stolen key's file where there is one (step 5):",
  '',
  '   ```sh',
  "   pnpm vps:verify-night <id> <folder> --keys <the list's file>",
  '   ```',
  '',
  "   An id whose seal both refuse, `the night of <id> is not signed by the backup's key: its seal …`,",
  "   has a seal of the token holder's: delete it, or, where the bucket kept an older version of it",
  '   from before the trouble, make that one current again instead, as for a part put over its own. Its',
  '   other objects stay, a record beside it among them, which alone is no candidate: a copy stopped',
  "   before its seal leaves its parts there, and under versioning that record may be the backup's.",
  '   They cost only room until the 366-day removal, as does an id with no seal at all. A pass, or a',
  '   refusal past the seal (of the settings archive or a part), means a key of the list signed its',
  '   seal: that id stays. So only these go from `monthly/`: such seals, names the backup never writes,',
  '   floods, and the names such an alert lists. A part put over its own, in a night the journal names,',
  "   is refused by its seal, so that night can't be restored until the part is put back (the restore",
  '   test, step 4, says which part).',
  "   In `wal/`, a name whose signature does not verify is the holder's: the drill passes it over",
  '   (it names how many) and a cut chain names the file.',
  '',
  '3. **Remove what the token holder wrote**, with the admin login, off the server: lift the lock rule',
  '   of the folder that holds it, delete only those objects (planted nights, names and WAL objects,',
  '   floods), by the names step 2 found, and put the rule back as it was (29 days on `daily/`, 365 on',
  "   `monthly/`, 15 on `wal/`). The backup's own nights, month's copies and WAL stay.",
].join('\n');

/** What pitr.sh says of a base whose timeline the replay leaves before it began or ended. */
const leftEndings = (pitr: string) =>
  [...pitr.matchAll(/print "was left for a later one at " left ", (before the base \w+)"/g)].map(
    (match) => match[1],
  );

/**
 * pitr.sh refuses a base whose timeline a rewind left before the base began, and since the
 * re-review one left while it ran, before it ended (finding M1): the drill's failure lines name
 * each, as pitr.sh prints it.
 */
const baseRefusals = (runbook: string, pitr: string) => {
  const endings = leftEndings(pitr);
  return [
    ...(endings.length ? [] : ['pitr.sh refuses no base whose timeline a rewind left']),
    ...inPlaces(runbook, ['drill'], ({ drill }) =>
      endings
        .filter(
          (ending) =>
            !has(
              drill,
              `\`the base backup of <id> is of the timeline X, …, which was left for a later one at …, ${ending}\``,
            ),
        )
        .map((ending) => `the drill’s failure lines don’t name “${ending}”`),
    ),
  ];
};

/** What pitr.sh tells a recovery to a point that a cut chain stops short of, as the RUNBOOK writes it. */
const cutAdviceOf = (pitr: string) =>
  /instead="(or to latest; [^"]*\$gap[^"]*)"/.exec(pitr)?.[1].replaceAll('$gap', '<file>');

/**
 * A recovery to latest starts from the newest night, whose base may lie past the cut, where
 * PITR_ACCEPT_CUT is refused and the recovery goes through without it: the advice to take latest
 * only with PITR_ACCEPT_CUT was wrong whenever a newer night exists (Stop C's second re-review,
 * finding T1). Step 5 quotes pitr.sh's conditional advice and its refusal of the variable there.
 */
const cutAdvice = (runbook: string, pitr: string) => {
  const advice = cutAdviceOf(pitr);
  return [
    ...(advice
      ? []
      : ['pitr.sh tells a cut-short recovery nothing of what latest does at the cut']),
    ...inPlaces(runbook, ['recovery'], ({ recovery }) => [
      ...(advice && has(recovery, `\`…: recover to an earlier point, ${advice}\``)
        ? []
        : ['step 5 doesn’t quote what pitr.sh tells a recovery to a point a cut stops short of']),
      ...(has(recovery, 'PITR_ACCEPT_CUT is <file>, but the chain of WAL files is not cut')
        ? []
        : ['step 5 doesn’t say a newer night past the cut refuses PITR_ACCEPT_CUT']),
      ...(/to `latest` with `PITR_ACCEPT_CUT`, which ends at the cut/.test(flat(recovery))
        ? [
            'step 5 still sends a cut-short point to latest with PITR_ACCEPT_CUT, which a newer night refuses',
          ]
        : []),
    ]),
  ];
};

/**
 * A rewind leaves behind every night whose base ended after its point, and pitr.sh refuses each it
 * takes without passing over to the night before: taking the newest night's seal out of daily/
 * was the way past only when the rewind left that night alone (Stop C's second re-review, finding
 * T2). Step 5 takes out the seal of each night a refusal names, in turn, says when the seals go
 * back, and the drill note says a point the rewind left behind is refused after the night by hand.
 * The way past promised "that point" for a point on the stretch the rewind abandoned, which the
 * replay never reaches: it follows the rewind's timeline from the fork and stops before its first
 * transaction, at the rewind's point (Stop C's third re-review, finding F2, rehearsed by
 * vps:backup-test). And the refusals need the rewind's history file in the bucket (pitr design
 * note 1). Such a point "still ends done" whichever seals were out, though a left night's seal still
 * in, its base ended before the point, is taken and refused (Stop C's fourth re-review, recovery
 * design note 4): it ends done once every such seal is out. The point for a bad release was the
 * minute before the loss, which an owner reads off deploys.log, whose line app-deploy writes only
 * after the release's migrations and its switch (Stop C's fifth re-review, deploy design note 1):
 * it is now a time before the deploy began, from app-deploy's "deploying" line in the journal or
 * the stamp of its pre-deploy dump. Yet a release deployed again after a FAILED or ROLLED BACK
 * attempt, whose migrations stay applied, has several such lines and dumps, and a new server has
 * neither (Stop C's sixth re-review, finding N3): the point is before the first of its deploying
 * lines, of any attempt, or the dump that attempt made, or closer, before the first "running
 * migrate on" line after it (a "migrate: applied" line comes only after its file committed), and
 * on a new server 35 minutes, app-deploy's own limits on an attempt, before the first line of the
 * unpacked deploys.log naming it, or the owner's note of the day.
 */
const rewindRoute = (runbook: string) =>
  inPlaces(runbook, ['recovery', 'drill'], ({ recovery, drill }) => {
    const steps = flat(recovery);
    return [
      ...(!steps.includes('the minute just before the loss (a bad release, a deletion)') &&
      steps.includes(
        'for a bad release a time before its deploy began, as its line in `deploys.log` comes only after its migrations ran',
      ) &&
      steps.includes('`deploying <ref> to web (menumesh production)` line') &&
      steps.includes('`sudo journalctl -t app-deploy --utc -o short-iso`') &&
      steps.includes('`/srv/menumesh/predeploy/production-<stamp>-postgres.dump.age`')
        ? []
        : [
            'step 5 rewinds past a bad release to a point read off deploys.log, whose line comes after its migrations ran',
          ]),
      ...(steps.includes(
        'before the first `deploying <ref> to web (menumesh production)` line naming it',
      ) &&
      steps.includes(
        '`FAILED` and `ROLLED BACK` ones included, as the migrations an attempt ran stay applied',
      ) &&
      steps.includes('the pre-deploy dump that attempt made') &&
      !steps.includes('before its `deploying <ref> to web (menumesh production)` line')
        ? []
        : [
            'step 5 takes a bad release’s point from any of its deploying lines, though its first attempt left its migrations applied',
          ]),
      ...(steps.includes(
        'before the first `running migrate on migrate-<sha>` line after that one, as no migration runs before it',
      ) && !/before (?:its|the) harmful file's `migrate: applied/.test(steps)
        ? []
        : [
            'step 5 takes a bad release’s closest point from a line that comes after its migration committed',
          ]),
      ...(steps.includes(
        "35 minutes before the first line naming it in the `deploys.log` step 2 unpacked, as `app-deploy`'s own limits bound an attempt",
      ) && steps.includes("or as the owner's own note of the day has it")
        ? []
        : ['step 5 names no point before a bad release on a new server, without the old journal']),
      ...(steps.includes('across the fork, or to that point')
        ? ['step 5 promises the way past reaches a point on the stretch the rewind abandoned']
        : []),
      ...(steps.includes(
        "or to a point of the second kind on the rewind's timeline (after the rewind ran)",
      ) &&
      steps.includes(
        "a point on the abandoned timeline after the rewind's point, up to when the rewind ran, reaches the rewind's point at most, whichever seals are out",
      ) &&
      steps.includes("Only a night's logical recovery holds that stretch")
        ? []
        : [
            'step 5 doesn’t say a point on the stretch the rewind abandoned reaches only the rewind’s point',
          ]),
      ...(!steps.includes('It still ends `done`') &&
      steps.includes(
        'Once the seal of every left night whose base ended before that point is out, it ends `done`',
      ) &&
      steps.includes('one still in is taken and refused, as in the bullet above')
        ? []
        : [
            'step 5 says a point on the stretch the rewind abandoned ends done whichever seals are out',
          ]),
      ...(steps.includes("The refusal needs the rewind's history file in the bucket")
        ? []
        : ['step 5 doesn’t say the refusal needs the rewind’s history file in the bucket']),
      ...(steps.includes("every night whose base ended after the rewind's point is out")
        ? []
        : ['step 5 takes only the newest night out of daily/, not every night the rewind left']),
      ...(steps.includes('the seal of each night a refusal names leaves `daily/`, kept aside') &&
      steps.includes('each run takes the next older night')
        ? []
        : ['step 5 doesn’t take out the seal of each night a refusal names, kept aside, in turn']),
      ...(steps.includes('the seals go back once a night of the timeline that recovery made exists')
        ? []
        : ['step 5 doesn’t say when the seals kept aside go back']),
      ...(steps.includes("that night's seal must first leave `daily/`")
        ? ['step 5 still has the night before recover across the fork once the newest night is out']
        : []),
      ...(has(drill, 'even once that night exists')
        ? []
        : [
            'the drill doesn’t say a point the rewind left behind is refused after the night by hand',
          ]),
    ];
  });

/** The deploy of a release image no longer on the server: Production's token, no migrate reference. */
const RELEASE_BY_TOKEN = `read -rs PAT && printf '%s\\n' "$PAT" | sudo app-deploy menumesh production \\
  prod-vX.Y.Z@sha256:<digest>`;

/**
 * Step 7 deployed, after a recovery to latest or of a night, the release images.env names "with
 * its migrate image". A rollback by hand passes no migrate reference, so MIGRATE_IMAGE can still be
 * the migrate image of a release a rewind undid; and after the new-server way past the nights a
 * rewind left, the settings archive is from before the rewind, its images.env and deploys.log
 * naming the release it undid, whose migrations would run again (Stop C's third re-review, finding
 * F1, VPS-55's outcome). Step 7 deploys without a migrate reference, the release before the one a
 * rewind undid when the archive is from before it, and the way past sends the owner there. But
 * after a night's logical recovery on the same server images.env is the server's own file, which
 * names a release made since the night, whose migrations the night lacks, and no migrate run
 * brought them (Stop C's fourth re-review, finding J1): step 7 takes that night's release from the
 * last production line of deploys.log before its stamp, compares in UTC, reads a failed or
 * rolled-back line's old image as the one live, deploys with Production's token, which an image no
 * longer on the server needs, and sends the releases made since out again with their migrations.
 * Those went out in turn, oldest first, a release rolled back since among them, on a new server
 * from the VPS release runs alone (Stop C's fifth re-review, finding L2), and after a rewind past a
 * bad release every later one applied its migrations again, as each holds them (finding L1): only
 * the newest release that stayed live went out again, after a night or a rewind past a loss no
 * release caused, from images.env before step 7's deploy or the owner's note of the day, and after
 * a rewind past a bad release none did until its migration was made harmless in its own file. But
 * that split went by the kind of recovery, not by the state it brought back: a night from before a
 * bad release, step 5's fallback after a refused point or a theft, sent its migration out again
 * with the newest release (Stop C's sixth re-review, finding N1); step 5 let a release made since
 * go out once the file was edited, though its image holds the original (N2); with no release since,
 * step 7's own went out again, which migrate.sh refuses where the database holds a rolled-back
 * release's versions (N4); and `latest` that ended at a cut took images.env's release, though one
 * made after the cut's last transaction lacks its migrations there (N5). Step 7 now goes by the
 * recovered state, in order: the release live at its last transaction, from images.env only after
 * `latest` on the same server with no cut, else from deploys.log; from before a bad release's
 * deploy, whatever the kind of recovery, no release made since that deploy ever goes out, and one
 * from main only once the harmful file is harmless; else the newest release that went live since
 * and stayed live, with its migrate reference, one older than step 1's without it, and if none did,
 * nothing more. Step 5 and Database migrations say the same.
 */
const releaseDeployed = (runbook: string) =>
  inPlaces(runbook, ['release', 'recovery', 'migrations'], ({ release, recovery, migrations }) => [
    ...(has(release, "that is the release `images.env`'s `WEB_IMAGE` names") &&
    has(release, 'since a rollback by hand passes no migrate reference')
      ? []
      : [
          'step 7 deploys the release `images.env` names with the migrate image `images.env` names',
        ]),
    ...(has(release, 'with its migrate image')
      ? ['step 7 still deploys a release with its migrate image after a recovery']
      : []),
    ...(!has(release, "or of a night, that is the release `images.env`'s `WEB_IMAGE` names") &&
    has(release, "`images.env` is the server's own file") &&
    has(release, "the last production line of `deploys.log` before the night's stamp")
      ? []
      : [
          'step 7 deploys, after a night recovered on the same server, the release `images.env` names, one made since the night',
        ]),
    ...(has(
      release,
      "the release `WEB_IMAGE` names in the `images.env` that step 2 unpacked from that night's own settings archive",
    )
      ? []
      : [
          'step 7 doesn’t take a new server’s night’s release from that night’s own settings archive',
        ]),
    ...(has(release, 'Its lines are in UTC') &&
    has(release, 'or with the point in UTC, as `pitr.sh` prints it')
      ? []
      : ['step 7 compares the lines of `deploys.log` with a time that may not be in UTC']),
    ...(has(
      release,
      'A line with `FAILED` or `ROLLED BACK` after its two images never left the new one live',
    )
      ? []
      : ['step 7 takes the new image of a failed or rolled-back deploy for the one live']),
    ...(has(release, `${RELEASE_BY_TOKEN}\n\`\`\``) && has(release, 'but not its migrate reference')
      ? []
      : [
          'step 7 deploys a release image no longer on the server without the token app-deploy needs to pull it',
        ]),
    ...(/migrate-<sha>/.test(release) ? ['step 7 deploys a release with a migrate reference'] : []),
    ...(has(release, "Production's release follows from the recovered state") &&
    has(release, "the one live at the recovered state's last transaction")
      ? []
      : ['step 7 takes the release by the kind of recovery, not by the state it brought back']),
    ...(has(release, 'unless it ended at a cut (`PITR_ACCEPT_CUT`)')
      ? []
      : [
          'step 7 takes, after `latest` that ended at a cut, the release `images.env` names, though one made after the cut’s last transaction lacks its migrations',
        ]),
    ...(has(release, 'never left the new one live: the release is its old one')
      ? []
      : ['step 7 doesn’t say which release a failed or rolled-back line leaves live']),
    ...(has(
      release,
      "if a release went live since the recovered state's time and stayed live, the newest of them goes out again by Production, step 2, with its own migrate reference",
    ) && has(release, 'its migrate run applies every migration the recovered database lacks')
      ? []
      : ['step 7 leaves the releases made since the point recovered to undeployed']),
    ...(has(release, 'the newest release that stayed live since then goes out again')
      ? [
          'step 7 sends the newest release out again whether or not one went live since, step 7’s own among them',
        ]
      : []),
    ...(has(release, "If none did, or it is step 1's own, step 1's deploy is all")
      ? []
      : [
          'step 7 sends its own release out again with its migrate reference when none went live since, which migrate.sh refuses where the database holds a rolled-back release’s versions',
        ]),
    ...(has(
      release,
      "One older than step 1's, as after a rollback by hand since, goes out as step 1's did instead, without a migrate reference",
    )
      ? []
      : [
          'step 7 sends a release rolled back to since out again with its migrate reference, which migrate.sh refuses where the database holds the newer one’s versions',
        ]),
    ...(has(release, "On the same server that is the release `images.env`'s `WEB_IMAGE` named") &&
    has(release, "`WEB_IMAGE` named before step 7's deploy") &&
    has(release, 'that is neither `FAILED` nor `ROLLED BACK`') &&
    has(release, "on a new server, the owner's own note of the day, never the **VPS release** runs")
      ? []
      : [
          'step 7 sends out again a release rolled back since, or takes the releases since from the VPS release runs alone',
        ]),
    ...(has(release, 'in turn, oldest first')
      ? ['step 7 sends out again every release made since, a rolled-back one among them']
      : []),
    ...(has(release, "where the recovered state is from before a bad release's deploy began") &&
    has(release, 'a rewind past it, a night from before it, or `latest` that ended at a cut') &&
    has(
      release,
      "no release made since that deploy began goes out again, ever, as each holds that release's migrations",
    ) &&
    has(
      release,
      'until the harmful migration is made harmless in its own file, under its own version',
    ) &&
    has(release, "Never delete the file: hosted staging's history holds that version")
      ? []
      : [
          'step 7 sends out, after a recovery to a state from before a bad release, a later release that applies its migrations again',
        ]),
    ...(has(release, 'After a night, or a rewind past a loss no release caused')
      ? [
          'step 7 sends the newest release out again after any night, though a night from before a bad release lacks its migration',
        ]
      : []),
    ...(has(release, 'never the release a rewind undid') &&
    !has(release, "where the recovered state is from before a bad release's deploy began")
      ? [
          'step 7 keeps out only the release a rewind undid, though every later one holds its migrations',
        ]
      : []),
    ...(has(
      recovery,
      "After a recovery to a state from before a bad release's deploy, a rewind past it or a night from before it",
    ) &&
    has(
      recovery,
      'no release made since that deploy began goes out again, ever, and one built from `main` only once its harmful migration is made harmless in its own file (step 7)',
    ) &&
    has(
      migrations,
      'but after a recovery past a bad release on the shared server, a rewind or a night from before it',
    ) &&
    has(migrations, 'make its harmful migration harmless in its own file instead')
      ? []
      : [
          'step 5 or Database migrations lets a release go out after a recovery past a bad release before its migration is made harmless',
        ]),
    ...(has(recovery, 'goes out again until its harmful migration')
      ? [
          'step 5 lets a release made since a bad release go out once its migration is edited, though its image holds the original',
        ]
      : []),
    ...(has(
      release,
      'So too when a rewind past a release came after the night whose settings archive',
    ) &&
    has(
      release,
      "the last production line of the archive's `deploys.log` before the rewind's point",
    )
      ? []
      : [
          'step 7 deploys the release a rewind undid after a recovery from a settings archive made before the rewind',
        ]),
    ...(has(recovery, 'see step 7 for the release to deploy')
      ? []
      : ['the way past the nights a rewind left doesn’t send the owner to step 7 for the release']),
  ]);

/** Disaster recovery's step 7 as the fifth re-review's fixes left it (fc63419). */
const ROUND_6_RELEASE = [
  '',
  "  7. Production's image, by the admin form, and staging's; then",
  "     `sudo app-compose menumesh up -d scheduler scheduler-staging`. Production's is the image that",
  '     was live at the point recovered to, deployed without a migrate reference, as the database',
  "     already holds its migrations. After a recovery to `latest`, that is the release `images.env`'s",
  '     `WEB_IMAGE` names, never with the image its `MIGRATE_IMAGE` names, which can still be that of a',
  '     release a rewind undid, since a rollback by hand passes no migrate reference: its migrate run',
  "     would apply that release's migrations again. After a night's logical recovery on a new server,",
  "     it is the release `WEB_IMAGE` names in the `images.env` that step 2 unpacked from that night's",
  "     own settings archive. After one on the same server (step 5's fallback, as after a point more",
  '     than 14 days back or a refused point-in-time recovery, or A stolen or leaked bucket token',
  "     (VPS), step 5), `images.env` is the server's own file, which names any release made since the",
  "     night, whose migrations the night lacks: production's is the release live at the night, the",
  "     last production line of `deploys.log` before the night's stamp. After a rewind to a point",
  '     before a release, such as the bad release it undid, it is the release before it, the last',
  '     production line of `deploys.log` before that point, and never the entry of `images.env` that',
  '     the rewind undid: that file still names the release, whose migrate run would apply its',
  '     migrations again and switch `web` back to it. So too when a rewind past a release came after',
  '     the night whose settings archive step 2 unpacked, as on a new server that took the way past the',
  "     nights a rewind left (step 5): that archive's `images.env` and `deploys.log` still name the",
  "     release the rewind undid, so production's is the release before it, the last production line of",
  "     the archive's `deploys.log` before the rewind's point.",
  '',
  '     `deploys.log` is `/srv/menumesh/deploys.log`, on a new server the one step 2 unpacked, and',
  "     no script cuts it, so it still names an old night's release. Its lines are in UTC, each image",
  '     as `<tag>@sha256:<digest>`: `2026-12-17T04:30:12Z production web <old> -> <new> by ops`.',
  "     Compare them with the night's stamp, or with the point in UTC, as `pitr.sh` prints it in",
  '     brackets after a point given with an offset. A line with `FAILED` or `ROLLED BACK` after its',
  '     two images never left the new one live: the release is its old one. An image no longer on',
  '     the server, as on any new server or two releases back on the same one, needs the token of',
  '     Production, step 2 (Deploys on the VPS), but not its migrate reference: without a token',
  "     `app-deploy` stops at `couldn't pull …` and switches nothing.",
  '',
  '     ```sh',
  '     read -rs PAT && printf \'%s\\n\' "$PAT" | sudo app-deploy menumesh production \\',
  '       prod-vX.Y.Z@sha256:<digest>',
  '     ```',
  '',
  '     After a night, or a rewind past a loss no release caused (a deletion), the newest release that',
  '     stayed live since then goes out again by Production, step 2, with its own migrate reference,',
  '     the one its **VPS release** run printed: its migrate run applies every migration the recovered',
  "     database lacks. On the same server that is the release `images.env`'s `WEB_IMAGE` named before",
  "     step 7's deploy, the new image of the last production line of `deploys.log` before it that is",
  "     neither `FAILED` nor `ROLLED BACK`; on a new server, the owner's own note of the day, never the",
  '     **VPS release** runs alone, which list each release built, not whether it stayed live. After a',
  '     rewind past a bad release, no release made since the point goes out, as each holds that',
  "     release's migrations, and neither does any release built from `main` until the harmful",
  '     migration is made harmless in its own file, under its own version (Database migrations). Never',
  "     delete the file: hosted staging's history holds that version, and `migrate.sh` refuses a",
  '     database with a version its image lacks (exit 2).',
  '',
].join('\n');

/** Phrases the rules read, each wrapped at its first space as a reformat might wrap it. */
const REWRAPPED = [
  'password manager',
  'marked stolen',
  'never a ping received since',
  'two nights running',
  'night after night',
  'even once that night exists',
  'records made before the trouble could have begun',
  'the seals go back once a night of the timeline that recovery made exists',
  'never by a point-in-time recovery from',
  // Matched with their spaces spelled out until Stop C's third re-review (finding G4).
  'file of its own',
  "never in the age key's file",
  'never inside `menumesh-backup-key.txt`',
  'Disaster recovery, step 4',
  'Disaster recovery,',
  // Read by the rules of that re-review.
  'leaked every value in it',
  'on the rebuilt server only',
  'counts as stolen too',
  "reaches the rewind's point at most",
  'see step 7 for the release',
  'a rollback by hand passes no migrate reference',
  'or an older key that may have leaked',
  'sealed and then failed at the end',
  'its keys out of order',
  // Read by the rules of the fourth re-review.
  "before the night's stamp",
  'Its lines are in UTC',
  'never left the new one live',
  'but not its migrate reference',
  'as does an id with no seal at all',
  'one still in is taken and refused',
  // Read with has() by the earlier rules, but never wrapped here until that re-review (theft design
  // note 2).
  'its first key mistyped',
  'A mistyped later key passes this check',
  'seal: openssl could not sign probe',
  "the month's copy is <id>",
  "kept in monthly/ as the month's copy",
  // Read with has() by the earlier rules and wrapped nowhere above (the fifth re-review's item on
  // the re-wrap test): a piece of each that stands on one line, so the phrase is wrapped with it.
  "<folder> --keys <the stolen key's file>",
  'night takes the same two `-e`',
  'the list whose private half had left the server',
  'never the stolen key',
  '<each older key that may have leaked>`',
  'holds the new key first, then only the older keys',
  'the trouble could have begun stays',
  "the list still holds recorded this month's copy",
  'One that an older key of the kept list signed is recovered',
  'one that an older key of the kept list signed is recovered',
  "copy the backup monitor's log off it",
  'an id that no record from before names',
  "Hosted staging's pooler login (`STAGING_DB_*`)",
  'nothing it made after the trouble could have begun',
  'fresh signing pair',
  "goes into no list and not into the stolen key's file",
  'may be taken by a point-in-time recovery',
  'outlives the rebuild (sub-step 5) goes on it',
  'new backup pair, made before this recovery began',
  "settings archive's timer and `backup` start",
  "older key leaves the kept list for the stolen key's file",
  'needs both private keys in `identity.txt`',
  "<folder> --keys <the list's file>",
  'but the chain of WAL files is not cut',
  "that is the release `images.env`'s",
  "`images.env` is the server's own file",
  'the release `WEB_IMAGE` names in the `images.env` that',
  'or with the point in UTC, as `pitr.sh` prints it',
  'So too when a rewind past a release',
  "the archive's `deploys.log` before the rewind's",
  // Read by the rules of the fifth re-review, with has() or from folded text.
  'its new pair is made before this step',
  'lift no lock while a token that server',
  "waits for sub-step 5's rebuild",
  'where root may have reached the server, only after',
  "goes new once more, into the rebuilt server's",
  "step 1's token is revoked before",
  'only keeps the night it names, and never condemns one',
  'nothing goes because no line names it',
  'is judged by its seal alone',
  'line a night that failed',
  "Its record and parts stay, as they may be the backup's",
  'byte for byte and never from a text preview',
  "seal's size is the one the bucket lists",
  '`its seal (seal-<id>.txt) is signed by none of',
  "stolen key's file kept (one for each theft",
  'older version of it that a list verifies',
  'only a version from before the trouble',
  'means a key of a list signed its seal',
  "The backup's own nights, month's copies and WAL stay",
  'bucket holds names the backup never writes',
  'becomes the newest backup public key here',
  'first check that it is that same key',
  'or the admin puts that key in the conf',
  'comes only after its migrations ran',
  '`deploying <ref> to web (menumesh production)`',
  '`sudo journalctl -t app-deploy --utc -o short-iso`',
  'every migration the recovered database lacks',
  'that is neither `FAILED` nor',
  "the owner's own note of the day",
  'made harmless in its own file, under its own version',
  "delete the file: hosted staging's history holds that version",
  'harmless in its own file instead',
  // Read by the rules of the sixth re-review, with has() or from folded text: step 7 by the
  // recovered state, step 5's point and pointer, Database migrations.
  "Production's release follows",
  "the one live at the recovered state's last transaction",
  'unless it ended at a cut',
  "if a release went live since the recovered state's",
  "If none did, or it is step 1's own, step 1's deploy is all",
  "One older than step 1's, as after a rollback by hand since",
  "`WEB_IMAGE` named before step 7's deploy",
  'where the recovered state is from before a bad',
  'a rewind past it, a night from before it, or `latest` that',
  'no release made since that deploy began goes out again, ever,',
  'After a recovery to a state from before a bad',
  'release made since that deploy began goes out again, ever, and one built',
  'release on the shared server, a rewind or a night from before it',
  'before the first `deploying',
  'ones included, as the migrations an attempt ran stay applied',
  'the pre-deploy dump that attempt made',
  'the first `running migrate on migrate-<sha>` line after that one',
  '35 minutes before the first line naming it in the `deploys.log` step 2 unpacked',
  'note of the day has it',
  // The signs of theft and step 2's stolen key.
  "a night that none of the backup's own records names",
  '`restore: not taking the night of <id>, stamped later than now`',
  "`pitr: not taking the night of <id>: its seal …, so it is not the backup's`",
  "`<n> objects passed over, not the backup's`, n above 0",
  'A seal a list verifies that no record of the backup names',
  'that a key of that list signed a night the backup never ran',
  // The versions put back, the clauses that keep the backup's own, and the bucket judged again.
  "list each folder's versions too",
  'a name with more than one version, or a delete marker',
  'whether or not a line keeps its night',
  'A line only keeps an id from going, never a version',
  'Only a seal that every list refuses',
  'other name in `wal/` whose signature does not verify (it names how many): a cost only',
  "once step 1's token is revoked and the only token that can write",
  "first, its versions among them, as root could write with step 1's token until then",
  'step 2 done again, its versions among them, and only then does step 3 lift a lock',
  'and it gets no token',
];

describe('the RUNBOOK’s VPS steps that no script runs', () => {
  it('makes a settings archive right before each backup.sh it runs by hand (Stop C’s re-review, finding V3)', () => {
    expect(byHandRuns(RUNBOOK).length).toBeGreaterThanOrEqual(5);
    expect(archiveFirst(RUNBOOK)).toEqual([]);
    // As before the re-review: Last night's backup ran it inline, with no archive.
    refuses(
      archiveFirst,
      swap(
        RUNBOOK,
        '  whole night. One now, as the container runs it, with a settings archive made for it first: a',
        `  whole night. One now, as the container runs it: \`${BY_HAND}\`.\n  Nothing else: a`,
      ),
      'runs backup.sh by hand outside a command block of its own',
    );
    // Disaster recovery's step 9 without the archive's start.
    refuses(
      archiveFirst,
      swap(
        RUNBOOK,
        `     ${ARCHIVE}\n     ${BY_HAND}\n     \`\`\`\n\n     Then a restore test`,
        `     ${BY_HAND}\n     \`\`\`\n\n     Then a restore test`,
      ),
      'runs backup.sh by hand with no settings archive made before it',
    );
    // As before the re-review: the drill's note after a rewind named backup.sh, no command.
    refuses(
      archiveFirst,
      swap(
        RUNBOOK,
        `  hand before the next drill:\n\n  \`\`\`sh\n  ${ARCHIVE}\n  ${BY_HAND}\n  \`\`\`\n`,
        '  hand before the next drill.\n',
      ),
      'drill runs no backup.sh by hand after a settings archive',
    );
    // As before the re-review: the WAL alert's new spool named backup.sh, no command.
    refuses(
      archiveFirst,
      swap(
        RUNBOOK,
        `  night's backup):\n\n  \`\`\`sh\n  ${ARCHIVE}\n  ${BY_HAND}\n  \`\`\`\n`,
        "  night's backup).\n",
      ),
      'walAlerts runs no backup.sh by hand after a settings archive',
    );
    // As before the re-review: the theft's night by hand without an archive.
    refuses(
      archiveFirst,
      swap(
        RUNBOOK,
        `      ${ARCHIVE}\n      sudo journalctl -t app-config-archive`,
        '      sudo journalctl -t app-config-archive',
      ),
      'runs backup.sh by hand with no settings archive made before it',
    );
    // A run that names backup.sh without its path, in a block with no archive, and one inline:
    // the rule saw neither before its second re-review (theft-docs design note 2).
    refuses(
      archiveFirst,
      swap(
        RUNBOOK,
        '  sudo app-compose menumesh --profile restore-test rm -sf restore-db\n',
        '  sudo app-compose menumesh --profile restore-test rm -sf restore-db\n  sudo app-compose menumesh run --rm --no-deps -T backup backup.sh\n',
      ),
      'runs backup.sh by hand, but not as',
    );
    refuses(
      archiveFirst,
      swap(
        RUNBOOK,
        '  Then run the restore test and the point-in-time drill, since both read the list.',
        '  Then run `sudo app-compose menumesh exec backup\n  backup.sh` and the drill, since both read the list.',
      ),
      'runs backup.sh by hand outside a command block of its own',
    );
    refuses(
      archiveFirst,
      swap(RUNBOOK, `        ${TIMER}\n`, ''),
      'disaster recovery never enables the settings archive’s timer',
    );
    refuses(
      archiveFirst,
      swap(RUNBOOK, '- **WAL alerts**', '- **WAL**'),
      'the RUNBOOK has no walAlerts',
    );
  });

  it('puts the signing key of the kept list’s first key in and checks the pair with the backup’s own check (finding V2)', () => {
    expect(PAIR_SIGNS).toMatch(/^signing pair: /);
    expect(pairChecked(RUNBOOK)).toEqual([]);
    // As before the re-review: step 2.4 named the list alone.
    refuses(
      pairChecked,
      swap(
        RUNBOOK,
        "        kept list's first key, from the password manager (Secrets (VPS), Rotation). Never keep a\n",
        "        kept list's first key. Never keep a\n",
      ),
      'step 2.4 doesn’t put in BACKUP_SIGNING_KEY’s private half from the password manager',
    );
    // The check with a word of its own, or none at all.
    refuses(
      pairChecked,
      swap(RUNBOOK, `     ${PAIR_COMMAND}\n`, `     ${PAIR_COMMAND.replace('exit 1', 'exit 0')}\n`),
      'step 4 doesn’t check the signing pair with SIGNING_PAIR_CHECK as it is',
    );
    refuses(
      pairChecked,
      swap(RUNBOOK, `     \`${PAIR_SIGNS}\`.\n`, '     its line.\n'),
      'step 4 doesn’t say what the signing pair’s check prints for a pair',
    );
    refuses(
      pairChecked,
      swap(
        RUNBOOK,
        '  checks it against the first. The new private key also goes into the password manager, in the old\n',
        '  checks it against the first. The new private key also goes into the vault, in the old\n',
      ),
      'Rotation doesn’t keep the new private key in the password manager and check the pair',
    );
    // Rotation's sentence wrapped again inside the name of the step it cites (finding G4).
    expect(
      pairChecked(
        swap(
          RUNBOOK,
          'Check the pair with the one-off of Disaster recovery,\n  step 4,',
          'Check the pair with the one-off of Disaster\n  recovery, step 4,',
        ),
      ),
    ).toEqual([]);
    // As before the third re-review: the pair's refusal glossed as another pair's key alone.
    expect(SEAL).toContain('echo "seal: openssl could not sign ${1##*/}"');
    expect(SEAL).toContain('"$seal_probe_dir/probe"');
    const gloss = swap(
      RUNBOOK,
      cut(
        RUNBOOK,
        '       a private key of another pair, such as one from before a rotation',
        '\n\n  5. The recovery',
      ),
      '       a private key of another pair, such as one from before a rotation.',
    );
    refuses(
      pairChecked,
      gloss,
      'step 4 blames the private key alone for a list shaped as keys but not the kept one',
    );
    refuses(
      pairChecked,
      gloss,
      'step 4 promises one line where a private key openssl can’t load prints more',
    );
  });

  it('names each signing value that is no key, as the pair check, the night and the shipper do (finding U4)', () => {
    expect(PAIR_LINES).toHaveLength(4);
    expect(PAIR_LINES.filter((line) => line.startsWith(`signing pair: ${NO_LIST}, `))).toHaveLength(
      1,
    );
    expect(PAIR_LINES.filter((line) => line.startsWith(`signing pair: ${NO_KEY}, `))).toHaveLength(
      1,
    );
    expect(valuesNamed(RUNBOOK, BACKUP, SHIPPER)).toEqual([]);
    // As before the second re-review: step 4 named one remedy for every refusal.
    const named = (text: string) => valuesNamed(text, BACKUP, SHIPPER);
    const refusals = cut(
      RUNBOOK,
      '     Anything else is one line on stderr',
      '\n\n  5. The recovery',
    );
    const before = swap(
      RUNBOOK,
      refusals,
      "     Anything else, exit 1, means the pair in `.env` is not one: put in the private half of the\n     kept list's first key (step 2.4) and run it again. Nothing has been signed yet.",
    );
    for (const line of PAIR_LINES.slice(0, 2))
      refuses(named, before, `doesn’t quote the pair check’s “${line}”`);
    // As before it: the night's alerts quoted the pair's line alone, and the WAL alerts none.
    refuses(
      named,
      swap(
        RUNBOOK,
        '  `select slot_name, slot_type, temporary, active from pg_replication_slots`, and free one);\n  `BACKUP_SIGNING_PUBLIC_KEY is not one Ed25519 public key or several, …`,\n  `BACKUP_SIGNING_KEY is not an Ed25519 private key, …` or\n',
        '  `select slot_name, slot_type, temporary, active from pg_replication_slots`, and free one);\n',
      ),
      `lastNight doesn’t quote “${NO_LIST}, …”`,
    );
    refuses(
      named,
      swap(
        RUNBOOK,
        '  new server, before `db` exists, it is expected); a variable not set;\n  `BACKUP_SIGNING_PUBLIC_KEY is not one Ed25519 public key or several, …`,\n  `BACKUP_SIGNING_KEY is not an Ed25519 private key, …` or\n',
        '  new server, before `db` exists, it is expected); a variable not set;\n',
      ),
      `walAlerts doesn’t quote “${NO_KEY}, …”`,
    );
    // The scripts as they were: no line of their own for either value.
    refuses(
      (text) => valuesNamed(RUNBOOK, BACKUP, text),
      SHIPPER.replace(`halted "${NO_LIST}, `, 'halted "a list, '),
      `wal-ship.sh no longer says “${NO_LIST}”`,
    );
  });

  it('takes a night from before a theft of the signing key with the stolen key’s file, kept apart (finding V1)', () => {
    expect(theftNight(RUNBOOK)).toEqual([]);
    // As before the re-review: step 2 had no theft case, the kept list alone.
    const before = swap(
      swap(
        RUNBOOK,
        cut(RUNBOOK, '        After a theft of the signing key', '     3. **Unpack**'),
        '',
      ),
      cut(RUNBOOK, ' For a night from before a theft of the signing key (2.2),', ' Both come from'),
      '',
    );
    refuses(
      theftNight,
      before,
      'step 2.2 doesn’t check a night from before a theft with the stolen key’s file',
    );
    refuses(
      theftNight,
      before,
      'step 2 doesn’t make the night’s versions of before the trouble current first',
    );
    refuses(theftNight, before, 'after a reach as root');
    refuses(
      theftNight,
      swap(RUNBOOK, 'of their own marked stolen, never', 'of their own, never'),
      'the theft’s step 5 doesn’t keep the stolen key apart',
    );
  });

  it('makes a night’s versions of before a theft current before it is downloaded or recovered (finding U1)', () => {
    expect(theftOrder(RUNBOOK)).toEqual([]);
    // As before the second re-review: 2.2 made them current after 2.1 had downloaded the night.
    const sentence = cut(
      RUNBOOK,
      ' For a night from before a theft of the signing key (2.2),',
      ' Both come from',
    );
    refuses(
      theftOrder,
      swap(
        swap(RUNBOOK, sentence, ''),
        'and check it with the stolen key',
        `${flat(sentence).trim()} Then check it with the stolen key`,
      ),
      'disaster recovery downloads a night from before a theft before its versions of then are current',
    );
    // As before it: the theft's step 5 said so after its recover command and restore test.
    const versions = cut(
      RUNBOOK,
      ' Where the bucket keeps versions, make the versions of that night',
      ' Then\n',
    );
    refuses(
      theftOrder,
      swap(
        swap(RUNBOOK, versions, ''),
        'Its restore test, in step 4, takes the same two `-e`.',
        `Its restore test, in step 4, takes the same two \`-e\`.${versions}`,
      ),
      'the theft’s step 5 recovers the night from before the trouble before its versions of then are current',
    );
  });

  it('gives the logical recovery of a night from before a theft the stolen key’s list for that one run (finding U2)', () => {
    expect(oneRunKey(RUNBOOK)).toEqual([]);
    // As before the second re-review: the fallback ran with .env's list, and 2.2 checked once.
    refuses(
      oneRunKey,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          '     A night from before a theft of the signing key (step 2.2)',
          '     It refuses while `db` runs',
        ),
        '',
      ),
      'step 5’s fallback gives a night from before a theft no key for that one run',
    );
    refuses(
      oneRunKey,
      swap(RUNBOOK, 'and check it with the stolen key', 'and check it once with the stolen key'),
      'step 2.2 checks the night from before the trouble once',
    );
    refuses(
      oneRunKey,
      swap(
        RUNBOOK,
        `\n      ${STOLEN_RECOVER}`,
        '\n      sudo app-compose menumesh --profile recover run --rm -e RESTORE_STAMP=<id> -e BACKUP_SIGNING_PUBLIC_KEY=<the old public key> -v /run/age:/run/age:ro recover',
      ),
      'the theft’s step 5 doesn’t give the stolen key’s file’s list, quoted, for that one run',
    );
  });

  it('keeps the older keys that never leaked after the new one when the signing key is stolen (finding U3)', () => {
    expect(theftList(RUNBOOK)).toEqual([]);
    // As before the second re-review: the new public key alone, and the stolen key alone apart.
    refuses(
      theftList,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          '`BACKUP_SIGNING_PUBLIC_KEY` the new public key first',
          ' The same line takes',
        ),
        '`BACKUP_SIGNING_PUBLIC_KEY` the new public key alone.',
      ),
      'the new list holds the new key alone',
    );
    refuses(
      theftList,
      swap(
        RUNBOOK,
        '`BACKUP_SIGNING_PUBLIC_KEY=<the stolen key> <each older key that may have leaked>`',
        '`BACKUP_SIGNING_PUBLIC_KEY=<the old public key>`',
      ),
      'the theft’s step 5 doesn’t keep an older key that may have leaked apart with the stolen one',
    );
    refuses(
      theftList,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          'list holds the new key first, then only the older keys',
          ': it takes the nights',
        ),
        'list holds the new key alone',
      ),
      'step 2.2 doesn’t say the kept list holds the new key first',
    );
    // As before the third re-review (finding G3): the night by hand the month's copy again, and
    // a night an older key of the kept list signed checked and recovered with the stolen key's file.
    refuses(
      theftList,
      swap(
        RUNBOOK,
        cut(RUNBOOK, ' No\n      copy the stolen key recorded counts', ' A point-in-time recovery'),
        [
          ' The',
          "      night prints `backup <id>: kept in monthly/ as the month's copy`, then",
          "      `backup <id>: 6 parts, <n> bytes, kept in monthly/ as the month's copy`: no copy the stolen",
          '      key recorded counts once it is out of the list, so the first night of the new key is the',
          "      month's copy again.",
        ].join('\n'),
      ),
      'the theft’s night by hand makes the month’s copy again where an older key of the list recorded it',
    );
    refuses(
      theftList,
      swap(
        RUNBOOK,
        cut(RUNBOOK, '        That file is for a night the stolen key', "That archive's `.env`"),
        '        ',
      ),
      'step 2.2 checks a night an older key of the kept list signed with the stolen key’s file',
    );
    refuses(
      theftList,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          '\n     One that an older key of the kept list signed',
          '\n\n     It refuses while',
        ),
        '',
      ),
      'step 5’s fallback recovers a night an older key of the kept list signed with the stolen key’s file',
    );
    refuses(
      theftList,
      swap(
        RUNBOOK,
        cut(RUNBOOK, ' That file is for such nights alone:', ' Where root\n      may have reached'),
        '',
      ),
      'the theft’s step 5 recovers a night an older key of the kept list signed with the stolen key’s file',
    );
  });

  it('names a night from before a leaked .env only from records made before it, with the backup’s records made new (finding U5)', () => {
    expect(theftRecords(RUNBOOK)).toEqual([]);
    // As before the second re-review: only the bucket's token and the signing key went new.
    const records = cut(
      RUNBOOK,
      "   2. **The backup's records.**",
      '\n\n   3. **A night of the new key**',
    );
    const noRecords = swap(
      RUNBOOK,
      records,
      '   2. **The pair.** Check the pair (Disaster\n      recovery, step 4, its one-off), then `up -d backup`.',
    );
    refuses(theftRecords, noRecords, 'doesn’t make HEARTBEAT_BACKUP_URL new');
    refuses(theftRecords, noRecords, 'doesn’t make HEARTBEAT_WAL_URL new');
    refuses(theftRecords, noRecords, 'doesn’t make the Telegram bot’s token new');
    refuses(theftRecords, noRecords, 'doesn’t keep the monitor’s log');
    // As before it: the night was named by the monitor's log, whatever its time.
    refuses(
      theftRecords,
      swap(
        RUNBOOK,
        cut(RUNBOOK, ' Name it only from', ' Where the bucket keeps versions, make'),
        " Name it from the backup monitor's log (or the journal, from before the trouble).",
      ),
      'names the night from before the trouble from records a thief could make',
    );
    refuses(
      theftRecords,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          ' After a theft of\n     the signing key, a night from before',
          ' Its `<id>` names',
        ),
        '',
      ),
      'disaster recovery’s step 2 names a night from before a theft from any record',
    );
  });

  it('makes every value of a leaked .env new, not only the backup’s (finding G2)', () => {
    expect(envLeaked(RUNBOOK)).toEqual([]);
    // As before the third re-review: the backup's values alone, and no step for the pooler login.
    const before = swap(
      swap(
        swap(
          RUNBOOK,
          cut(RUNBOOK, ' And the leaked `.env` leaked every value in it', ' Where root may have'),
          '',
        ),
        cut(
          RUNBOOK,
          ': A stolen or leaked bucket token (VPS). A leaked `.env`',
          '\n- The backup key:',
        ),
        ", after which the backup's heartbeat addresses and the bot's token go new with it:\n  A stolen or leaked bucket token (VPS).",
      ),
      cut(RUNBOOK, "- Hosted staging's pooler login", "- The bucket's token"),
      '',
    );
    refuses(
      envLeaked,
      before,
      'the theft’s step 5 doesn’t say a leaked .env leaked every value in it',
    );
    refuses(
      envLeaked,
      before,
      'the theft’s step 5 leaves both cron secrets of a leaked .env as it was',
    );
    refuses(
      envLeaked,
      before,
      'Rotation’s bullet for the bucket’s token doesn’t say a leaked .env leaked every value in it',
    );
    refuses(
      envLeaked,
      before,
      'Rotation’s bullet for the bucket’s token leaves `POSTGRES_PASSWORD` of a leaked .env as it was',
    );
    refuses(envLeaked, before, 'Rotation has no step for hosted staging’s pooler login');
    // One value left out of the theft's list.
    refuses(
      envLeaked,
      swap(RUNBOOK, 'secrets,\n   the schedulers', 'secrets,\n   the'),
      "the theft’s step 5 leaves the schedulers' heartbeat addresses of a leaked .env as it was",
    );
    // Sub-step 1 renamed: the lead-in is missing, never the whole step, whose sub-steps would pass
    // for it (Stop C's fourth re-review, theft design note 3).
    const renamed = swap(RUNBOOK, '1. **The signing key**', '1. **The key that signs**');
    refuses(envLeaked, renamed, 'the theft’s step 5 has no sub-step 1');
    refuses(envLeaked, renamed, 'the theft’s step 5 doesn’t say a leaked .env leaked every value');
  });

  it('rebuilds a server that may have been reached as root and takes none of its nights (finding N1)', () => {
    expect(rootReach(RUNBOOK)).toEqual([]);
    // As before the second re-review: the theft's step 5 had no case of a reach as root.
    refuses(
      rootReach,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          '\n\n   5. **If root may have reached the server**',
          '\n\n### Logs and alerts (VPS)',
        ),
        '',
      ),
      'the theft’s step 5 lets a point-in-time recovery start from the reached server’s nights',
    );
    refuses(
      rootReach,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          'it has no night to start from until the new key\n     signs one',
          '\n\n     The volumes of a new server',
        ),
        'it has no night to start from until the new key\n     signs one (A stolen or leaked bucket token (VPS), step 5): recover a night logically instead.',
      ),
      'disaster recovery’s first choice may start from a night of a server reached as root',
    );
    refuses(
      rootReach,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          'nothing it made\n        after the trouble could have begun is taken',
          ': take the last night',
        ),
        'that archive holds whatever the server held by then',
      ),
      'step 2.2 distrusts only the archive of a night a server reached as root made',
    );
    // As before the third re-review (docs design note 6): none of its nights at all, which
    // forbade the logical recovery the same sentence sends the owner to.
    refuses(
      rootReach,
      swap(
        RUNBOOK,
        "nights may be taken by a point-in-time recovery, the new key's included",
        "nights may be taken, the new key's included",
      ),
      'disaster recovery’s first choice may start from a night of a server reached as root',
    );
  });

  it('puts no private key on a server root may still hold, and counts its backup key stolen once it was there (finding G1)', () => {
    expect(rootKeys(RUNBOOK)).toEqual([]);
    // As before the third re-review: the tests on the reached server, and the backup key and the
    // older signing keys kept.
    const sentences: [string, string][] = [
      [' Where root may have reached the server\n   (step 5)', '\n\n5. **If the server itself'],
      [' Where root\n  may have reached the server, they run', "\n- Staging's password"],
      [' Where root may have reached the server, no private key', ' So, with the token and'],
      [' Where root\n      may have reached the server, this recovery', '\n\n   5. **If root may'],
      ['\n      (none when the backup key counts as stolen too, below)', ', without the key'],
      ["\n\n      If the backup key's private half was on", '\n\n### Logs and alerts'],
      [" If the backup key's private half was on that server since", '\n\n     3. **Unpack**'],
    ];
    const before = sentences.reduce(
      (text, [from, to]) => swap(text, cut(RUNBOOK, from, to), ''),
      RUNBOOK,
    );
    for (const problem of [
      'the stolen-token step 4 runs the restore test and the drill on a server root may still hold',
      'the theft’s step 5 puts private keys on a server root may still hold',
      'Rotation runs its closing tests on a server root may still hold',
      'the theft’s sub-step 4 recovers and tests a night on a server root may still hold',
      'the theft’s step 5 never counts the backup key as stolen after a reach as root',
      'the theft’s step 5 keeps the older keys in the rebuilt list',
      'step 2.2 never counts the backup key as stolen after a reach as root',
    ])
      refuses(rootKeys, before, problem);
    // The rebuilt list with the older keys though the backup key counts as stolen.
    refuses(
      rootKeys,
      swap(
        RUNBOOK,
        "every older key of sub-step 1 goes into the stolen key's file, not the rebuilt list",
        'every older key of sub-step 1 stays in the rebuilt list',
      ),
      'the theft’s step 5 keeps the older keys in the rebuilt list',
    );
  });

  it('makes the new backup pair before a rebuild and puts it in before the archive’s timer and backup start (finding K1)', () => {
    expect(rootKeys(RUNBOOK)).toEqual([]);
    // As before the fourth re-review: the new pair "the same day", 2.2 with no time, the timer
    // enabled with no look at the admin's conf, and Rotation silent on a run across the switch.
    const before = [
      [
        cut(RUNBOOK, "      If the backup key's private half was on", '\n\n### Logs and alerts'),
        [
          "      If the backup key's private half was on that server since the trouble could have begun (a",
          '      monthly restore test or drill, a recovery, step 4), the backup key counts as stolen too: it',
          '      opens the settings archives of the nights each older key signed, and their `.env` holds that',
          "      key's private half. So the new server also gets a new backup pair, made as in First install,",
          "      step 1, its public key the admin's `BACKUP_RECIPIENT` and `.env`'s `BACKUP_AGE_RECIPIENT` the",
          '      same day (Secrets (VPS), Rotation, the backup key), and the old private key is kept offline',
          '      for the old backups, the night of sub-step 4 among them, which only it opens; and every older',
          "      key of sub-step 1 goes into the stolen key's file, not the rebuilt list.",
        ].join('\n'),
      ],
      [
        cut(
          RUNBOOK,
          '        new backup pair, made before this recovery began',
          '\n\n     3. **Unpack**',
        ),
        [
          "        new backup pair, and every older key leaves the kept list for the stolen key's file, as",
          "        that section's step 5 says.",
        ].join('\n'),
      ],
      [
        cut(RUNBOOK, ' `BACKUP_AGE_RECIPIENT`\n        becomes the newest', '\n\n        Then, on'),
        '',
      ],
      [
        cut(
          RUNBOOK,
          '. Each archive is\n        encrypted to',
          '\n        ```sh\n        sudo systemctl enable',
        ),
        '; the second command\n        shows its next run, at 20:20 UTC:\n',
      ],
      [cut(RUNBOOK, " A night's settings archive (20:20 UTC", '\n- The signing key (after'), ''],
    ].reduce((text, [from, to]) => swap(text, from, to), RUNBOOK);
    for (const problem of [
      'the theft’s step 5 doesn’t make the new backup pair before the rebuild',
      'the theft’s step 5 puts the new backup pair in only the same day',
      'step 2.2 doesn’t put the new backup pair in before the archive’s timer and backup start',
      'step 2.4 enables the archive’s timer without checking that the admin’s conf names .env’s backup key',
      'Rotation’s backup key step doesn’t say a run across the switch needs both private keys',
    ])
      refuses(rootKeys, before, problem);
    // The conf checked only after the timer is on.
    refuses(
      rootKeys,
      swap(
        swap(RUNBOOK, "        grep '^BACKUP_RECIPIENT=' /etc/apps/menumesh.conf\n", ''),
        `        ${TIMER}\n`,
        `        ${TIMER}\n        grep '^BACKUP_RECIPIENT=' /etc/apps/menumesh.conf\n`,
      ),
      'step 2.4 enables the archive’s timer without checking',
    );
    // Theft design note 1: either clause that keeps the older keys out of the list removed.
    refuses(
      rootKeys,
      swap(
        RUNBOOK,
        '\n      (none when the backup key counts as stolen too, below), without',
        ' without',
      ),
      'the theft’s step 5 keeps the older keys in the rebuilt list where the backup key counts as stolen',
    );
    refuses(
      rootKeys,
      swap(
        RUNBOOK,
        "; and every\n        older key leaves the kept list for the stolen key's file, as that section's step 5 says.",
        ", as that section's step 5 says.",
      ),
      'step 2.2 keeps the older keys in the kept list where the backup key counts as stolen',
    );
  });

  it('lifts no lock after a reach as root until the rebuild, with no token the reached server could read (Stop C’s fifth re-review, finding M1)', () => {
    expect(rootKeys(RUNBOOK)).toEqual([]);
    const problem =
      'step 3 lifts a folder’s lock while a token the server reached as root could read is valid';
    // As the fourth re-review left it: step 3 lifted the lock whatever the reach, the lead-in ran
    // every step above before the rebuild, and sub-step 5 said nothing of step 1's token.
    const step3 = cut(
      RUNBOOK,
      '3. **Remove what the token holder wrote**',
      '\n\n4. **A restore test',
    );
    const lead =
      " (step 3, where root may have reached the server, only after\n   sub-step 5's rebuild):";
    const token = cut(
      RUNBOOK,
      " The bucket's token goes new once more",
      ' and what else the reached server held',
    );
    const oldToken =
      " The bucket's token, the heartbeat addresses and the bot's token go new once\n      more,";
    const before = swap(
      swap(
        swap(RUNBOOK, step3, after(ROUND_5_CLEANUP, '3. **Remove what the token holder wrote**')),
        lead,
        ':',
      ),
      token,
      oldToken,
    );
    const early =
      'the theft’s step 5 leaves step 1’s token valid while disaster recovery makes the night’s versions current and downloads it';
    refuses(rootKeys, before, problem);
    refuses(rootKeys, before, early);
    // Each of the three put back alone, and step 1's token revoked only at step 3.
    refuses(rootKeys, swap(RUNBOOK, after(step3, ' Where root may have reached the'), ''), problem);
    refuses(rootKeys, swap(RUNBOOK, lead, ':'), problem);
    refuses(rootKeys, swap(RUNBOOK, token, oldToken), problem);
    refuses(
      rootKeys,
      swap(RUNBOOK, ' before Disaster recovery, step 2, reads the bucket', ''),
      early,
    );
  });

  it('puts the newest backup public key in .env at 2.4, whatever the archive held, and the same in the conf (Stop C’s fifth re-review, finding M4)', () => {
    expect(rootKeys(RUNBOOK)).toEqual([]);
    const problem =
      'step 2.4 puts in the admin’s conf the backup key the archive’s .env held, a retired one after a rotation';
    // As the fourth re-review left it: .env kept the archive's key but where the backup key counted
    // as stolen, and a conf that differed took that key.
    const round5 = [
      ' Where the backup key counts',
      "        as stolen too (2.2), `BACKUP_AGE_RECIPIENT` becomes the new pair's public key here.",
      '',
      "        Then, on a new server, the settings archive's timer, whose drop-in the admin made in step",
      '        1 (First install, step 13), so that every night has a fresh archive. Each archive is',
      "        encrypted to the admin's `BACKUP_RECIPIENT`, so first check that it is the key `.env`'s",
      "        `BACKUP_AGE_RECIPIENT` names, the new pair's public key where the backup key counts as",
      '        stolen (2.2): the two commands print the same `age1…` key, or the admin puts that one in',
      "        the conf (root's, 0644, which holds the public key only)",
    ].join('\n');
    refuses(
      rootKeys,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          ' `BACKUP_AGE_RECIPIENT`\n        becomes the newest',
          ' before the timer goes on:',
        ),
        round5,
      ),
      problem,
    );
    // Theft design note 1: 2.4's remedy, and step 1's sentence on the new pair, removed.
    refuses(
      rootKeys,
      swap(
        RUNBOOK,
        ", or the admin puts that key in the conf (root's,\n        0644, which holds the public key only)",
        '',
      ),
      problem,
    );
    refuses(
      rootKeys,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          ' Where the\n     backup key counts as stolen (2.2), its new pair',
          "\n  2. The night's id",
        ),
        '',
      ),
      'disaster recovery’s step 1 fills the admin’s BACKUP_RECIPIENT before the new backup pair is made',
    );
  });

  it('stops backup after step 4 on a new server until step 6 starts it after db (finding V4)', () => {
    expect(backupStopped(RUNBOOK)).toEqual([]);
    // As before the re-review: no stop, and step 6 took backup for running.
    refuses(
      backupStopped,
      swap(RUNBOOK, '     sudo app-compose menumesh stop backup\n', ''),
      'step 4 doesn’t stop backup right after the deploy',
    );
    refuses(
      backupStopped,
      swap(
        RUNBOOK,
        '(on a new server\n     this starts `backup`, stopped since step 4, after `db`)',
        '(`backup` was\n     already running on a new server)',
      ),
      'step 6 still takes backup for running since step 4',
    );
  });

  it('keeps the key list in a file of its own, never in the age key’s file (design note 4)', () => {
    expect(listApart(RUNBOOK)).toEqual([]);
    // As before the re-review: step 6 kept the line with the age key.
    refuses(
      listApart,
      swap(
        RUNBOOK,
        "   half once, as `BACKUP_SIGNING_PUBLIC_KEY=<key>`: keep that line beside the age key (step 1),\n   alone in a plain text file of its own, never in the age key's file.",
        '   half once, as `BACKUP_SIGNING_PUBLIC_KEY=<key>`: keep that line with the age key (step 1),\n   and also alone in a plain text file.',
      ),
      'the RUNBOOK keeps the key list with the age key',
    );
    refuses(
      listApart,
      swap(RUNBOOK, "never in the age key's file. A recovery", 'and keep a copy. A recovery'),
      'install doesn’t keep the key list out of the age key’s file',
    );
    // The same, wrapped where the rule spelled out its space until Stop C's third re-review
    // (finding G4): such a phrase escaped it, and a harmless wrap of a good one failed it.
    refuses(
      listApart,
      swap(
        RUNBOOK,
        "never in the age key's file. A recovery",
        "never in the age key's file. Keep a copy with the\n   age key. A recovery",
      ),
      'the RUNBOOK keeps the key list with the age key',
    );
    expect(
      listApart(
        swap(
          RUNBOOK,
          "   alone in a plain text file of its own, never in the age key's file.",
          "   alone in a plain text file of\n   its own, never in the\n   age key's file.",
        ),
      ),
    ).toEqual([]);
  });

  it('names the month’s copy by either of the backup’s lines (finding B1)', () => {
    expect(copyNamed(RUNBOOK)).toEqual([]);
    // As before the re-review: naming a night 29 days old took its own line alone.
    refuses(
      copyNamed,
      swap(
        RUNBOOK,
        "    its own `kept in monthly/ as the month's copy`, or a later night's\n    `the month's copy is <id>`.",
        "    its own `kept in monthly/ as the month's copy`.",
      ),
      'oldNight doesn’t take both of the backup’s lines',
    );
    refuses(
      copyNamed,
      swap(
        RUNBOOK,
        '  copies itself (A night, above). Nights that failed',
        '  copies itself; else copy a whole night, its parts first and its seal last. Nights that failed',
      ),
      'the restore test still copies a night to monthly/ by hand',
    );
    // The same, wrapped where the rule spelled out its space until Stop C's third re-review
    // (finding G4): it escaped the rule then.
    refuses(
      copyNamed,
      swap(
        RUNBOOK,
        '  copies itself (A night, above). Nights that failed',
        '  copies itself; else copy a whole night, its parts\n  first and its seal last. Nights that failed',
      ),
      'the restore test still copies a night to monthly/ by hand',
    );
  });

  it('quotes each step of the month’s copy that fails, and sends a planted name to the stolen-token steps (finding R1)', () => {
    expect(copyReasons(BACKUP)).toEqual([
      'the monthly copy',
      "the check of the month's copy",
      "the record of the month's copy",
    ]);
    expect(plantedEndings(BACKUP)).toEqual([
      "before tonight's copy",
      "before the record of tonight's copy",
    ]);
    const steps = (text: string) => copySteps(text, BACKUP);
    expect(steps(RUNBOOK)).toEqual([]);
    // As before the second re-review: no list of the copy's steps, and no way to the stolen-token steps.
    const before = swap(
      RUNBOOK,
      cut(RUNBOOK, "  The month's copy has steps of its own", '- **The monthly restore test**'),
      '',
    );
    refuses(steps, before, 'doesn’t quote the copy’s step “the monthly copy”');
    refuses(
      steps,
      before,
      "doesn’t quote “… monthly/ holds … before the record of tonight's copy”",
    );
    refuses(steps, before, 'to the stolen-token steps');
    refuses(
      steps,
      swap(
        RUNBOOK,
        "when a step of the month's copy fails on a lock's refusal, or at the same step night after night\n(Last night's backup), ",
        '',
      ),
      'the stolen-token steps don’t take a copy step refused by a lock',
    );
    // As before it: the restore test took every month without a copy for one never whole.
    const remedy = swap(
      RUNBOOK,
      cut(RUNBOOK, ' The check needs a night of this month', ' Then the test.'),
      " When no line names a copy of this month, no night of the month has\n  been whole: mend what the nights' alerts name (Last night's backup), and the next whole night\n  copies itself (A night, above).",
    );
    refuses(
      steps,
      remedy,
      'the restore test takes a month with no copy for one whose nights were never whole',
    );
    refuses(
      steps,
      remedy,
      'the restore test looks for the month’s copy before a night of the month has run',
    );
    // A step backup.sh gains is a step the RUNBOOK must quote.
    refuses(
      (text) => copySteps(RUNBOOK, text),
      BACKUP.replace(
        `reason="the record of the month's copy"`,
        `reason="the seal of the month's copy"`,
      ),
      "doesn’t quote the copy’s step “the seal of the month's copy”",
    );
    // Stop C's third re-review: every line a step gives in place of its reason, one an alert.
    expect(copyFindings(BACKUP)).toEqual([
      'monthly/<name> is not in the bucket as it went up',
      "monthly/seal-<id>.txt is not the night's seal",
      'no sha256 of seal-<id>.txt for the record',
      'the record could not be signed (openssl)',
      'monthly/copy-<id>.txt is not in the bucket as it went up',
    ]);
    // As before it (docs design note 2): one line unquoted, and a step "with what it found".
    const found = swap(
      RUNBOOK,
      cut(RUNBOOK, "  - `the check of the month's copy`", "\n    the copy's parts and seal are in"),
      [
        "  - `the check of the month's copy`, with what it found",
        '    (`monthly/<name> is not in the bucket as it went up`,',
        "    `monthly/seal-<id>.txt is not the night's seal`): the copy is there but not as it went up,",
        '    with no record;',
        "  - `someone else wrote to the bucket: monthly/ holds copy-<id>.txt before the record of tonight's copy`,",
        "    or `the record of the month's copy`, with what it found",
        '    (`the record could not be signed (openssl)`, `monthly/copy-<id>.txt is not in the bucket as it went up`):',
      ].join('\n'),
    );
    refuses(
      steps,
      found,
      'doesn’t quote what a step of the copy found, “no sha256 of seal-<id>.txt for the record”',
    );
    refuses(steps, found, 'reads as if one alert carried a step and what it found');
    // A line backup.sh gains in a step of the copy is a line the RUNBOOK must quote.
    refuses(
      (text) => copySteps(RUNBOOK, text),
      BACKUP.replace(
        "fail 'the record could not be signed (openssl)'",
        "fail 'the record could not be signed (openssl, the key)'",
      ),
      'doesn’t quote what a step of the copy found, “the record could not be signed (openssl, the key)”',
    );
    // As before it (docs design note 1): no word of a night sealed and then failed at the end.
    refuses(
      steps,
      swap(
        RUNBOOK,
        cut(RUNBOOK, ' Nights sealed and then failed at the end', ' Then the test.'),
        '',
      ),
      'the restore test says nothing of the nights sealed and then failed at the end',
    );
  });

  it('keeps the names a stopped night’s alert lists, which backup.sh takes from that night alone (finding K2; the fifth re-review)', () => {
    const steps = (text: string) => copySteps(text, BACKUP);
    expect(ownNamesLookedUp(BACKUP)).toBe(true);
    expect(steps(RUNBOOK)).toEqual([]);
    // As the third re-review (finding E1) and the fourth (K2, under its limits) had it: the names
    // an alert lists deleted, though a leaked .env sends that alert and root writes the journal.
    const problem =
      'the stolen-token steps delete the names a night’s alert lists, though an alert only keeps the night it names';
    refuses(steps, swap(RUNBOOK, cleanupOf(RUNBOOK), ROUND_5_CLEANUP), problem);
    refuses(
      steps,
      swap(
        RUNBOOK,
        ' So\n   nothing goes because',
        [
          " So are the names a night's alert lists after",
          '   `someone else wrote to the bucket: monthly/ holds`, though the backup writes such names: they',
          "   were there before the night's own (Last night's backup). So",
          '   nothing goes because',
        ].join('\n'),
      ),
      problem,
    );
    // A lookup of backup.sh that named another night's name before its "holds" line.
    refuses(
      (text) => copySteps(RUNBOOK, text),
      swap(
        BACKUP,
        'there=$(echo "copy-$night.txt" | held',
        'there=$(echo "copy-$whole.txt" | held',
      ),
      'backup.sh looks up a name of another night before a line that says someone holds it',
    );
  });

  it('checks an id no line shown names by its seal before deleting it, and takes no id for a sign by the journal (finding H1)', () => {
    expect(oldCopies(RUNBOOK)).toEqual([]);
    // As before the fourth re-review: every id no line of the 30 days' journal names, in any
    // folder, the token holder's, and a sign of a stolen token.
    const before = swap(
      swap(
        RUNBOOK,
        cut(RUNBOOK, "2. **Check the bucket's nights**", '\n\n3. **Remove what the token holder'),
        [
          "2. **Check the last nights** against the backup's own lines. Each `backup <id>: …` line in the",
          "   journal names a whole night, as the backup monitor's log does:",
          '',
          '   ```sh',
          '   sudo journalctl COM_DOCKER_COMPOSE_PROJECT=menumesh COM_DOCKER_COMPOSE_SERVICE=backup --since -30d -o cat',
          '   ```',
          '',
          '   Ids in the bucket that no line names, names the backup never writes and floods are the token',
          "   holder's. So are the names a night's alert lists after",
          '   `someone else wrote to the bucket: monthly/ holds`, though the backup writes such names: they',
          "   were there before the night's own (Last night's backup). Left in `monthly/`, one under a",
          "   night's record name, beside that night's own seal, makes a pair that later nights try, and",
          '   five such pairs make every later night of the month copy itself again. A part put over its',
          "   own, in a night the journal names, is refused by its seal, so that night can't be restored",
          '   until the part is put back (the restore test, step 4, says which part).',
          "   In `wal/`, a name whose signature does not verify is the holder's: the drill passes it over",
          '   (it names how many) and a cut chain names the file.',
        ].join('\n'),
      ),
      'when the\nbucket holds names the backup never writes, or when',
      'when the\nbucket holds ids no journal line names or names the backup never writes, or when',
    );
    for (const problem of [
      'the stolen-token steps take every id no line shown names for the token holder’s',
      'the stolen-token steps let a line, an alert or a ping, or the lack of one, condemn an id',
      'the stolen-token steps delete an id no line keeps without checking its seal',
      'the stolen-token steps take ids no journal line names for a sign of a stolen token',
    ])
      refuses(oldCopies, before, problem);
  });

  it('judges every id no line keeps by its seal alone, at the size the bucket lists, with each stolen key’s file (Stop C’s fifth re-review, findings M2 and M3)', () => {
    expect(oldCopies(RUNBOOK)).toEqual([]);
    // As the fourth re-review left it: daily/'s ids no line of this server's journal names deleted,
    // a seal refused for its form taken for one no key signed, one stolen key's file, an older
    // version only from before the trouble, and a trigger on ids no journal line names.
    const before = swap(
      swap(RUNBOOK, cleanupOf(RUNBOOK), ROUND_5_CLEANUP),
      'when the\nbucket holds names the backup never writes, or when',
      'when `daily/`\nholds ids no journal line names (step 2), or the bucket names the backup never writes, or when',
    );
    for (const problem of [
      'the stolen-token steps take daily/’s ids no line shown names for the token holder’s',
      'the stolen-token steps let a line, an alert or a ping, or the lack of one, condemn an id',
      'the stolen-token steps delete an id no line keeps without checking its seal',
      'the stolen-token steps take a seal refused for its form, as a download that is not byte for byte is, for one signed by no key',
      'the stolen-token steps check a seal with one stolen key’s file, though each theft leaves one',
      'the stolen-token steps delete a refused seal whose older version a list verifies',
      'the stolen-token steps delete an id whose seal a key of a list signed',
      'the stolen-token steps take ids no journal line names for a sign of a stolen token',
    ])
      refuses(oldCopies, before, problem);
    // Each clause that keeps the backup's own objects removed in turn (theft design notes 1 to 3).
    for (const [from, to, problem] of [
      [
        ', as does an id with no seal at all.',
        '.',
        'the stolen-token steps delete an id no line keeps without checking its seal',
      ],
      [
        "Its record and parts stay, as they may be the backup's",
        'Its record goes too, and its parts stay',
        'the stolen-token steps delete an id no line keeps without checking its seal',
      ],
      [
        "`its seal (seal-<id>.txt) is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys`",
        "`the night of <id> is not signed by the backup's key: its seal …`",
        'the stolen-token steps take a seal refused for its form',
      ],
      [
        "with each\n   stolen key's file kept (one for each theft: step 5)",
        "with the\n   stolen key's file where there is one (step 5)",
        'the stolen-token steps check a seal with one stolen key’s file',
      ],
      [
        cut(RUNBOOK, ', or, where the bucket kept an\n', ' Its record and parts stay'),
        '.',
        'the stolen-token steps delete a refused seal whose older version a list verifies',
      ],
      [
        cut(RUNBOOK, ' (after a leaked\n   `.env`, step 5,', ' Its record and parts stay'),
        '.',
        'the stolen-token steps delete a refused seal whose older version a list verifies',
      ],
      [
        cut(RUNBOOK, ' A pass, or a refusal past the seal', ' Names the\n'),
        '',
        'the stolen-token steps delete an id whose seal a key of a list signed',
      ],
      [
        "The backup's own nights, month's copies and WAL stay.",
        "The backup's own nights and WAL stay.",
        'the stolen-token step 3 deletes the backup’s own nights, month’s copies or WAL',
      ],
    ])
      refuses(oldCopies, swap(RUNBOOK, from, to), problem);
  });

  it('takes a night no record names, or one stamped later than now or passed over, for a sign of theft, and its key for stolen (Stop C’s sixth re-review, finding P1, theft design note 6)', () => {
    expect(oldCopies(RUNBOOK)).toEqual([]);
    const trigger =
      'the stolen-token steps take no night a restore takes that no record names, or stamped later than now, or a night or WAL objects passed over, for a sign of a stolen token';
    const key =
      'the stolen-token steps keep trusting the key that signed a night no record of the backup names';
    // As the fifth re-review left them: neither the trigger nor step 2's sentence.
    const before = swap(
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          ' when a\nrestore test, drill or recovery takes',
          ' when the\nbucket holds names',
        ),
        '',
      ),
      cut(RUNBOOK, '\n\n   A seal a list verifies that no record', '\n\n3. **Remove what'),
      '',
    );
    refuses(oldCopies, before, trigger);
    refuses(oldCopies, before, key);
    // Each sign dropped in turn, and the key kept.
    for (const [from, to, problem] of [
      [
        'restore test, drill or recovery takes a night that none of the backup',
        'restore test, drill or recovery takes a night that none of the bucket',
        trigger,
      ],
      [
        ' names one stamped later than\nnow (`restore: not taking the night of <id>, stamped later than now`),',
        '',
        trigger,
      ],
      [
        "\n(`pitr: not taking the night of <id>: its seal …, so it is not the backup's`)",
        '',
        trigger,
      ],
      ["\n(`<n> objects passed over, not the backup's`, n above 0)", '', trigger],
      ['take\n   that key for stolen (step 5)', 'keep\n   that key in the list', key],
    ])
      refuses(oldCopies, swap(RUNBOOK, from, to), problem);
  });

  it('puts back every version written over the backup’s own, and judges the bucket again after the revocation where root may have been (Stop C’s sixth re-review, finding P2, theft design notes 1 to 4, P3)', () => {
    expect(oldCopies(RUNBOOK)).toEqual([]);
    expect(rootKeys(RUNBOOK)).toEqual([]);
    const versions =
      'the stolen-token steps leave current a version put over the backup’s own, or a delete marker, in a night a line keeps';
    const again =
      'step 2 judges the bucket only while root may still write to it with step 1’s token, so what root wrote since stays';
    const only =
      'step 3 waits for the bucket’s only token to be the rebuilt server’s, which a read-only token for a download never lets be true';
    const alerts =
      'the theft’s step 5 says nothing of what the reached server alerts once step 1’s token is revoked';
    // As the fifth re-review left them: no versions listed, step 2 judged once, before the
    // revocation, step 3 waiting for "the bucket's only token", and no word of the alerts.
    const step3 = cut(
      RUNBOOK,
      "   waits for sub-step 5's rebuild, once step 1's token is revoked and the only token",
      '\n\n4. **A restore test',
    );
    const before = swap(
      swap(
        swap(
          RUNBOOK,
          cut(
            RUNBOOK,
            '\n\n   Where the bucket keeps versions (versioning, or S3 Object Lock)',
            '\n\n   A seal a list verifies that no record',
          ),
          '',
        ),
        step3,
        [
          "   waits for sub-step 5's rebuild, once step 1's token is revoked and the bucket's only token is the",
          "   rebuilt server's, which the reached one never held.",
        ].join('\n'),
      ),
      cut(
        RUNBOOK,
        ' so only then is\n      step 2 done again',
        " The heartbeat addresses and the bot's",
      ),
      ' so only then does\n      step 3 lift a lock.',
    );
    refuses(oldCopies, before, versions);
    for (const problem of [again, only, alerts]) refuses(rootKeys, before, problem);
    // Each part dropped or turned in turn, and the two clauses that keep the backup's own objects.
    for (const [from, to, problem] of [
      [
        'a name with more than one version, or a delete marker,',
        'a name with a delete marker',
        versions,
      ],
      ['whether or not a line keeps its night', 'where no line keeps its night', versions],
      ['versions too,\n   delete markers among them,', 'versions too,', versions],
      [
        ' A line only keeps an id from going, never a version\n   put over the backup',
        ' So',
        versions,
      ],
      [
        'Only a seal that every list refuses',
        'Only a seal that the kept list refuses',
        'the stolen-token steps delete a seal only the kept list refuses',
      ],
      [
        ' The drill passes over any\n   other name in `wal/` whose signature does not verify (it names how many): a cost only.',
        "\n   In `wal/`, a name whose signature does not verify is the holder's: the drill passes it over\n   (it names how many) and a cut chain names the file.",
        'the stolen-token steps take a WAL name whose signature does not verify for the holder’s',
      ],
    ])
      refuses(oldCopies, swap(RUNBOOK, from, to), problem);
    for (const [from, to, problem] of [
      [
        "; and step 2 is done again\n   first, its versions among them, as root could write with step 1's token until then.",
        '.',
        again,
      ],
      [
        ' so only then is\n      step 2 done again, its versions among them, and only then does',
        ' so only then does',
        again,
      ],
      ['the only token that can write\n   or delete is', "the bucket's only token is", only],
      [
        cut(RUNBOOK, ' From the\n      revocation until', " The heartbeat addresses and the bot's"),
        '',
        alerts,
      ],
    ])
      refuses(rootKeys, swap(RUNBOOK, from, to), problem);
  });

  it('names each of pitr.sh’s refusals of a base whose timeline a rewind left (finding M1)', () => {
    expect(leftEndings(PITR)).toEqual(['before the base began', 'before the base ended']);
    expect(baseRefusals(RUNBOOK, PITR)).toEqual([]);
    // As before the re-review: the drill named the refusal of a base left before it began alone.
    refuses(
      (text) => baseRefusals(text, PITR),
      swap(
        RUNBOOK,
        '  - `the base backup of <id> is of the timeline X, …, which was left for a later one at …, before the base ended`:\n',
        '  - the same, when the base had not ended:\n',
      ),
      'the drill’s failure lines don’t name “before the base ended”',
    );
    refuses(
      (text) => baseRefusals(RUNBOOK, text),
      PITR.replaceAll('print "was left for a later one at "', 'print "was left at "'),
      'pitr.sh refuses no base whose timeline a rewind left',
    );
  });

  it('quotes what pitr.sh tells a recovery to a point that a cut stops short of (finding T1)', () => {
    expect(cutAdviceOf(PITR)).toBe(
      'or to latest; if that recovery is cut at <file> too, it ends there only with PITR_ACCEPT_CUT=<file>',
    );
    expect(cutAdvice(RUNBOOK, PITR)).toEqual([]);
    // As before the second re-review: latest only with PITR_ACCEPT_CUT, which ends at the cut.
    const before = swap(
      RUNBOOK,
      cut(
        RUNBOOK,
        'recover to an earlier point, or to `latest`. A recovery',
        ' A run refused once the replay began',
      ),
      'recover to an earlier point, or, when the reason is a cut, to `latest` with\n     `PITR_ACCEPT_CUT`, which ends at the cut (below).',
    );
    refuses(
      (text) => cutAdvice(text, PITR),
      before,
      'step 5 still sends a cut-short point to latest with PITR_ACCEPT_CUT',
    );
    refuses(
      (text) => cutAdvice(text, PITR),
      before,
      'step 5 doesn’t quote what pitr.sh tells a recovery to a point a cut stops short of',
    );
    refuses(
      (text) => cutAdvice(RUNBOOK, text),
      PITR.replace(
        /instead="or to latest; [^"]*"/,
        'instead="or to latest with PITR_ACCEPT_CUT=$gap"',
      ),
      'pitr.sh tells a cut-short recovery nothing of what latest does at the cut',
    );
  });

  it('takes out the seal of each night a rewind left, in turn, and puts them back after a night of its timeline (finding T2)', () => {
    expect(rewindRoute(RUNBOOK)).toEqual([]);
    // As before the second re-review: the newest night's seal out, and the night before took over.
    const before = swap(
      RUNBOOK,
      cut(
        RUNBOOK,
        '     A rewind to a point (a recovery to it, as here)',
        '     It ends with `point-in-time recovery',
      ),
      "     After a rewind to a point before the newest night's base ended, and until a night of the\n     rewind's timeline exists, a recovery to `latest` takes that night and refuses it before it\n     writes anything: step 9 makes such a night right after a rewind. On a new server with no newer\n     night, a point before that night's base ended takes the night before and reaches the fork at\n     most; to go past the fork, that night's seal must first leave `daily/` (kept aside, so it can\n     go back), and the night before then recovers to `latest` across the fork.\n\n",
    );
    refuses(rewindRoute, before, 'step 5 takes only the newest night out of daily/');
    refuses(rewindRoute, before, 'step 5 still has the night before recover across the fork');
    refuses(rewindRoute, before, 'step 5 doesn’t say when the seals kept aside go back');
    refuses(
      rewindRoute,
      swap(
        RUNBOOK,
        ', even once that night exists (Disaster recovery, step 5).',
        ' (Disaster recovery, step 5).',
      ),
      'the drill doesn’t say a point the rewind left behind is refused after the night by hand',
    );
    // As before the third re-review (finding F2, pitr design note 1): the way past to "that
    // point", one on the stretch the rewind abandoned reaching "the fork at most", and no word of
    // the history file the refusals need.
    const promised = swap(
      swap(
        swap(
          RUNBOOK,
          ", or to a point of the\n       second kind on the rewind's timeline (after the rewind ran), as the rehearsal shows.",
          ', or to that point, as\n       the rehearsal shows.',
        ),
        cut(RUNBOOK, ' a point on the abandoned timeline after', '\n     - to get past them'),
        " a point after it, before the base of any of them\n       ended, reaches the fork at most, as the old timeline's WAL after the rewind's point is never\n       replayed (only a night's logical recovery has that stretch);",
      ),
      cut(
        RUNBOOK,
        '. The refusal needs the',
        '\n     - a point after the base of any of them ended',
      ),
      ';',
    );
    refuses(
      rewindRoute,
      promised,
      'step 5 promises the way past reaches a point on the stretch the rewind abandoned',
    );
    refuses(
      rewindRoute,
      promised,
      'step 5 doesn’t say a point on the stretch the rewind abandoned reaches only the rewind’s point',
    );
    refuses(
      rewindRoute,
      promised,
      'step 5 doesn’t say the refusal needs the rewind’s history file in the bucket',
    );
    // As before the fourth re-review (recovery design note 4): done whichever seals are out.
    const stillDone = swap(
      swap(
        RUNBOOK,
        cut(RUNBOOK, ' Once the seal of every left night', '\n       Only the time of its last'),
        ' It still ends `done` (a drill `passed`), and',
      ),
      '`passed`), and\n       Only the time of its last',
      '`passed`), and\n       only the time of its last',
    );
    refuses(
      rewindRoute,
      stillDone,
      'step 5 says a point on the stretch the rewind abandoned ends done whichever seals are out',
    );
  });

  it('rewinds past a bad release to a time before its deploy began, never one read off deploys.log (Stop C’s fifth re-review, deploy design note 1)', () => {
    expect(rewindRoute(RUNBOOK)).toEqual([]);
    const problem =
      'step 5 rewinds past a bad release to a point read off deploys.log, whose line comes after its migrations ran';
    // As the fourth re-review left it: the minute just before the loss, a bad release's or not.
    const point = cut(
      RUNBOOK,
      '\n     a time before the loss as',
      " After a recovery to a state from before a bad\n     release's deploy",
    );
    refuses(
      rewindRoute,
      swap(
        RUNBOOK,
        point,
        '\n     the minute just before the loss (a bad release, a deletion) as `YYYY-MM-DDTHH:MM:SSZ` or with\n     an offset such as `+05:30`, at most 14 days back.',
      ),
      problem,
    );
    // Where to read the deploy's start left out.
    refuses(rewindRoute, swap(RUNBOOK, after(point, ' That is\n'), ''), problem);
  });

  it('rewinds past a bad release to before the first attempt that ran its migrations, on a new server too (Stop C’s sixth re-review, finding N3)', () => {
    expect(rewindRoute(RUNBOOK)).toEqual([]);
    const first =
      'step 5 takes a bad release’s point from any of its deploying lines, though its first attempt left its migrations applied';
    const closer =
      'step 5 takes a bad release’s closest point from a line that comes after its migration committed';
    const fresh =
      'step 5 names no point before a bad release on a new server, without the old journal';
    // As the fifth re-review left it: "its" deploying line and "its" dump, of whichever attempt,
    // and nothing for a new server.
    const before = swap(
      RUNBOOK,
      cut(
        RUNBOOK,
        '     before the first `deploying <ref>',
        " After a recovery to a state from before a bad\n     release's deploy",
      ),
      [
        '     before its `deploying <ref> to web (menumesh production)` line in',
        '     `sudo journalctl -t app-deploy --utc -o short-iso`, or at the latest the stamp (UTC,',
        '     `YYYYMMDDTHHMMSSZ`) in the name of its pre-deploy dump,',
        '     `/srv/menumesh/predeploy/production-<stamp>-postgres.dump.age`, made before its migrations.',
      ].join('\n'),
    );
    for (const problem of [first, closer, fresh]) refuses(rewindRoute, before, problem);
    // Each part dropped in turn, and the closest point read off the harmful file's own line.
    for (const [from, to, problem] of [
      [' the first `deploying <ref>', ' its `deploying <ref>', first],
      [
        ', of any attempt, `FAILED` and\n     `ROLLED BACK` ones included, as the migrations an attempt ran stay applied',
        '',
        first,
      ],
      [
        cut(RUNBOOK, '\n     or, closer, before the first `running migrate', ' On a new server,'),
        '',
        closer,
      ],
      [
        'before the first `running migrate on migrate-<sha>` line after that one, as no\n     migration runs before it',
        "before its harmful file's `migrate: applied <file>` line in the same journal",
        closer,
      ],
      [
        cut(RUNBOOK, ' On a new server, without that journal,', ' After a recovery to a'),
        '',
        fresh,
      ],
    ])
      refuses(rewindRoute, swap(RUNBOOK, from, to), problem);
  });

  it('deploys a recovered release without a migrate reference, the one before a rewind’s after an archive from before it (finding F1)', () => {
    expect(releaseDeployed(RUNBOOK)).toEqual([]);
    // As before the third re-review: after latest or a night, the release images.env names with
    // its migrate image, and nothing of a settings archive from before a rewind.
    const before = swap(
      RUNBOOK,
      cut(RUNBOOK, "\n  7. Production's image", '\n  8. The edge'),
      [
        "\n  7. Production's image, by the admin form, and staging's; then",
        "     `sudo app-compose menumesh up -d scheduler scheduler-staging`. Production's is the image that",
        '     was live at the point recovered to. After a recovery to `latest`, or of a night, that is the',
        '     one `images.env` names, deployed with its migrate image (after `latest` the migrations find',
        '     nothing to apply). After a rewind to a point before a release, such as the bad release it',
        '     undid, it is the release before it, the last production line of `deploys.log` before that',
        '     point, deployed without a migrate reference (Deploys on the VPS, Rolling back by hand), and',
        '     never the entry of `images.env` that the rewind undid: that file still names the release,',
        '     whose migrate run would apply its migrations again and switch `web` back to it.',
      ].join('\n'),
    );
    refuses(
      releaseDeployed,
      before,
      'step 7 deploys the release `images.env` names with the migrate image `images.env` names',
    );
    refuses(releaseDeployed, before, 'step 7 still deploys a release with its migrate image');
    refuses(
      releaseDeployed,
      before,
      'step 7 deploys the release a rewind undid after a recovery from a settings archive made before the rewind',
    );
    // The way past the nights a rewind left without its pointer to step 7.
    refuses(
      releaseDeployed,
      swap(
        RUNBOOK,
        cut(RUNBOOK, ' On a\n       new server, see step 7', ';\n     - the seals go back'),
        '',
      ),
      'the way past the nights a rewind left doesn’t send the owner to step 7 for the release',
    );
  });

  it('deploys after a night recovered on the same server the release live at that night, from deploys.log in UTC, with the token (finding J1)', () => {
    expect(releaseDeployed(RUNBOOK)).toEqual([]);
    // As before the fourth re-review: after latest or any night, the release images.env names,
    // which on the same server is a release made since the night, and nothing of how to read
    // deploys.log or of the token a pull needs.
    const before = swap(
      RUNBOOK,
      cut(RUNBOOK, "\n  7. Production's image", '\n  8. The edge'),
      [
        "\n  7. Production's image, by the admin form, and staging's; then",
        "     `sudo app-compose menumesh up -d scheduler scheduler-staging`. Production's is the image that",
        '     was live at the point recovered to, deployed without a migrate reference (Deploys on the VPS,',
        '     Rolling back by hand), as the database already holds its migrations. After a recovery to',
        "     `latest`, or of a night, that is the release `images.env`'s `WEB_IMAGE` names, never with",
        '     the image its `MIGRATE_IMAGE` names, which can still be that of a release a rewind undid,',
        '     since a rollback by hand passes no migrate reference: its migrate run would apply that',
        "     release's migrations again. After a rewind to a point before a release, such as the bad",
        '     release it undid, it is the release before it, the last production line of `deploys.log`',
        '     before that point, and never the entry of `images.env` that the rewind undid: that file',
        '     still names the release, whose migrate run would apply its migrations again and switch `web`',
        '     back to it. So too when a rewind past a release came after the night whose settings archive',
        '     step 2 unpacked, as on a new server that took the way past the nights a rewind left (step',
        "     5): that archive's `images.env` and `deploys.log` still name the release the rewind undid,",
        "     so production's is the release before it, the last production line of the archive's",
        "     `deploys.log` before the rewind's point.",
      ].join('\n'),
    );
    for (const problem of [
      'step 7 deploys, after a night recovered on the same server, the release `images.env` names, one made since the night',
      'step 7 doesn’t take a new server’s night’s release from that night’s own settings archive',
      'step 7 compares the lines of `deploys.log` with a time that may not be in UTC',
      'step 7 takes the new image of a failed or rolled-back deploy for the one live',
      'step 7 deploys a release image no longer on the server without the token app-deploy needs to pull it',
      'step 7 leaves the releases made since the point recovered to undeployed',
    ])
      refuses(releaseDeployed, before, problem);
    // The same-server sentence alone put back to the unqualified one.
    refuses(
      releaseDeployed,
      swap(
        RUNBOOK,
        cut(RUNBOOK, 'After a recovery to `latest` on the same server', ', that is the release'),
        'After a recovery to `latest`, or of a night',
      ),
      'step 7 deploys, after a night recovered on the same server, the release `images.env` names',
    );
    // The token's command with the migrate reference of Production, step 2.
    refuses(
      releaseDeployed,
      swap(
        RUNBOOK,
        '          prod-vX.Y.Z@sha256:<digest>\n        ```\n\n     2. **From before',
        '          prod-vX.Y.Z@sha256:<digest> migrate-<sha>@sha256:<digest>\n        ```\n\n     2. **From before',
      ),
      'step 7 deploys a release with a migrate reference',
    );
  });

  it('sends out again only the newest release that stayed live, and none after a rewind past a bad release until its migration is harmless (Stop C’s fifth re-review, findings L1 and L2)', () => {
    expect(releaseDeployed(RUNBOOK)).toEqual([]);
    // As the fourth re-review left it: every release made since, in turn, oldest first, from the
    // VPS release runs, a rolled-back one among them, and after a rewind past a bad release every
    // later one but the release the rewind undid, though each holds its migrations; and nothing in
    // step 5 or Database migrations.
    const before = swap(
      swap(
        swap(
          RUNBOOK,
          cut(RUNBOOK, "\n\n     2. **From before a bad release's deploy**", '\n\n  8. The edge'),
          [
            '',
            '',
            '     The releases made since then go out again in turn, oldest first, each by Production, step 2,',
            '     with the line its **VPS release** run printed, whose migrate run applies what the recovered',
            '     database lacks; never the release a rewind undid.',
          ].join('\n'),
        ),
        cut(RUNBOOK, ' After a recovery to a state from before a bad', ' (step 7).') + ' (step 7).',
        '',
      ),
      '; but after a recovery past a bad\n  release on the shared server, a rewind or a night from before it, make its harmful migration\n  harmless in its own file instead (Backups and restore (VPS), Disaster recovery, step 7).',
      '.',
    );
    for (const problem of [
      'step 7 leaves the releases made since the point recovered to undeployed',
      'step 7 sends out again a release rolled back since, or takes the releases since from the VPS release runs alone',
      'step 7 sends out again every release made since, a rolled-back one among them',
      'step 7 sends out, after a recovery to a state from before a bad release, a later release that applies its migrations again',
      'step 7 keeps out only the release a rewind undid, though every later one holds its migrations',
      'step 5 or Database migrations lets a release go out after a recovery past a bad release',
    ])
      refuses(releaseDeployed, before, problem);
  });

  it('goes by the recovered state, never sending out a release made since a bad release’s deploy, nor its own again (Stop C’s sixth re-review, findings N1, N2, N4 and N5)', () => {
    expect(releaseDeployed(RUNBOOK)).toEqual([]);
    // As the fifth re-review left them: step 7 by the kind of recovery, the newest release sent
    // out again after any night, step 7's own among them, latest's release from images.env even
    // after a cut; step 5's "until"; Database migrations' rewind alone.
    const before = swap(
      swap(
        swap(
          RUNBOOK,
          cut(RUNBOOK, "\n  7. Production's image", '\n  8. The edge'),
          ROUND_6_RELEASE,
        ),
        cut(RUNBOOK, ' After a recovery to a state from before a bad', ' (step 7).') + ' (step 7).',
        '\n     After a rewind past a bad release, no release made since goes out again until its harmful\n     migration is made harmless (step 7).',
      ),
      'but after a recovery past a bad\n  release on the shared server, a rewind or a night from before it, make its harmful migration\n  harmless in its own file instead (Backups and restore (VPS), Disaster recovery, step 7).',
      'but after a rewind past a bad\n  release on the shared server, make its harmful migration harmless in its own file instead\n  (Backups and restore (VPS), Disaster recovery, step 7).',
    );
    for (const problem of [
      'step 7 takes the release by the kind of recovery, not by the state it brought back',
      'step 7 takes, after `latest` that ended at a cut, the release `images.env` names',
      'step 7 leaves the releases made since the point recovered to undeployed',
      'step 7 sends the newest release out again whether or not one went live since',
      'step 7 sends its own release out again with its migrate reference when none went live since',
      'step 7 sends a release rolled back to since out again with its migrate reference',
      'step 7 sends out, after a recovery to a state from before a bad release, a later release that applies its migrations again',
      'step 7 sends the newest release out again after any night, though a night from before a bad release lacks its migration',
      'step 5 or Database migrations lets a release go out after a recovery past a bad release',
      'step 5 lets a release made since a bad release go out once its migration is edited, though its image holds the original',
    ])
      refuses(releaseDeployed, before, problem);
    // Each part of the new text dropped or turned in turn.
    for (const [from, to, problem] of [
      [
        'a rewind past it, a night from before it, or `latest` that\n        ended at a cut before it',
        'a rewind past it',
        'step 7 sends out, after a recovery to a state from before a bad release, a later release',
      ],
      [
        " If none did, or it is step 1's own, step 1's deploy is all.",
        '',
        'step 7 sends its own release out again with its migrate reference when none went live since',
      ],
      [
        ', unless it ended at a cut\n        (`PITR_ACCEPT_CUT`) or before',
        ', unless it ended before',
        'step 7 takes, after `latest` that ended at a cut, the release `images.env` names',
      ],
      [
        "the one live at the recovered state's last transaction",
        'the one live at the point recovered to',
        'step 7 takes the release by the kind of recovery, not by the state it brought back',
      ],
      [
        "named before step 7's deploy",
        "named after step 7's deploy",
        'step 7 sends out again a release rolled back since, or takes the releases since from the VPS release runs alone',
      ],
      [
        'never left the new one live:\n        the release is its old one.',
        'never left the new one live.',
        'step 7 doesn’t say which release a failed or rolled-back line leaves live',
      ],
      [
        cut(RUNBOOK, " One older than step 1's,", " If none did, or it is step 1's own"),
        '',
        'step 7 sends a release rolled back to since out again with its migrate reference',
      ],
      [
        ' until the harmful migration is made harmless in its own file, under its own version\n        (Database migrations)',
        '',
        'step 7 sends out, after a recovery to a state from before a bad release, a later release',
      ],
      [
        'goes out again, ever, and one built from `main` only\n     once its harmful migration is made harmless in its own file (step 7).',
        'goes out again until its harmful migration is made harmless (step 7).',
        'step 5 lets a release made since a bad release go out once its migration is edited',
      ],
    ])
      refuses(releaseDeployed, swap(RUNBOOK, from, to), problem);
  });

  it('reads every sentence the same however the RUNBOOK wraps it (theft-docs design note 2)', () => {
    let rewrapped = RUNBOOK;
    for (const phrase of REWRAPPED) {
      expect(rewrapped.includes(phrase), phrase).toBe(true);
      rewrapped = rewrapped.replaceAll(phrase, phrase.replace(' ', '\n  '));
      expect(rewrapped.includes(phrase), phrase).toBe(false);
    }
    expect(archiveFirst(rewrapped)).toEqual([]);
    expect(pairChecked(rewrapped)).toEqual([]);
    expect(valuesNamed(rewrapped, BACKUP, SHIPPER)).toEqual([]);
    expect(theftNight(rewrapped)).toEqual([]);
    expect(theftOrder(rewrapped)).toEqual([]);
    expect(oneRunKey(rewrapped)).toEqual([]);
    expect(theftList(rewrapped)).toEqual([]);
    expect(theftRecords(rewrapped)).toEqual([]);
    expect(envLeaked(rewrapped)).toEqual([]);
    expect(rootReach(rewrapped)).toEqual([]);
    expect(rootKeys(rewrapped)).toEqual([]);
    expect(backupStopped(rewrapped)).toEqual([]);
    expect(listApart(rewrapped)).toEqual([]);
    expect(copyNamed(rewrapped)).toEqual([]);
    expect(copySteps(rewrapped, BACKUP)).toEqual([]);
    expect(oldCopies(rewrapped)).toEqual([]);
    expect(baseRefusals(rewrapped, PITR)).toEqual([]);
    expect(cutAdvice(rewrapped, PITR)).toEqual([]);
    expect(rewindRoute(rewrapped)).toEqual([]);
    expect(releaseDeployed(rewrapped)).toEqual([]);
  });
});
