import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SIGNING_PAIR_CHECK } from '../../scripts/vps-kit.mts';

/**
 * The steps of docs/RUNBOOK.md's "The shared server (VPS)" that no script runs: the owner follows
 * them by hand, on the server or in a disaster, so a step that went missing would show only then.
 * These text rules pin the procedure fixes of Stop C's re-reviews (docs/DECISIONS.md VPS-60 to
 * VPS-65, VPS-67 and VPS-68 to VPS-76): every backup.sh run by hand comes right after a settings
 * archive made for it, and a new server enables the archive's timer (finding V3); disaster
 * recovery's step 2.4 puts the signing key's private half in, and step 4 stops backup until db
 * runs (V4) and checks the signing pair with SIGNING_PAIR_CHECK, character for character (V2),
 * quoting each line it prints, as the night's and the shipper's alerts quote the values that are
 * no keys (U4); step 2.2 takes a night from before a theft of the signing key with the stolen key's
 * file (V1), its versions of before the trouble made current before anything of it is downloaded
 * or recovered (U1), and its logical recovery gets that file's list for the one run (U2); after a
 * theft the list keeps the older keys that never leaked (U3), the backup's own records go new and
 * name a night from before only by what was recorded before (U5), and a server reached as root is
 * rebuilt with none of its nights taken (N1); the key list is kept in a file of its own, never in
 * the age key's (design note 4); the month's copy is named by either of the backup's lines (B1),
 * and each step of it that fails is quoted with the way to the stolen-token steps (R1); the drill
 * names each of pitr.sh's refusals of a base whose timeline a rewind left (M1), the recovery quotes
 * what pitr.sh tells a point a cut stops short of (T1), and the way past the nights a rewind left
 * takes out each one's seal in turn (T2). Every rule also refuses a copy with one mistake, as
 * tests/unit/vps-kit.test.ts does, among them the RUNBOOK's text as it was before the fix. Every
 * phrase is compared with its white space folded, so a sentence wrapped again is still found.
 */

const RUNBOOK = readFileSync(join('docs', 'RUNBOOK.md'), 'utf8');
const PITR = readFileSync(join('deploy', 'vps', 'backup', 'pitr.sh'), 'utf8');
const BACKUP = readFileSync(join('deploy', 'vps', 'backup', 'backup.sh'), 'utf8');
const SHIPPER = readFileSync(join('deploy', 'vps', 'backup', 'wal-ship.sh'), 'utf8');

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
  rotation: ['- The signing key (after the server may have been reached', "- Staging's password"],
  lastNight: ["- **Last night's backup:**", '- **The monthly restore test**'],
  restoreTest: ['- **The monthly restore test**', '- **The monthly point-in-time drill**'],
  oldNight: ['**29 days old or more**', '**365 days old or more**'],
  drill: ['- **The monthly point-in-time drill**', '- **Disaster recovery**'],
  recovery: ['- **Disaster recovery**', '### A stolen or leaked bucket token (VPS)'],
  download: ['1. **Download**', '2. **Check**'],
  check: ['2. **Check**', '3. **Unpack**'],
  keyList: ['4. **The key list', '\n  3. `sudo app-apply menumesh compose'],
  backupImage: ['\n  4. The backup image that `images.env` names', '\n  5. The recovery'],
  fallback: ["**The fallback, a night's logical recovery**", '\n  6. `wal-spool` must be new'],
  start: ['\n  6. `wal-spool` must be new', '\n  7. '],
  rerun: ['\n  9. The key off the ramfs', '### A stolen or leaked bucket token (VPS)'],
  stolen: ['### A stolen or leaked bucket token (VPS)', '1. **Rotate the token**'],
  theft: ['5. **If the server itself may have been reached**', '### Logs and alerts (VPS)'],
  walAlerts: ['- **WAL alerts**', '### Checking the kit here'],
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

/**
 * A settings archive from before a rotation holds the private key of before it, which the kept
 * list put in its place no longer begins with: backup.sh would seal no night and wal-ship.sh ship
 * no WAL (finding V2). So step 2.4 puts in BACKUP_SIGNING_KEY's private half from the password
 * manager, where Rotation keeps the new one, and step 4 checks the pair with SIGNING_PAIR_CHECK as
 * it is, before step 5, once the backup image is there.
 */
const pairChecked = (runbook: string) =>
  inPlaces(
    runbook,
    ['keyList', 'backupImage', 'rotation'],
    ({ keyList, backupImage, rotation }) => [
      ...(has(keyList, '`BACKUP_SIGNING_KEY`') && has(keyList, 'password manager')
        ? []
        : ['step 2.4 doesn’t put in BACKUP_SIGNING_KEY’s private half from the password manager']),
      ...(has(backupImage, PAIR_COMMAND)
        ? []
        : ['step 4 doesn’t check the signing pair with SIGNING_PAIR_CHECK as it is']),
      ...(PAIR_SIGNS && has(backupImage, `\`${PAIR_SIGNS}\``)
        ? []
        : ['step 4 doesn’t say what the signing pair’s check prints for a pair']),
      ...(has(rotation, 'password manager') && /Disaster recovery,\s+step 4/.test(rotation)
        ? []
        : ['Rotation doesn’t keep the new private key in the password manager and check the pair']),
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
 * and an older key that may have leaked goes into the stolen key's file with it.
 */
const theftList = (runbook: string) =>
  inPlaces(runbook, ['theft', 'check', 'rotation'], ({ theft, check, rotation }) => [
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
      : ['step 2.2 doesn’t say the kept list holds the new key first and the older keys after it']),
    ...(has(
      rotation,
      'whose private half had left the server before the trouble could have begun stays',
    )
      ? []
      : ['Rotation drops an older key a thief never held with the stolen one']),
    ...([theft, check, rotation].some((text) => /the new (?:public )?key alone/.test(flat(text)))
      ? ['the new list holds the new key alone, which drops every older key and keeps it nowhere']
      : []),
  ]);

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

/**
 * Where the old server may have been reached as root, its night of the new key carries its data
 * folder, ALTER SYSTEM settings and planted files and all, which a point-in-time recovery puts back
 * for db, and the new key went into its .env (Stop C's second re-review, N1): nothing it made after
 * the trouble is trusted, it is rebuilt with a fresh signing pair, and the night from before the
 * trouble is recovered logically.
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
    ...(has(recovery, "none of that server's nights may be taken, the new key's included")
      ? []
      : ['disaster recovery’s first choice may start from a night of a server reached as root']),
    ...(has(check, 'nothing it made after the trouble could have begun is taken')
      ? []
      : ['step 2.2 distrusts only the archive of a night a server reached as root made']),
  ]);

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
 */
const listApart = (runbook: string) =>
  inPlaces(runbook, ['vps', 'firstKey', 'secrets', 'rotation'], (texts) => [
    ...[...texts.vps.matchAll(/with the age\s+key/g)].map(
      () => 'the RUNBOOK keeps the key list with the age key',
    ),
    ...(['firstKey', 'secrets', 'rotation'] as const)
      .filter((name) => !/file of its\s+own/.test(texts[name]))
      .map((name) => `${name} doesn’t keep the key list in a file of its own`),
    ...(/never in the age key's\s+file/.test(texts.secrets) &&
    /never inside\s+`menumesh-backup-key\.txt`/.test(texts.firstKey)
      ? []
      : ['install doesn’t keep the key list out of the age key’s file']),
  ]);

const RELIED = "the month's copy is <id>";
const MADE = "kept in monthly/ as the month's copy";

/**
 * The night that makes the month's copy says so in a line of its own, and every later whole night
 * names the copy it found (finding B1): the monthly check, naming a night 29 days old or more and
 * step 2.1's download from monthly/ take either line, and nobody copies a night by hand, as a copy
 * without its record is never counted.
 */
const copyNamed = (runbook: string) =>
  inPlaces(runbook, ['restoreTest', 'oldNight', 'download'], (texts) => [
    ...(['restoreTest', 'oldNight', 'download'] as const)
      .filter((name) => !has(texts[name], RELIED) || !has(texts[name], MADE))
      .map((name) => `${name} doesn’t take both of the backup’s lines for the month’s copy`),
    ...(/its parts first and its\s+seal last/.test(texts.restoreTest)
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
 * A name put under one of tonight's monthly/ names failed the copy with a reason that never said
 * so, and the RUNBOOK sent every such alert to wait for the next night (Stop C's second re-review,
 * finding R1): Last night's backup quotes each reason backup.sh gives a step of the copy and the
 * lines that stop a night on a planted name, and sends a lock's refusal or the same step night after
 * night to the stolen-token steps, whose list takes it so; the restore test's remedy says no night
 * was whole only of nights that failed before their seal, and waits for a night of the month.
 */
const copySteps = (runbook: string, backup: string) => {
  const reasons = copyReasons(backup);
  const endings = plantedEndings(backup);
  return [
    ...(reasons.length ? [] : ['backup.sh gives the month’s copy no step of its own']),
    ...(endings.length
      ? []
      : ['backup.sh stops no night on a name of its copy already in monthly/']),
    ...inPlaces(runbook, ['lastNight', 'restoreTest', 'stolen'], (texts) => {
      const night = flat(texts.lastNight);
      const test = flat(texts.restoreTest);
      const taken = part(flat(texts.stolen), 'Take it as stolen when', "shouldn't be.") ?? '';
      return [
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
 */
const rewindRoute = (runbook: string) =>
  inPlaces(runbook, ['recovery', 'drill'], ({ recovery, drill }) => {
    const steps = flat(recovery);
    return [
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
    expect(rootReach(rewrapped)).toEqual([]);
    expect(backupStopped(rewrapped)).toEqual([]);
    expect(listApart(rewrapped)).toEqual([]);
    expect(copyNamed(rewrapped)).toEqual([]);
    expect(copySteps(rewrapped, BACKUP)).toEqual([]);
    expect(baseRefusals(rewrapped, PITR)).toEqual([]);
    expect(cutAdvice(rewrapped, PITR)).toEqual([]);
    expect(rewindRoute(rewrapped)).toEqual([]);
  });
});
