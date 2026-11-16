import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SIGNING_PAIR_CHECK } from '../../scripts/vps-kit.mts';

/**
 * The steps of docs/RUNBOOK.md's "The shared server (VPS)" that no script runs: the owner follows
 * them by hand, on the server or in a disaster, so a step that went missing would show only then.
 * These text rules pin the procedure fixes of Stop C's re-review (docs/DECISIONS.md VPS-60 to
 * VPS-65 and VPS-67): every backup.sh run by hand comes right after a settings archive made for it,
 * and a new server enables the archive's timer (finding V3); disaster recovery's step 2.4 puts the
 * signing key's private half in, and step 4 stops backup until db runs (V4) and checks the signing
 * pair with SIGNING_PAIR_CHECK, character for character (V2); step 2.2 takes a night from before a
 * theft of the signing key with the stolen key's file (V1); the key list is kept in a file of its
 * own, never in the age key's (design note 4); the month's copy is named by either of the
 * backup's lines (B1); and the drill names each of pitr.sh's refusals of a base whose timeline a
 * rewind left (M1). Every rule also refuses a copy with one mistake, as tests/unit/vps-kit.test.ts
 * does, among them the RUNBOOK's text as it was before the re-review.
 */

const RUNBOOK = readFileSync(join('docs', 'RUNBOOK.md'), 'utf8');
const PITR = readFileSync(join('deploy', 'vps', 'backup', 'pitr.sh'), 'utf8');

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
  start: ['\n  6. `wal-spool` must be new', '\n  7. '],
  rerun: ['\n  9. The key off the ramfs', '### A stolen or leaked bucket token (VPS)'],
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

/**
 * Each line of `text` that runs backup.sh: its line number, whether it is the by-hand command alone
 * on a line of a command block, and whether an earlier line of that same block makes the settings
 * archive.
 */
function byHandRuns(text: string): { line: number; inBlock: boolean; archived: boolean }[] {
  const runs: { line: number; inBlock: boolean; archived: boolean }[] = [];
  let block: string[] | undefined;
  text.split('\n').forEach((line, at) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      block = block ? undefined : [];
      return;
    }
    if (line.includes('/usr/local/bin/backup.sh')) {
      runs.push({
        line: at + 1,
        inBlock: block !== undefined && trimmed === BY_HAND,
        archived: block?.includes(ARCHIVE) ?? false,
      });
    }
    block?.push(trimmed);
  });
  return runs;
}

/**
 * backup.sh fails a night whose settings archive is more than 2 hours old and seals none, and the
 * host makes one at 20:20 UTC only: so every backup.sh the RUNBOOK runs by hand is the command in a
 * block of its own, after the archive's start, in each place that runs one (Stop C's re-review,
 * finding V3); and a new server enables the archive's timer once .env is in place.
 */
const archiveFirst = (runbook: string) => [
  ...byHandRuns(runbook).flatMap(({ line, inBlock, archived }) =>
    !inBlock
      ? [`line ${line} runs backup.sh by hand outside a command block of its own`]
      : !archived
        ? [`line ${line} runs backup.sh by hand with no settings archive made before it`]
        : [],
  ),
  ...inPlaces(runbook, ['lastNight', 'drill', 'rerun', 'theft', 'walAlerts'], (texts) =>
    Object.entries(texts)
      .filter(([, text]) => !byHandRuns(text).some((run) => run.inBlock && run.archived))
      .map(([name]) => `${name} runs no backup.sh by hand after a settings archive`),
  ),
  ...inPlaces(runbook, ['recovery'], ({ recovery }) =>
    recovery.includes(TIMER)
      ? []
      : ['disaster recovery never enables the settings archive’s timer'],
  ),
];

/** The one-off the owner runs, with SIGNING_PAIR_CHECK between its quotes. */
const PAIR_COMMAND = `sudo app-compose menumesh run --rm --no-deps -T backup sh -c '${SIGNING_PAIR_CHECK}'`;
/** What SIGNING_PAIR_CHECK prints for a pair: its one echo to stdout, every other one to stderr. */
const PAIR_SIGNS = /echo "([^"]+)";/.exec(SIGNING_PAIR_CHECK)?.[1] ?? '';

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
      ...(keyList.includes('`BACKUP_SIGNING_KEY`') && keyList.includes('password manager')
        ? []
        : ['step 2.4 doesn’t put in BACKUP_SIGNING_KEY’s private half from the password manager']),
      ...(backupImage.includes(PAIR_COMMAND)
        ? []
        : ['step 4 doesn’t check the signing pair with SIGNING_PAIR_CHECK as it is']),
      ...(PAIR_SIGNS && backupImage.includes(`\`${PAIR_SIGNS}\``)
        ? []
        : ['step 4 doesn’t say what the signing pair’s check prints for a pair']),
      ...(rotation.includes('password manager') && /Disaster recovery,\s+step 4/.test(rotation)
        ? []
        : ['Rotation doesn’t keep the new private key in the password manager and check the pair']),
    ],
  );

/**
 * After a theft of the signing key the kept list takes only the nights made since, and a night of
 * the new key holds an archive of whatever a host reached as root held: so step 2.2 takes the night
 * from before the trouble, its versions of then made current first, checked with the stolen key's
 * file, which the theft's step 5 keeps apart (finding V1).
 */
const theftNight = (runbook: string) =>
  inPlaces(runbook, ['download', 'check', 'theft'], ({ download, check, theft }) => [
    ...(check.includes("pnpm vps:verify-night <id> <folder> --keys <the stolen key's file>")
      ? []
      : ['step 2.2 doesn’t check a night from before a theft with the stolen key’s file']),
    ...(/before the trouble[^.]*\s+the current\s+ones again/.test(download)
      ? []
      : ['step 2 doesn’t make the night’s versions of before the trouble current first']),
    ...(/reached as\s+root/.test(check)
      ? []
      : ['step 2.2 doesn’t say why a night of the new key is not the one after a reach as root']),
    ...(/marked\s+stolen/.test(theft)
      ? []
      : ['the theft’s step 5 doesn’t keep the stolen key apart, marked stolen, out of the list']),
  ]);

/**
 * On a new server app-deploy's switch starts backup before db exists, whose shipper then alerts
 * every hour and whose night fails (finding V4): step 4 stops it right after the deploy and before
 * the pair's check, and step 6 starts it after db.
 */
const backupStopped = (runbook: string) =>
  inPlaces(runbook, ['backupImage', 'start'], ({ backupImage, start }) => {
    const deployed = backupImage.indexOf('app-deploy menumesh backup');
    const stopped = backupImage.indexOf('sudo app-compose menumesh stop backup');
    const checked = backupImage.indexOf(PAIR_COMMAND);
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
      .filter((name) => !texts[name].includes(RELIED) || !texts[name].includes(MADE))
      .map((name) => `${name} doesn’t take both of the backup’s lines for the month’s copy`),
    ...(/its parts first and its\s+seal last/.test(texts.restoreTest)
      ? ['the restore test still copies a night to monthly/ by hand']
      : []),
  ]);

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
            !drill.includes(
              `\`the base backup of <id> is of the timeline X, …, which was left for a later one at …, ${ending}\``,
            ),
        )
        .map((ending) => `the drill’s failure lines don’t name “${ending}”`),
    ),
  ];
};

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

  it('takes a night from before a theft of the signing key with the stolen key’s file, kept apart (finding V1)', () => {
    expect(theftNight(RUNBOOK)).toEqual([]);
    // As before the re-review: step 2 had no theft case, the kept list alone.
    const before = swap(
      swap(
        RUNBOOK,
        part(RUNBOOK, '        After a theft of the signing key', '     3. **Unpack**') ?? '',
        '',
      ),
      part(
        RUNBOOK,
        ' For a night from before a theft of the signing key (2.2),',
        ' Both come from',
      ) ?? '',
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
});
