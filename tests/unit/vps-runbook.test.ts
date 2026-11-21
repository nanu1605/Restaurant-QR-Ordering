import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CADDY, SIGNING_PAIR_CHECK } from '../../scripts/vps-kit.mts';

/**
 * The steps of docs/RUNBOOK.md's "The shared server (VPS)" that no script runs: the owner follows
 * them by hand, on the server or in a disaster, so a step that went missing would show only then.
 * These text rules pin the procedure fixes of Stop C's re-reviews (docs/DECISIONS.md VPS-60 to
 * VPS-65, VPS-67, VPS-68 to VPS-76 and VPS-78 to VPS-108): every backup.sh run by hand comes right
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
 * newest backup public key in .env, whatever the archive held (the fifth re-review's M4), before
 * the conf is checked against that same key (the seventh re-review's design notes); the key
 * list is kept in a file of its own, never in the age key's (design note 4); the month's copy is
 * named by either of the backup's lines (B1), each step of it that fails is quoted, with what it
 * found, and the way to the stolen-token steps (R1), where a line, an alert or a ping only keeps
 * the night it names and every other id is judged by its seal alone, downloaded byte for byte and
 * checked with each list, never by the journal (H1, and the fifth re-review's M2 and M3, which undo
 * E1's and K2's deletion of the names an alert lists), and step 3 lifts no lock after a reach as
 * root until the rebuild (the fifth re-review's M1), when step 2 is done again, as root could write
 * until then (the sixth re-review's theft design note 3), only after the revocation (the seventh
 * re-review's design notes); under versioning step 2 puts back every
 * version written over the backup's own, or deleted, whether or not a line keeps its night (the
 * sixth re-review's P2), but for the delete markers of the backup's own removal, a seal's version
 * taken from the backup's own run and two that verify taking their key for stolen, what was put
 * over deleted rather than copied back where it can be (the seventh re-review's R3, R6 and R5); a
 * night a restore test or drill takes that no
 * record names, one stamped later than now and one passed over are signs of theft, and a seal a
 * list verifies that no record names takes its key for stolen (the sixth re-review's P1, which
 * puts back the sign the fifth took away), those records being the journal's lines over its 180
 * days, never a Telegram message, and after a rebuild only a ping from the server's own address
 * inside the night's window, and only where they reach the seal's stamp, the key found by trying
 * each of the list alone, the drill's count held, once a key has left the list, to the first
 * drill's since, and the drill's night checked as the restore test's (the seventh re-review's R1,
 * R2, H1 and H2, and its theft design notes), the server's own pings counted on the same server
 * too, the journal's reach read off its first line, a ping's window run to the next night's, a
 * night that sent no ping taking no key, and only pings naming different ids in one window a sign
 * (the eighth re-review's T1, T2, H1 and H2), and every key of the list on the server since the
 * trouble kept apart with the stolen one, the list's first among them (T3), and disaster
 * recovery's night named only by a ping from the old server's own address inside its window, the
 * night a point-in-time recovery took checked before db starts (T4), and after a rebuild a night
 * that sent no ping tied to its nightly's slot, a run by hand's ping not counted (the ninth
 * re-review's V1), a ping's window run to a day after its stamp (H1), and step 5's night checked
 * against the records as the stolen-token step 2 reads them (V3); the drill names each of
 * pitr.sh's refusals of
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
 * N2, N4 and N5), the release that stayed live read off deploys.log before step 7's own deploy
 * (the seventh re-review's Q1), a `migrate: applied` line left out for its commit alone (Q2), and
 * the owner's note of the day asked for at each deploy and rollback by hand (its deploy notes),
 * holding when the release went live as well as when its deploy began, which a new server's step 7
 * counts a release live by, from the notes of each deploy since the archive (the eighth
 * re-review's S1 and deploy design notes). Every rule also refuses a copy with one mistake, as
 * tests/unit/vps-kit.test.ts does, among them the RUNBOOK's text as it was before the fix. Every
 * phrase is compared with its white space folded, so a sentence wrapped again is still found, and a
 * place whose end is missing is reported, never read to the end of the section. Since Stop D they
 * also pin the cut-over's order (docs/DECISIONS.md VPS-113 to VPS-120): Vercel's records DNS only
 * and written down for the way back, the leak test through a temporary record before any app
 * record moves, the staging night's switches, and Vercel's cron jobs, CRON_SECRET and the hosted
 * project's backup kept for the 14 days of the way back, which the first real write on the server
 * ends; and since Stop D's review (VPS-123 to VPS-129) the origin test of authenticated origin
 * pulls for every host the site file serves, right after it goes in, scheduler-staging only from
 * the staging night, once Vercel staging's cron jobs are off and web-staging runs their commit,
 * each earlier command that would make it saying so, part 1's count in one statement, the leak
 * test served by MenuMesh's own pieces, Caddy recreated only in the shared server's window,
 * VPS_DEPLOY_STAGING left off at First install, step 17, the merge of the staging night's step 6,
 * a later production night that keeps the first night's admin and types again just what hosted
 * changed, and the Vercel rules kept until their parts retire. Since the server team's review
 * (VPS-135 to VPS-140) they also pin the redaction file right after the conf, the edge in its order
 * with edge.env merged and Caddy recreated once, checked before the staging night, origin pulls
 * from the owner's own CA, the first container only after the server team's word on theirs, the
 * leak test's container by image digest and flags, the drills on the second weekend, and no copy
 * of a secret left in ~/incoming; and since the copy of their files at their 66c8c61 (VPS-142),
 * step 11's snippets.caddy from their repository, which holds tls_menumesh, and the staging night's
 * stop on an exit 0. Since the RUNBOOK follows their merged edge.md §5 and §6 (VPS-143), they also
 * pin step 11's edge.env merged in their form and checked by its names and lengths before the
 * install, Rotation's and disaster recovery's merges, the recreate checked with its way back as the
 * vendored app-apply keeps it, the edge networks checked at step 15, Jainav's hosts refusing a
 * client without a certificate before db, and the leak test's copy of the installed site file, its
 * alert, its checks and its clean-up in their order. Since the last review round (VPS-145) they
 * also pin step 11's CSR key, shredded only once its certificate is in, and the digest pin's steps
 * before edge.env; since the server team's fix of hostwatch's alerts (VPS-146), the recreate
 * night's wait for their kit on the server to hold it, by their word in their chat, both before
 * that night's edge.env lines, on an earlier night or as that night's first step; and since the
 * server team installs their snippets.caddy themselves (VPS-147), step 11's comparison of the
 * server's file with a Git Bash copy of the commit they name, its sum checked before the scp,
 * before any edge config and before edge.env, and the stop on DIFFERENT for their answer in their
 * chat, given the live file's sum, the copy's and its commit, which the staging night's exit 0 and
 * disaster recovery take too.
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

/** The sentences of `text`, its white space folded, each ending at a full stop before a space. */
const sentences = (text: string) => flat(text).split(/(?<=\.) /);

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
  deploys: ['### Deploys on the VPS', '### The scheduler (VPS)'],
  // The cut-over (Stop D): First install's last step, the six parts, and the five before the last.
  lastStep: ['\n22. ', '### Secrets (VPS)'],
  zoneMove: ['#### 1. Before the server', '#### 2. The server rehearsal'],
  rehearsal: ['#### 2. The server rehearsal', '#### 3. The staging night'],
  stagingNight: ['#### 3. The staging night', '#### 4. The production night'],
  productionNight: ['#### 4. The production night', '#### 5. The way back'],
  wayBack: ['#### 5. The way back', '#### 6. After the 14 days'],
  retirement: ['#### 6. After the 14 days', '### Deploys on the VPS'],
  cutover: ['### The server rehearsal and the cut-over', '#### 6. After the 14 days'],
  // Stop D's review: First install's steps 11, 17 and 20, part 1's count, the staging night's site
  // file and leak test, and the web image's rule for after the move.
  edgeStep: ['\n11. The edge:', '\n12. `/srv/menumesh`'],
  gitHub: ['\n17. **GitHub**', '\n18. '],
  schedulers: ['\n20. ', '\n21. '],
  count: ['1. **Hosted production, read-only.**', '2. **The zone, from GoDaddy'],
  // A prefix, so that it finds the step as the server team's review left it (the site file alone)
  // and as cd6a733 had it (the site file and the redaction file).
  siteNight: ['1. **The site file', '2. **The leak test**'],
  leakTest: ['2. **The leak test**', '\n3. **The'],
  afterMove: ['- **After the move:**', '- **Checking an image here**'],
  // Stop D's re-review: the commands outside First install that could make scheduler-staging early
  // (Secrets (VPS)'s Rotation and the scheduler's After a change; disaster recovery is `recovery`).
  envRotation: ['**Rotation.** After changing `.env`', '- The backup key: a new pair'],
  schedulerChange: ['**After a change:**', '### Backups and restore (VPS)'],
  // The server team's review (VPS-135 to VPS-140): First install's steps 8, 9, 14 and 16, the
  // staging night's Before it, and disaster recovery's edge.
  zoneStep: ['8. **The zone:**', "**The server's admin**"],
  confStep: ['\n9. `/etc/apps/menumesh.conf`', '\n10. The deploy user'],
  envStep: ['\n14. The env files', '\n15. '],
  dbStep: ['\n16. ', '\n17. **GitHub**'],
  beforeStaging: ['#### 3. The staging night', 'Then, in order:'],
  recoveryEdge: ['\n  8. The edge', '\n  9. The key off the ramfs'],
  // The server team's merged edge.md (VPS-143): First install's step 15 and Rotation's bullet for
  // staging's password.
  composeStep: ['\n15. `sudo app-apply menumesh compose', '\n16. '],
  stagingPassword: ["- Staging's password", '- The deploy key or the Access token'],
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
 * key's file refuses. Where an older key of the list signed, step 2 put the list's first key alone
 * in that file, and the other places still kept only the older keys that may have leaked: a key
 * between them on the server since the trouble went into no file (Stop C's eighth re-review,
 * finding T3). The file now holds the stolen key and every other key of the list whose private half
 * was on the server since the trouble could have begun, the list's first among them, in sub-step 1's
 * format line, sub-step 4, 2.2 and Rotation, and step 2 says why.
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
        '`BACKUP_SIGNING_PUBLIC_KEY=<the stolen key> <each key of the list it does not keep>`',
      ) ||
      has(
        theft,
        '`BACKUP_SIGNING_PUBLIC_KEY=<the stolen key> <each older key that may have leaked>`',
      )
        ? []
        : [
            'the theft’s step 5 doesn’t keep an older key that may have leaked apart with the stolen one',
          ]),
      ...(has(
        theft,
        "The stolen key and every other key of the list whose private half was on the server since the trouble could have begun, the list's first among them, are kept apart",
      ) &&
      has(theft, 'Then recover it, when a key of that file signed it') &&
      has(
        check,
        "That file holds the stolen key and every other key the list held whose private half was on the server since the trouble could have begun, its first among them (that section's step 5)",
      ) &&
      has(
        rotation,
        "So does every other key of the list whose private half was on the server since the trouble could have begun, the first among them where the thief's was an older one",
      ) &&
      !has(theft, '<each older key that may have leaked>') &&
      !has(rotation, 'So does an older key whose private half may have leaked with it')
        ? []
        : [
            'the stolen key’s file leaves out a key of the list that was on the server since the trouble, the list’s first or one between, so its nights from before the trouble are refused by every list',
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
        'signed: one that an older key of the kept list signed is checked with the kept list',
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
 * made before the trouble could have begun; disaster recovery's step 2 says so too. Its window ran
 * about 2 hours, short of a long base's ping, and two lines in it, a ping curl sent twice among
 * them, took the night for the thief's (Stop C's eighth re-review, findings T1 and H1): the window
 * runs to the next night's, and only two lines naming different ids, but for a run by hand, do.
 * And disaster recovery's step 2 still named the night whose settings archive it unpacks from any
 * ping in the monitor's log, and from Telegram's failure lines, both of which a leaked .env can send
 * (finding T4): it reads only a ping from the old server's own address inside its night's window, a
 * ping from elsewhere sends the owner to the theft's step 5 first, Telegram's lines name no night
 * there, and step 5 checks the night a point-in-time recovery took before db starts. But a window
 * to the next night's ended before the ping of a run by hand begun just before a nightly (Stop C's
 * ninth re-review, finding H1): both windows run to a day after the stamp. And step 5 read the
 * records as disaster recovery's step 2 does, the journal's lines alone on the same server, so a
 * night whose line journald dropped, named by its own ping, was a sign of theft there (finding
 * V3): it reads them as the stolen-token step 2 does, the server's own pings among them.
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
      "or an id that no record from before names, mean a night of the thief's: take the night before it",
    ) && has(theft, 'Two `backup` lines')
      ? []
      : ['the theft’s step 5 doesn’t pass over a night a thief may have pinged']),
    ...(has(
      theft,
      "Two `backup` lines naming different ids in one night's window but for a run by hand, or",
    ) && !has(theft, "Two `backup` lines in one night's window")
      ? []
      : [
          'the theft’s step 5 takes a ping that curl’s retry sent again, the same line, for a night of the thief’s',
        ]),
    ...((has(
      theft,
      "from the server's own address and inside its night (from its stamp to the next night's)",
    ) ||
      has(
        theft,
        "from the server's own address and inside its night (from its stamp to a day after it, so a long base's late ping counts)",
      )) &&
    !has(theft, '(from its stamp to about 2 hours after)')
      ? []
      : [
          'the theft’s step 5 names a night from before the trouble only by a ping within about 2 hours of its stamp, though a long base pings later',
        ]),
    ...(has(
      theft,
      "inside its night (from its stamp to a day after it, so a long base's late ping counts)",
    ) &&
    has(
      recovery,
      "inside its night's window (from its stamp to a day after it, so a long base's late ping counts), as A stolen or leaked",
    ) &&
    !has(theft, "to the next night's") &&
    !has(recovery, "to the next night's")
      ? []
      : [
          'the theft’s step 5 and disaster recovery’s step 2 end a ping’s window at the next night’s stamp, so a run by hand begun just before a nightly, which pings after that stamp, names no night',
        ]),
    ...(has(recovery, 'named only from records made before the trouble could have begun')
      ? []
      : ['disaster recovery’s step 2 names a night from before a theft from any record']),
    ...((has(
      recovery,
      "where each ping carries that line (First install, step 3), and in it only a ping from the old server's own address inside its night's window (from its stamp to the next night's), as A stolen or leaked bucket token (VPS), step 2, reads it",
    ) ||
      has(
        recovery,
        "where each ping carries that line (First install, step 3), and in it only a ping from the old server's own address inside its night's window (from its stamp to a day after it, so a long base's late ping counts), as A stolen or leaked bucket token (VPS), step 2, reads it",
      )) &&
    has(
      recovery,
      "a ping from elsewhere, or two naming different ids in one night's window but for a run by hand, is a sign the `.env` leaked, so follow that section's step 5 before anything of the bucket is downloaded",
    ) &&
    has(recovery, "Telegram's failure lines, which that `.env` can send too, name no night here") &&
    !has(recovery, "(First install, step 3), and Telegram's failure lines")
      ? []
      : [
          'disaster recovery’s step 2 names the night whose settings archive it unpacks from any ping in the monitor’s log, or a Telegram line, which a leaked .env can send',
        ]),
    ...(has(
      recovery,
      "Whichever night it took, check the one its line `pitr: to <point>, from the night of <id>: …` names against the backup's own records,",
    ) &&
    has(
      recovery,
      "before step 6 starts `db`: one they don't name, but for a night that sent no ping, as the monitor alerted that day (A stolen or leaked bucket token (VPS), step 2), is a sign of theft, and `db` stays stopped while that section is followed",
    )
      ? []
      : [
          'disaster recovery’s step 5 starts db on the night a point-in-time recovery took without checking it against the backup’s own records',
        ]),
    ...(has(
      recovery,
      "names against the backup's own records, as A stolen or leaked bucket token (VPS), step 2, reads them (on the same server the journal's lines and the server's own pings inside the night's window), before step 6 starts `db`",
    ) && !has(recovery, 'records, as step 2 reads them, before step 6')
      ? []
      : [
          'disaster recovery’s step 5 reads the records as its own step 2 does, the journal’s lines alone on the same server, so a night named only by its own ping is a sign of theft there',
        ]),
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
 * no token (finding P3). Two orders no rule held are held now (Stop C's seventh re-review, its
 * design notes): 2.4 makes .env's key the newest before the conf is checked against "that same
 * key", never the archive's, and sub-step 5 does step 2 again only after the revocation; and the
 * alerts sub-step 5 quotes are held to the words wal-ship.sh and backup.sh send.
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
      const newest = keys.indexOf(
        '`BACKUP_AGE_RECIPIENT` becomes the newest backup public key here',
      );
      const revoked = fifth.indexOf(
        "step 1's token is revoked before Disaster recovery, step 2, reads the bucket",
      );
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
        ...(newest >= 0 &&
        newest < conf &&
        keys.includes(
          'first check that it is that same key: the two commands print the same `age1…` key',
        ) &&
        !keys.includes('that same key, the archive')
          ? []
          : [
              'step 2.4 checks the admin’s conf against the backup key the archive held, or before .env holds the newest one',
            ]),
        ...(revoked >= 0 &&
        revoked < fifth.indexOf('so only then is step 2 done again, its versions among them')
          ? []
          : [
              'the theft’s step 5 does step 2 again before step 1’s token is revoked, while root may still write with it',
            ]),
        ...(fifth.includes('that is expected, and it gets no token')
          ? []
          : [
              'the theft’s step 5 says nothing of what the reached server alerts once step 1’s token is revoked',
            ]),
        ...(fifth.includes('`the upload of <walfile> to the bucket failed (rclone)`') &&
        fifth.includes('its nightly backup fails at `reaching the bucket`')
          ? []
          : [
              'the theft’s step 5 quotes alerts the reached server never sends once step 1’s token is revoked',
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
 * wal/ names that stay are pinned too (theft design notes 1 and 2). But the records the trigger and
 * step 2 read took in Telegram's messages and any ping of the monitor's, both of which a leaked
 * .env can send, so a holder's own ping kept their night from the sign and their key from being
 * taken (Stop C's seventh re-review, finding R1); every month's copy older than the journal's 180
 * days and the monitor's newest pings took its key for stolen (R2); nothing said which key of a
 * list signed (H1); and the drill's count of objects passed over takes in, for good, the history
 * files of a key that has left the list (H2). The records are now the journal's lines over its
 * 180 days on the same server, never a Telegram message, and after a rebuild only a ping from the
 * server's own address inside the night's window; only a seal whose stamp they reach takes its
 * key for stolen; each key of the list is tried alone, and where an older one signed, the list's
 * first, which sub-step 1 kept nowhere, goes into the stolen key's file with it (seen while fixing
 * H1); once a key has left the list the count is held to the first drill's since; and the drill's
 * night is checked as the restore test's is. But after a rebuild a night that failed after its seal,
 * or whose ping was lost, was named by nothing the records count, so its key was taken for stolen
 * (Stop C's eighth re-review, finding T1); the journal's reach was its 180 days, though a full
 * journal or a vacuum cuts it short (T2); a ping curl sent twice was two pings in a window, a sign
 * (H1); and on the same server a night whose line journald dropped to its rate limit looked planted
 * (H2). Now a night that sent no ping, as the monitor alerted that day, takes no key; the reach is
 * read off the first line printed; the window runs to the next night's, the server's own address is
 * the old server's for its nights, and a ping names the month's copy its line names; only pings
 * naming different ids in a window are a sign; and the server's own pings count on the same server.
 * But the day on which the monitor got no ping was never said, so after a rebuild a run by hand
 * the morning after a failed night, whose ping fell in that night's window and on its day, took
 * the night's key for stolen (Stop C's ninth re-review, finding V1), and the clause that makes the
 * journal's lines the records on the same server was held by no rule (its theft design notes).
 * Now such a night after a rebuild is one stamped from a nightly's 20:30 UTC to the next, where no
 * ping from the old server's address names a night of that stamp, a run by hand's ping not
 * counted, and the monitor's alert is not needed where a run by hand pinged first. And a window to
 * the next night's ended before the ping of a run by hand begun just before a nightly (H1): it runs
 * to a day after the stamp.
 */
const oldCopies = (runbook: string) =>
  inPlaces(
    runbook,
    ['stolen', 'cleanup', 'remove', 'drill'],
    ({ stolen, cleanup, remove, drill }) => {
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
        ...(taken.includes('never a Telegram message; after a rebuild,') &&
        taken.includes("pings from the server's own address inside the night's window") &&
        has(cleanup, 'never a Telegram message') &&
        (has(cleanup, "only where the journal can't reach, after a rebuild, those pings alone") ||
          has(
            cleanup,
            "only where the journal can't reach, after a rebuild, the backup monitor's log, and in it only a ping from the server's own address inside the night's window",
          )) &&
        has(cleanup, "from the server's own address inside the night's window") &&
        has(cleanup, 'is itself a sign the `.env` leaked (step 5)') &&
        !has(cleanup, "(the journal's lines and alert lines, and the backup monitor's log") &&
        !taken.includes("(its journal or alert lines; after a rebuild, the backup monitor's log)")
          ? []
          : [
              'the stolen-token steps count a ping a leaked .env can send, or a Telegram message, among the backup’s records, so a night of the holder’s goes unseen',
            ]),
        ...(taken.includes(
          "(on the same server the journal's lines and the backup monitor's pings from the server's own address inside the night's window, never a Telegram message; after a rebuild, those pings alone: step 2)",
        ) &&
        has(
          cleanup,
          "never a Telegram message, and the backup monitor's pings from the server's own address inside the night's window",
        ) &&
        has(
          cleanup,
          'which none can send without root, so a night whose line journald dropped to its rate limit is named all the same',
        ) &&
        has(cleanup, 'A ping from elsewhere, two `backup` pings')
          ? []
          : [
              'the stolen-token steps count on the same server the journal’s lines alone, so a night whose line journald dropped to its rate limit looks planted and its own ping a sign of a leak',
            ]),
        ...((has(
          cleanup,
          "and not a night that sent no ping, killed or failed after its seal or its ping lost, as the monitor alerted that day: on the same server the journal's failure line names a failed one, and after a rebuild a night of the old server's on a day the monitor got no ping from its address is judged by its seal alone and is no sign of theft",
        ) ||
          has(
            cleanup,
            "and not a night that sent no ping, killed or failed after its seal or its ping lost, as the monitor alerted that day unless a run by hand pinged first: on the same server the journal's failure line names a failed one, and after a rebuild a night of the old server's stamped from a nightly's 20:30 UTC to the next,",
          )) &&
        !has(
          cleanup,
          'and not a night killed after its seal, which leaves no line at all: the monitor alerted on it',
        )
          ? []
          : [
              'the stolen-token steps take the key of a night that failed after its seal, or lost its ping, for stolen after a rebuild, where no record they count names it',
            ]),
        ...(has(
          cleanup,
          "as the monitor alerted that day unless a run by hand pinged first: on the same server the journal's failure line names a failed one, and after a rebuild a night of the old server's stamped from a nightly's 20:30 UTC to the next, where no ping from its address names a night of that stamp (a run by hand's ping names its own, stamped at another time, and does not count), is judged by its seal alone and is no sign of theft",
        ) && !has(cleanup, 'on a day the monitor got no ping from its address')
          ? []
          : [
              'the stolen-token steps take the key of a night that sent no ping for stolen after a rebuild once a run by hand pinged after it, as they tie that night to no nightly',
            ]),
        ...(has(cleanup, "On the same server those records are the journal's lines above")
          ? []
          : [
              'the stolen-token steps leave the journal’s lines out of the records on the same server, so a night whose ping was lost looks planted',
            ]),
        ...((has(
          cleanup,
          "(from its stamp to the next night's, so a long base's late ping counts)",
        ) ||
          has(cleanup, "(from its stamp to a day after it, so a long base's late ping counts)")) &&
        has(
          cleanup,
          "the server's own address being the old server's for nights before the rebuild",
        ) &&
        has(cleanup, "Such a ping names its own night and the month's copy its line names") &&
        !has(cleanup, '(from its stamp to about 2 hours after)')
          ? []
          : [
              'the stolen-token steps hold a ping to about 2 hours after its night’s stamp, take the server’s own address for the rebuilt one’s, or never read a ping as naming the month’s copy its line names',
            ]),
        ...(has(
          cleanup,
          "inside the night's window (from its stamp to a day after it, so a long base's late ping counts)",
        ) && !has(cleanup, "to the next night's")
          ? []
          : [
              'the stolen-token steps end a ping’s window at the next night’s stamp, so a run by hand begun just before a nightly, which pings after that stamp, is named by nothing',
            ]),
        ...(has(
          cleanup,
          "over its 180 days, or from the first line the command prints where it holds less (a full journal or a vacuum cuts it short: hostwatch's daily `journal:` line gives its oldest line)",
        ) &&
        has(
          cleanup,
          "an alert naming a night inside the journal's reach that the journal does not name, on a day journald dropped no lines (hostwatch's daily `suppressed:` line)",
        ) &&
        !has(cleanup, 'naming a night the whole journal does not name')
          ? []
          : [
              'the stolen-token steps take the journal’s reach for its 180 days, though a full journal or a vacuum cuts it short, or an alert past that reach, or of a day journald dropped lines, for a sign',
            ]),
        ...(has(
          cleanup,
          "two `backup` pings naming different ids in one night's window but for a run by hand",
        ) && !has(cleanup, "two `backup` pings in one night's window")
          ? []
          : [
              'the stolen-token steps take a ping that curl’s retry sent again, the same line, for a sign the .env leaked',
            ]),
        ...(has(cleanup, 'backup --since -180d --utc -o short-iso') &&
        has(cleanup, 'where those records are whole and reach its stamp (no reach as root') &&
        has(
          cleanup,
          "An older month's copy, stamped before the records reach, is judged by its seal alone and is no sign of theft",
        )
          ? []
          : [
              'the stolen-token steps take the key of a month’s copy older than the records for stolen',
            ]),
        ...(has(
          cleanup,
          "To find which key of a list of several signed a seal, check it with each key of the list alone, in a file of one key each: only the signer's gets past the seal",
        )
          ? []
          : [
              'the stolen-token steps never say which key of a list signed a night the backup never ran',
            ]),
        ...(has(
          cleanup,
          "Where that is not the list's first key, as from an old copy of `.env`,",
        ) &&
        (has(cleanup, "the first goes into the stolen key's file with it (step 5)") ||
          has(cleanup, "the first among them, goes into the stolen key's file with it (step 5)"))
          ? []
          : [
              'the stolen-token steps keep the list’s first key nowhere when an older key of the list signed a night the backup never ran',
            ]),
        ...(has(
          cleanup,
          "Where that is not the list's first key, as from an old copy of `.env`, each other key of the list whose private half was on the server since the trouble could have begun, the first among them, goes into the stolen key's file with it (step 5)",
        ) && !has(cleanup, "the first goes into the stolen key's file with it")
          ? []
          : [
              'the stolen-token steps put only the list’s first key into the stolen key’s file with the one that signed, though every key of the list on the server since the trouble may have leaked',
            ]),
        ...(taken.includes(
          "`<n> objects passed over, not the backup's`, n above 0, or once a key has left the list, n above what the first drill since printed",
        )
          ? []
          : [
              'the stolen-token steps take the history files of a key that left the list for a sign of theft at every drill',
            ]),
        ...(has(
          drill,
          "Check that id against the backup's own journal line, as for the restore test",
        )
          ? []
          : [
              'the drill never checks the night it takes against the backup’s own records, though such a night is a sign of theft',
            ]),
        ...(has(
          cleanup,
          "but for the backup's own removal, which in a night's run removes what went up more than 30 days before in `daily/`, 366 days before in `monthly/` and 15 in `wal/`, never a history file",
        ) &&
        has(
          cleanup,
          "set during a night's run (from its stamp to its line in the journal), is that removal and stays",
        ) &&
        has(
          cleanup,
          "Only a marker over a younger version or a history file, or a second version not alike byte for byte, is someone else's",
        )
          ? []
          : [
              'the stolen-token steps take the delete markers the backup’s own removal leaves for someone else’s deletions, and put back what it removed',
            ]),
        ...(has(
          cleanup,
          "for a seal, the one that went up in the backup's own run, by its upload time against the night's stamp and its line in the journal, and that a list verifies as above",
        ) &&
        has(
          cleanup,
          'Two versions of a seal that a list verifies, not alike byte for byte, mean a key of that list signed one the backup never wrote: take that key for stolen (step 5), after which only a version from before the trouble counts',
        ) &&
        !has(cleanup, 'for a seal, the newest a list verifies')
          ? []
          : [
              'the stolen-token steps make current the newest seal a list verifies, a stolen key’s put over the backup’s own, and never take two that verify for a sign of theft',
            ]),
        ...(has(
          cleanup,
          "(by a stolen key's file only for a night from before its theft; after a leaked `.env`, step 5, only a version from before the trouble); for a part, the one whose size and sha256 its night's seal lists",
        ) && has(cleanup, 'for a WAL file, its first, as nobody can name one before its upload')
          ? []
          : [
              'the stolen-token steps put back a version of a seal, part or WAL file that may not be the backup’s',
            ]),
        ...(has(
          cleanup,
          'Delete what someone else put over it to make it current, where the provider allows, rather than copy it',
        )
          ? []
          : [
              'the stolen-token steps copy a WAL file back, which a recovery to a point past it then ends its chain at',
            ]),
      ];
    },
  );

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

/** The signs of theft a restore's night gives, as the sixth re-review's fixes left them (b003e13). */
const ROUND_7_SIGNS = [
  "restore test, drill or recovery takes a night that none of the backup's own records names (its",
  "journal or alert lines; after a rebuild, the backup monitor's log), names one stamped later than",
  'now (`restore: not taking the night of <id>, stamped later than now`), or passes over a night',
  "(`pitr: not taking the night of <id>: its seal …, so it is not the backup's`) or WAL objects",
  "(`<n> objects passed over, not the backup's`, n above 0) as not the backup's, when the",
].join('\n');

/** The stolen-token step 2's stolen key, as the sixth re-review's fixes left it (b003e13). */
const ROUND_7_STOLEN_KEY = [
  "   A seal a list verifies that no record of the backup names (the journal's lines and alert lines,",
  "   and the backup monitor's log, which outlives a rebuild) means, where those records are whole (no",
  '   reach as root, and no night of the 30 days killed after its seal, which leaves no line at all:',
  '   the monitor alerted on it), that a key of that list signed a night the backup never ran: take',
  '   that key for stolen (step 5). That id stays all the same, as any whose seal a list verifies.',
].join('\n');

/** The stolen-token step 2's versions, as the sixth re-review's fixes left them (b003e13). */
const ROUND_7_VERSIONS = [
  "   Where the bucket keeps versions (versioning, or S3 Object Lock), list each folder's versions too,",
  "   delete markers among them, with the admin login in the provider's dashboard: the backup writes",
  '   each name once, so a name with more than one version, or a delete marker, is one someone else',
  '   wrote over or deleted. For each such name, whether or not a line keeps its night, make current',
  "   again, with the admin login, its version that is the backup's: for a seal, the newest a list",
  "   verifies as above (by a stolen key's file only for a night from before its theft; after a leaked",
  '   `.env`, step 5, only a version from before the trouble); for a part, the one whose size and',
  "   sha256 its night's seal lists (`pnpm vps:verify-night` checks it, the seal and the settings",
  '   archive beside it); for a WAL file, its first, as nobody can name one before its upload (a cut',
  '   chain names one written over or deleted). A line only keeps an id from going, never a version',
  "   put over the backup's: step 4 then finds the night it tests whole.",
].join('\n');

/** The trigger's records, as the seventh re-review's fixes left them (fcad52d). */
const ROUND_8_TRIGGER = [
  "same server the journal's lines, never a Telegram message; after a rebuild, the backup monitor's",
  "pings from the server's own address inside the night's window: step 2",
].join('\n');

/** The stolen-token step 2's stolen key, as the seventh re-review's fixes left it (fcad52d). */
const ROUND_8_STOLEN_KEY = [
  '   A seal a list verifies that no record of the backup names means, where those records are whole',
  '   and reach its stamp (no reach as root, and not a night killed after its seal, which leaves no',
  '   line at all: the monitor alerted on it), that a key of that list signed a night the',
  '   backup never ran: take that key for stolen (step 5). On the same server those records are the',
  "   journal's lines above, over its 180 days, never a Telegram message; only where the journal can't",
  "   reach, after a rebuild, the backup monitor's log, and in it only a ping from the server's own",
  "   address inside the night's window (from its stamp to about 2 hours after), as sub-step 4 reads",
  "   it. An older month's copy, stamped before the records reach, is judged by its seal alone and is",
  '   no sign of theft. A ping or alert naming a night the whole journal does not name, or two',
  "   `backup` pings in one night's window but for a run by hand, is itself a sign the `.env` leaked",
  '   (step 5). To find which key of a list of several signed a seal, check it with each key of the',
  "   list alone, in a file of one key each: only the signer's gets past the seal, the others print",
  "   `is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys`. Where that is not the list's first key,",
  "   as from an old copy of `.env`, the first goes into the stolen key's file with it (step 5), as its",
  '   private half was on the server since the trouble could have begun. That id stays all the same,',
  '   as any whose seal a list verifies.',
].join('\n');

/** The theft's sub-step 4's records of a night from before, as the seventh re-review left them. */
const ROUND_8_NIGHT_BEFORE = [
  "      from the server's own address and inside its night (from its stamp to about 2 hours after),",
  "      or the old server's journal from then, unless root may have reached the server, as root can",
  "      write the journal; never a ping received since. Two `backup` lines in one night's window, or",
  "      an id that no record from before names, mean a night of the thief's: take the night before",
  '      it.',
].join('\n');

/** The stolen-token step 2's night that sent no ping, as the eighth re-review's fixes left it. */
const ROUND_9_NO_PING = [
  'and not a night that sent no ping, killed or failed after',
  "   its seal or its ping lost, as the monitor alerted that day: on the same server the journal's",
  "   failure line names a failed one, and after a rebuild a night of the old server's on a day the",
  '   monitor got no ping from its address is judged by its seal alone and is no sign of theft',
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
 * unpacked deploys.log naming it, or the owner's note of the day. That parenthesis also said the
 * line may wait for the end of the run, which psql's flush before each line it reads disproves
 * (Stop C's seventh re-review, finding Q2): it gives the commit alone as the reason.
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
      ...(steps.includes('(a `migrate: applied <file>` line comes only after its file committed)')
        ? []
        : [
            'step 5 says a `migrate: applied` line may wait for the end of the run, though psql writes it right after its file commits',
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
 * nothing more. Step 5 and Database migrations say the same. But item 3 read that release off the
 * last production line of deploys.log, which once item 1 has deployed is step 7's own, naming step
 * 1's release, so the newest release that stayed live never went out (Stop C's seventh re-review,
 * finding Q1): it is the last such line before step 7's deploy, the old image of step 7's own line.
 * The clauses the review found unpinned are held too: item 2's release live just before the bad
 * deploy and its "or at least before its migrations ran", item 3's "when that line is later than
 * that time", and item 1's images.env only after `latest` on the same server that ended neither at
 * a cut nor before deploys.log's last production line; and Production, step 2, and Rolling back by
 * hand ask for the owner's own note of the day, which a new server's steps 5 and 7 go by (the
 * deploy design notes). But that note held only when the deploy began, while a new server's items 1
 * and 3 decide by when a release went live, as deploys.log's line comes after its migrations: a
 * state inside a deploy's span got that release without them (Stop C's eighth re-review, finding
 * S1). The note now holds both times, each read off the server's own lines, in Production's bullet
 * and the rollback's, whose "did not stay live" is held too; step 7 counts a release of the notes
 * live by when it went live, step 5 keeping the begin time; and item 3 on a new server reads the
 * notes of each deploy since the archive, step 7's own not counted, not the note of the day alone
 * (its deploy design notes).
 */
const releaseDeployed = (runbook: string) =>
  inPlaces(
    runbook,
    ['release', 'recovery', 'migrations', 'deploys'],
    ({ release, recovery, migrations, deploys }) => {
      // Each note in its own bullet: Production's, and the rollback by hand's.
      const production =
        part(deploys, '- **Production**, by the owner:', '- **Rolling back by hand:**') ?? '';
      const rollback = part(deploys, '- **Rolling back by hand:**', '- **When to deploy:**') ?? '';
      return [
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
        ...(has(release, `${RELEASE_BY_TOKEN}\n\`\`\``) &&
        has(release, 'but not its migrate reference')
          ? []
          : [
              'step 7 deploys a release image no longer on the server without the token app-deploy needs to pull it',
            ]),
        ...(/migrate-<sha>/.test(release)
          ? ['step 7 deploys a release with a migrate reference']
          : []),
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
        ...(has(
          release,
          "On the same server that is the release `images.env`'s `WEB_IMAGE` named",
        ) &&
        has(release, "`WEB_IMAGE` named before step 7's deploy") &&
        has(release, 'that is neither `FAILED` nor `ROLLED BACK`') &&
        (has(
          release,
          "on a new server, the owner's own note of the day, never the **VPS release** runs",
        ) ||
          (has(
            release,
            "on a new server, the one the owner's own notes of each deploy since step 2's archive leave live",
          ) &&
            has(release, 'never the **VPS release** runs alone')))
          ? []
          : [
              'step 7 sends out again a release rolled back since, or takes the releases since from the VPS release runs alone',
            ]),
        ...(has(
          release,
          "on a new server, the one the owner's own notes of each deploy since step 2's archive leave live, step 7's own not counted, or with none since, the one that archive's `deploys.log` leaves live, read as on the same server, when it went live later than that time",
        ) &&
        has(
          release,
          "a release made since the archive is only in the owner's own notes of each deploy since it",
        ) &&
        !has(release, "the owner's own note of the day, never the") &&
        !has(release, "archive is only in the owner's own note of the day")
          ? []
          : [
              'step 7 takes a new server’s releases from the owner’s note of the day alone, step 7’s own deploy among them, though a state days back needs every deploy since',
            ]),
        ...(has(
          release,
          "On a new server the owner's notes count a release as live at a time, or as gone live since it, by the time it went live, as these lines do; step 5's bound goes by the time its deploy began",
        )
          ? []
          : [
              'step 7 counts a release of the owner’s notes live from when its deploy began, though its migrations may have committed after the state',
            ]),
        ...(has(release, 'in turn, oldest first')
          ? ['step 7 sends out again every release made since, a rolled-back one among them']
          : []),
        ...(has(
          release,
          "where the recovered state is from before a bad release's deploy began, or at least before its migrations ran (step 5)",
        ) &&
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
          : [
              'the way past the nights a rewind left doesn’t send the owner to step 7 for the release',
            ]),
        ...(has(
          release,
          "the new image of the last production line of `deploys.log` before step 7's deploy that is neither `FAILED` nor `ROLLED BACK` (the old image of step 7's own line), when that line is later than that time",
        ) &&
        !has(release, 'the new image of the last production line of `deploys.log` that is neither')
          ? []
          : [
              'step 7 reads the release that stayed live off deploys.log’s last production line, which after step 1’s deploy is step 7’s own',
            ]),
        ...(has(
          release,
          'In 3 the release that stayed live is then the one live just before that deploy began, read from `deploys.log` as in 1',
        )
          ? []
          : [
              'step 7 leaves out, after a recovery from before a bad release, the good release live just before its deploy',
            ]),
        ...(has(
          release,
          "After a recovery to `latest` on the same server, unless it ended at a cut (`PITR_ACCEPT_CUT`) or before `deploys.log`'s last production line",
        )
          ? []
          : [
              'step 7 takes images.env’s release after `latest` on a new server, or after WAL that stopped before deploys.log’s last production line, though the state lacks its migrations',
            ]),
        ...(has(production, 'Then note, off the server, the time the deploy began (UTC)') &&
        has(production, "that is the owner's own note of the day") &&
        has(rollback, 'Note it off the server too, as for a release (Production, step 2)') &&
        has(rollback, 'and that the one rolled back did not stay live')
          ? []
          : [
              'Production and Rolling back by hand never ask for the owner’s own note of the day, which a new server’s recovery goes by',
            ]),
        ...(has(
          production,
          'the time the deploy began (UTC), read from its `deploying` line (`sudo journalctl -t app-deploy --utc -o short-iso`) rather than from memory, the time it went live, from its new line in `deploys.log` (`sudo tail -1 /srv/menumesh/deploys.log`), the release and whether it stayed live',
        ) &&
        has(
          rollback,
          'the times it began and went live (UTC), the release brought back, and that the one rolled back did not stay live',
        ) &&
        !has(deploys, 'the time the deploy began (UTC), the release and whether it stayed live')
          ? []
          : [
              'Production and Rolling back by hand note only when a deploy began, so a new server counts a release live before its migrations committed',
            ]),
      ];
    },
  );

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

/** Disaster recovery's step 7, item 3, as the sixth re-review's fixes left it (b003e13). */
const ROUND_7_STAYED_LIVE = [
  "     3. **The release that stayed live**: if a release went live since the recovered state's",
  '        time and stayed live, the newest of them goes out again by Production, step 2, with its',
  '        own migrate reference, the one its **VPS release** run printed: its migrate run applies',
  "        every migration the recovered database lacks, the older releases' among them. On the",
  "        same server that is the release `images.env`'s `WEB_IMAGE` named before step 7's deploy,",
  '        the new image of the last production line of `deploys.log` that is neither `FAILED` nor',
  "        `ROLLED BACK`, when that line is later than that time; on a new server, the owner's own",
  '        note of the day, never the **VPS release** runs alone, which list each release built,',
  "        not whether it stayed live. One older than step 1's, as after a rollback by hand since,",
  "        goes out as step 1's did instead, without a migrate reference, as the database holds",
  "        step 1's migrations. If none did, or it is step 1's own, step 1's deploy is all.",
].join('\n');

/**
 * The cut-over's zone and leak test (Stop D, docs/DECISIONS.md VPS-113 and VPS-115). Vercel's
 * records move to Cloudflare DNS only, so that Vercel serves them as before, with their values
 * written down, since the way back sets them again, DNS only. The leak test's first step goes
 * through Cloudflare, so it needs a proxied record: a temporary `leaktest` one at the staging
 * night, before the `staging` record moves, with no record pointed at the server before that night
 * and First install's last step saying so. The outline before Stop D ran the leak test before any
 * DNS, which the server team's launch.md puts first.
 */
const zoneAndLeak = (runbook: string) =>
  inPlaces(
    runbook,
    ['zoneMove', 'rehearsal', 'stagingNight', 'wayBack', 'lastStep'],
    ({ zoneMove, rehearsal, stagingNight, wayBack, lastStep }) => {
      const night = flat(stagingNight);
      const leak = night.indexOf('`leaktest.menumesh.in`');
      const record = night.indexOf('**The `staging` record**');
      return [
        ...(has(zoneMove, "Vercel's records stay **DNS only**")
          ? []
          : ['the zone move doesn’t keep Vercel’s records DNS only']),
        ...(has(zoneMove, "Write down each of Vercel's records, its name, type and value")
          ? []
          : ['the zone move doesn’t write down Vercel’s records for the way back']),
        ...(has(wayBack, "back to Vercel's written-down values, DNS only")
          ? []
          : ['the way back doesn’t set Vercel’s written-down values again, DNS only']),
        ...(leak >= 0 && record >= 0 && leak < record
          ? []
          : [
              'the staging night moves the staging record before the leak test through leaktest.menumesh.in',
            ]),
        ...([zoneMove, rehearsal].some((text) => has(text, "to the server's IPv4"))
          ? ['a record points at the server before the staging night']
          : []),
        ...(has(lastStep, '`leaktest.menumesh.in`') && has(lastStep, 'before any app record moves')
          ? []
          : [
              'First install, step 22, runs the leak test without its temporary record, or after an app record moves',
            ]),
      ];
    },
  );

/** The staging night's three variables, as the RUNBOOK sets them. */
const STAGING_SWITCHES = [
  '`VPS_IMAGES` `true`',
  '`VPS_DEPLOY_STAGING` `true`',
  '`DEPLOY_STAGING` `false`',
];

/**
 * The staging night's switches (VPS-116): VPS_IMAGES and VPS_DEPLOY_STAGING on and DEPLOY_STAGING
 * off, together, at that night, and Deploys on the VPS says staging follows main on the server from
 * then. The outline turned VPS_DEPLOY_STAGING on only after the move, so merges would have gone on
 * deploying staging to Vercel while the record named the server. First install, step 17, turns on
 * VPS_IMAGES alone and says VPS_DEPLOY_STAGING waits for that night: turned on there, CI would
 * deploy staging to the server and stop Vercel's staging deploys while the record named Vercel
 * (Stop D's review, T1 of the docs). And the night allows the one merge its step 6 needs (D2 of the
 * docs).
 */
const stagingSwitches = (runbook: string) =>
  inPlaces(
    runbook,
    ['stagingNight', 'retirement', 'deploys', 'gitHub'],
    ({ stagingNight, retirement, deploys, gitHub }) => [
      ...STAGING_SWITCHES.filter((words) => !has(stagingNight, words)).map(
        (words) => `the staging night doesn’t set ${words}`,
      ),
      ...(has(gitHub, '`VPS_DEPLOY_STAGING` waits for the staging night') &&
      !/`VPS_DEPLOY_STAGING`[^.;:]*`true`/.test(flat(gitHub))
        ? []
        : ['First install turns VPS_DEPLOY_STAGING on before the staging night']),
      ...(has(stagingNight, 'with no merge to `main` while it runs') &&
      !has(stagingNight, "with no merge to `main` while it runs other than step 6's")
        ? ['the staging night forbids the merge its step 6 needs']
        : []),
      ...(has(retirement, 'VPS_DEPLOY_STAGING')
        ? ['VPS_DEPLOY_STAGING waits for the Vercel parts to retire']
        : []),
      ...(has(deploys, 'are `true`, from the staging night')
        ? []
        : [
            'Deploys on the VPS doesn’t say staging follows main on the server from the staging night',
          ]),
    ],
  );

/**
 * What the way back keeps for its 14 days (VPS-117 to VPS-120). A Vercel deployment keeps the
 * CRON_SECRET it was built with, so taking it out stops no cron job until the next deployment: each
 * project's cron jobs are disabled at its night instead, CRON_SECRET kept, enabled again by the way
 * back, and the secret leaves both projects only after the 14 days. The hosted project's nightly
 * backup goes off after its pause, as a paused project's night fails, and on again with the way
 * back. The way back lasts 14 days, and the first real write on the server is its point of no
 * return. A later production night after a way back keeps the first night's admin, which the tool
 * would refuse to make again (Stop D's review, D4 of the cut-over sequence), and its step 4 types
 * again just what hosted's /super changed while hosted served, neither every setting nor none
 * (Stop D's re-review, R2-2); and the Vercel rules stay until the Vercel parts retire, not until
 * Stop D (D3 of the docs).
 */
const windowKept = (runbook: string) =>
  inPlaces(
    runbook,
    ['stagingNight', 'productionNight', 'wayBack', 'retirement', 'cutover', 'afterMove'],
    ({ stagingNight, productionNight, wayBack, retirement, cutover, afterMove }) => {
      const night = flat(productionNight);
      const paused = night.indexOf('**Pause project**');
      const backupOff = night.indexOf('**`BACKUP_PRODUCTION`** `false`');
      return [
        ...[
          ['the staging night', stagingNight],
          ['the production night', productionNight],
        ]
          .filter(
            ([, text]) => !has(text, '**Disable Cron Jobs**') || !has(text, '`CRON_SECRET` stays'),
          )
          .map(([name]) => `${name} doesn’t disable Vercel’s cron jobs with CRON_SECRET kept`),
        ...(has(wayBack, '**Enable Cron Jobs**')
          ? []
          : ['the way back doesn’t enable Vercel’s cron jobs again']),
        ...(/`CRON_SECRET` out of/.test(flat(cutover))
          ? ['CRON_SECRET leaves Vercel before the 14 days end']
          : []),
        ...(has(retirement, '`CRON_SECRET` out of both Vercel projects')
          ? []
          : ['the retirement doesn’t take CRON_SECRET out of both Vercel projects']),
        ...(paused >= 0 && backupOff > paused
          ? []
          : [
              'the production night doesn’t turn BACKUP_PRODUCTION off after pausing the hosted project',
            ]),
        ...(has(wayBack, '**Restore project**') && has(wayBack, '`BACKUP_PRODUCTION` `true`')
          ? []
          : ['the way back doesn’t restore the hosted project and turn BACKUP_PRODUCTION on']),
        ...(has(wayBack, 'For 14 days after the production night') &&
        has(retirement, 'for the 14 days')
          ? []
          : ['the way back doesn’t last the 14 days']),
        ...(has(wayBack, 'It loses nothing until the first real write on the server') &&
        has(wayBack, 'That write is the point of no return')
          ? []
          : [
              'the way back doesn’t end at the first real write on the server, its point of no return',
            ]),
        ...(has(
          wayBack,
          "without the first admin's link and step 3 when the server's database still holds the first night's admin",
        )
          ? []
          : [
              'a later production night doesn’t skip just the first admin’s link and step 3 while the server holds the first night’s admin',
            ]),
        ...(has(wayBack, "only what differs from hosted's `/super` that night")
          ? []
          : [
              'a later production night doesn’t type again just what hosted’s /super changed during the way back',
            ]),
        ...(has(afterMove, 'until the Vercel parts retire, 14 days after the production night') &&
        !has(afterMove, 'until the cut-over (Stop D) rewrites them')
          ? []
          : ['After the move ends the Vercel rules before the Vercel parts retire']),
      ];
    },
  );

/** menumesh.caddy, whose hosts the staging night's origin test must name. */
const SITE = readFileSync(join('deploy', 'vps', 'edge', 'menumesh.caddy'), 'utf8');

/** Each site block of a Caddy site file: its address's host, and whether it imports `snippet`. */
function siteBlocks(site: string, snippet: string): { host: string; imports: boolean }[] {
  const blocks: { host: string; imports: boolean }[] = [];
  let open: { host: string; imports: boolean } | undefined;
  for (const line of site.split('\n')) {
    const address = /^https:\/\/([^\s{]+) \{$/.exec(line);
    if (address) {
      open = { host: address[1], imports: false };
      blocks.push(open);
    } else if (line === '}') {
      open = undefined;
    } else if (open && line.trim() === `import ${snippet}`) {
      open.imports = true;
    }
  }
  return blocks;
}

/** The staging night's stop on an exit 0 of the origin test, since the server team's 66c8c61. */
const STOP_ON_EXIT_0 =
  "An exit 0 means the server's `tls_menumesh` has no `client_auth`, so its `snippets.caddy` is not the server team's of `66c8c61` or later: stop.";

/** Where that stop sends the admin, since the server team installs their file (VPS-147). */
const STAGING_ASK =
  "The admin makes the copy and runs the comparison of First install, step 11, and asks in the server team's chat as its `DIFFERENT` does";
/** The night goes on only once the comparison and the origin test both pass. */
const STAGING_SAME =
  'until they have answered, the comparison prints `SAME` and every exit is not 0';

/** That stop at b2558c3, which had the admin install the server team's file again, unasked. */
const STAGING_STOP_B2558C3 = [
  "   the server team's of `66c8c61` or later: stop. The night goes no further until the admin has",
  '   installed theirs again (First install, step 11) and every exit is not 0. Way back: none needed,',
  '   as no record sends the server anything yet.',
].join('\n');

/** That stop at ac976ce, when MenuMesh's own snippet still had client_auth commented out. */
const OLD_STOP_ON_EXIT_0 = [
  '   An exit 0 means `client_auth` in `tls_menumesh` is still commented out: stop. The night goes no',
  '   further until the admin has turned authenticated origin pulls on as `edge.md` §3 says',
  "   (Cloudflare's zone-level pulls first, then `client_auth`) and every exit is not 0. Way back:",
  '   none needed, as no record sends the server anything yet.',
].join('\n');

/**
 * Authenticated origin pulls proved for MenuMesh's own hosts (Stop D's review, D1 of the cut-over
 * sequence). First install, step 11, runs the server team's origin test before MenuMesh's site file
 * is in, when no site imports tls_menumesh, so the test proves nothing for MenuMesh's hosts
 * whatever it prints, and their command names their own host. So the staging night runs it right
 * after the site file, for every host menumesh.caddy serves and no other, each block of it
 * importing tls_menumesh, and stops on an exit 0; and step 11 says its own proves nothing yet and
 * points to that one. Since the server team's snippets.caddy holds tls_menumesh with client_auth on
 * (their 66c8c61; VPS-142), an exit 0 means the server's file is not theirs, not a client_auth still
 * commented out; and since they install that file themselves (VPS-147), the stop sends the admin to
 * step 11's comparison and to their chat, as its DIFFERENT does, never to an install of their own.
 */
const originPulls = (runbook: string, site: string) =>
  inPlaces(runbook, ['edgeStep', 'siteNight'], ({ edgeStep, siteNight }) => {
    const night = flat(siteNight);
    const loop =
      /for h in ([^;]+); do curl -sk [^;]*--resolve "\$h:443:127\.0\.0\.1" "https:\/\/\$h\/"; echo "\$h exit \$\?"; done/.exec(
        night,
      );
    const blocks = siteBlocks(site, 'tls_menumesh');
    const served = blocks.map((block) => block.host);
    const tested = loop ? loop[1].trim().split(' ') : [];
    return [
      ...(loop && loop.index > night.indexOf('`sudo app-apply menumesh site')
        ? [
            ...served
              .filter((host) => !tested.includes(host))
              .map((host) => `the origin test leaves out ${host}, which menumesh.caddy serves`),
            ...tested
              .filter((host) => !served.includes(host))
              .map((host) => `the origin test names ${host}, which menumesh.caddy doesn’t serve`),
          ]
        : [
            'the staging night doesn’t run the origin test for MenuMesh’s hosts right after its site file',
          ]),
      ...blocks
        .filter((block) => !block.imports)
        .map((block) => `menumesh.caddy’s ${block.host} block doesn’t import tls_menumesh`),
      ...(has(siteNight, STOP_ON_EXIT_0)
        ? []
        : [
            'the origin test doesn’t stop the night on an exit 0, the sign of a snippets.caddy that is not the server team’s',
          ]),
      ...(has(siteNight, STAGING_ASK) && has(siteNight, STAGING_SAME)
        ? []
        : [
            'the origin test’s exit 0 doesn’t stop for the server team’s answer in their chat, as First install, step 11’s DIFFERENT does',
          ]),
      ...(has(edgeStep, 'For `menumesh.in` that test proves nothing yet') &&
      has(edgeStep, 'The test that proves it runs right after the site file, on the staging night')
        ? []
        : [
            'First install, step 11, doesn’t say its origin test proves nothing for menumesh.in yet, nor point to the staging night’s',
          ]),
    ];
  });

/**
 * scheduler-staging only from the staging night (Stop D's review, D2 and D7 of the cut-over
 * sequence). Until then Vercel staging's cron jobs run the same daily and digest on the same hosted
 * database at the same minutes, where neither run's log can stop the other's emails, and
 * web-staging keeps the image First install deployed by hand while each merge moves Vercel staging
 * and that database on. So First install, step 20, starts production's scheduler alone, without the
 * argument that the two callers were as safe as a second run by hand; the rehearsal checks no
 * staging scheduler; and the staging night deploys web-staging by hand on the commit Vercel
 * staging serves before its record moves, starts scheduler-staging once, after Vercel staging's
 * cron jobs are disabled, and its way back stops it, in step 5 before they are on again. Someone
 * working from Rotation, the scheduler's After a change or disaster recovery never reads step 20,
 * and an `up -d` that names scheduler-staging makes its container: so each sentence there with one
 * says itself to leave it out until the staging night's step 5, pointing to First install, step 20
 * (Stop D's re-review, R2-1).
 */
const stagingScheduler = (runbook: string) =>
  inPlaces(
    runbook,
    ['schedulers', 'rehearsal', 'stagingNight', 'envRotation', 'schedulerChange', 'recovery'],
    ({ schedulers, rehearsal, stagingNight, envRotation, schedulerChange, recovery }) => {
      const night = flat(stagingNight);
      const start = 'sudo app-compose menumesh up -d scheduler-staging';
      const stop = 'sudo app-compose menumesh stop scheduler-staging';
      const started = night.indexOf(start);
      const disabled = night.indexOf('**Disable Cron Jobs**');
      const record = night.indexOf('**The `staging` record**');
      const byHand = night.indexOf('a by-hand deploy as in First install, step 19');
      const wayBack = night.indexOf('Way back, for the whole night:');
      return [
        ...(/up -d[^`]*\bscheduler-staging\b/.test(flat(schedulers))
          ? ['First install, step 20, starts scheduler-staging before the staging night']
          : []),
        ...(has(schedulers, 'safe for the reasons a second run by hand is')
          ? [
              'First install, step 20, calls Vercel staging’s cron jobs and scheduler-staging safe together',
            ]
          : []),
        ...(/`scheduler-staging`'s the same|up -d[^`]*\bscheduler-staging\b/.test(flat(rehearsal))
          ? ['the server rehearsal checks scheduler-staging before the staging night']
          : []),
        ...(byHand >= 0 && byHand < record && has(stagingNight, '**VPS build** run of that commit')
          ? []
          : [
              'the staging night doesn’t deploy web-staging by hand on the commit Vercel staging serves before its record moves',
            ]),
        ...(started > disabled && disabled >= 0 && started === night.lastIndexOf(start)
          ? []
          : [
              'the staging night doesn’t start scheduler-staging once, after Vercel staging’s cron jobs are disabled',
            ]),
        ...(started >= 0 && night.indexOf(`${stop}\` first, then **Enable Cron Jobs**`) > started
          ? []
          : [
              'step 5’s way back doesn’t stop scheduler-staging before Vercel staging’s cron jobs go on',
            ]),
        ...(wayBack >= 0 && night.indexOf(stop, wayBack) > wayBack
          ? []
          : ['the staging night’s way back doesn’t stop scheduler-staging']),
        ...(
          [
            ['Secrets (VPS), Rotation,', envRotation],
            ['The scheduler (VPS), After a change,', schedulerChange],
            ['Backups and restore (VPS), Disaster recovery,', recovery],
          ] as const
        ).flatMap(([where, text]) =>
          sentences(text)
            .filter(
              (sentence) =>
                /\bup -d\b/.test(sentence) &&
                /\bscheduler-staging\b/.test(sentence) &&
                !(
                  sentence.includes("the staging night's step 5") &&
                  sentence.includes('First install, step 20')
                ),
            )
            .map(
              (sentence) =>
                `${where} starts scheduler-staging before the staging night: ${/`[^`]*\bscheduler-staging\b[^`]*`/.exec(sentence)?.[0] ?? 'scheduler-staging'}`,
            ),
        ),
      ];
    },
  );

/**
 * Part 1's count in one statement (Stop D's review, D3 of the cut-over sequence): Supabase's SQL
 * editor shows only the last statement's result, so the two statements before showed the logins
 * alone, without the restaurants row the go or stop rests on. The logins are a row of the same
 * result, which the text names.
 */
const oneCount = (runbook: string) =>
  inPlaces(runbook, ['count'], ({ count }) => {
    const sql = /```sql\n([\s\S]*?)```/.exec(count)?.[1] ?? '';
    const statements = sql.split(';').filter((piece) => piece.trim() !== '').length;
    return [
      ...(statements === 1
        ? []
        : [
            `part 1’s count runs ${statements} statements, and the SQL editor shows only the last one’s result`,
          ]),
      ...(has(sql, "union all select 'auth', 'users', (select count(*) from auth.users)") &&
      has(count, 'The logins are the `auth` `users` row')
        ? []
        : ['part 1’s count doesn’t give the logins as a named row of its one result']),
    ];
  });

/**
 * The leak test's setup as MenuMesh's pieces make it, on the port the image listens on, as the
 * server team's merged edge.md §6 has it (VPS-143): its UPSTREAMS entry, its block and the install
 * of the copy that holds it.
 */
const LEAK_PIECES = [
  '`edge-menumesh`',
  '`menumesh-leaktest:80` goes into `UPSTREAMS` in `/etc/apps/menumesh.conf`',
  'https://leaktest.menumesh.in { import site_common import tls_menumesh reverse_proxy menumesh-leaktest:80 { import upstream } }',
  'sudo app-apply menumesh site ~/incoming/menumesh-leaktest.caddy',
];
/** The installed site file copied for the test and kept for step 5, which puts it back. */
const LIVE_COPY = 'sudo cat /srv/edge/config/sites/menumesh.caddy > ~/incoming/menumesh-live.caddy';
const SITE_BACK = 'sudo app-apply menumesh site ~/incoming/menumesh-live.caddy';
const LEAK_STOP = 'sudo docker stop menumesh-leaktest';
const CONF_EDIT = 'sudoedit /etc/apps/menumesh.conf';
const COPIES_GONE = 'rm ~/incoming/menumesh-live.caddy ~/incoming/menumesh-leaktest.caddy';
const IMAGE_GONE =
  'sudo docker image rm traefik/whoami@sha256:c4717a8d1f0134a7444e24f881160e033991f23027c6c5a9a3f8fd22e70d1d44';

/**
 * The leak test's site for leaktest.menumesh.in (Stop D's review, D1 of the docs). The server
 * team's edge.md §6 puts its container on edge-jainav with a leaktest.jainavinfotech.in site file,
 * and app-apply keeps each app to one site file, hosts in its ZONE and upstreams from its
 * UPSTREAMS, so nothing served the leak test's host. MenuMesh's pieces stand in: the container on
 * edge-menumesh, its name in UPSTREAMS for the test, a copy of menumesh.caddy with a leaktest block
 * importing what the others import, installed with app-apply. Since their merged §6 (VPS-143) the
 * copy is of the installed file, kept for their step 5, which goes in their order: the kept copy
 * back first, never removing menumesh.caddy, as the test block needs its UPSTREAMS entry and the
 * daily validate refuses a site whose upstream isn't listed; then the container stopped, so that
 * hostwatch never sees it outside UPSTREAMS; then the entry out; then the copies and the image.
 */
const leakPieces = (runbook: string) =>
  inPlaces(runbook, ['leakTest'], ({ leakTest }) => {
    const text = flat(leakTest);
    const test = text.indexOf(LEAK_PIECES[3]);
    const copied = text.indexOf(LIVE_COPY);
    const back = text.indexOf(SITE_BACK);
    const stopped = text.indexOf(LEAK_STOP);
    const out = text.lastIndexOf(CONF_EDIT);
    return [
      ...LEAK_PIECES.filter((piece) => !text.includes(piece)).map(
        (piece) => `the leak test’s setup lacks MenuMesh’s ${piece}`,
      ),
      ...(copied >= 0 && copied < test
        ? []
        : ['the leak test’s site copy isn’t made from the installed menumesh.caddy']),
      ...(back > test && stopped > back && out > stopped && has(leakTest, '(never removed')
        ? []
        : [
            'the leak test’s step 5 doesn’t put menumesh.caddy back, never removing it, then stop the container, then take its UPSTREAMS entry out',
          ]),
      ...(text.indexOf(COPIES_GONE) > out && text.indexOf(IMAGE_GONE) > out
        ? []
        : ['the leak test’s step 5 leaves its copies or its image on the server']),
    ];
  });

/**
 * Caddy recreated only in the shared server's window (Stop D's review, D5 of the cut-over
 * sequence): `app-compose edge up -d` drops every connection on the shared edge, the server team's
 * own site's among them, which is why app-apply prints the window and their server.md §7 runs it
 * there.
 */
const edgeWindow = (runbook: string) =>
  inPlaces(runbook, ['vps'], ({ vps }) => {
    const text = flat(vps);
    const problems: string[] = [];
    for (const words of ['sudo app-compose edge up -d', 'recreate Caddy']) {
      for (let at = text.indexOf(words); at >= 0; at = text.indexOf(words, at + 1)) {
        const after = text.slice(at + words.length, at + words.length + 40);
        if (!after.includes('between 01:00 and 07:00 IST')) {
          problems.push(`${words} without the 01:00 to 07:00 IST window`);
        }
      }
    }
    return problems;
  });

/** The cut-over's outline before Stop D (935373d): its step 4, the leak test before any DNS. */
const OUTLINE_LEAK =
  '4. The site file and the redaction file, the leak test, the data as Stop D decides, and DNS last.';

/** First install's step 22 before Stop D (935373d). */
const OLD_LAST_STEP = [
  '22. Last, after the server rehearsal (below):',
  '    `sudo app-apply menumesh site ~/incoming/menumesh.caddy` and',
  "    `sudo app-apply edge redact menumesh ~/incoming/log-redact.caddy`; then the admin's leak test",
  "    (the server team's `edge.md` §6, with a made-up 16-character `/t/` token, which the log must",
  '    show as `/t/_`); then DNS.',
].join('\n');

/** The staging night's step 1 at cd6a733: the site file, and no origin test after it. */
const OLD_SITE_STEP = [
  '1. **The site file and the redaction file** (First install, step 22):',
  '   `sudo app-apply menumesh site ~/incoming/menumesh.caddy` and',
  '   `sudo app-apply edge redact menumesh ~/incoming/log-redact.caddy`. Caddy serves the four hosts',
  '   from now on, but no record sends it anything yet. Way back: none needed.',
  '',
].join('\n');

/** The leak test at cd6a733: the server team's steps, with nothing to serve the leak test's host. */
const OLD_LEAK_TEST = [
  "2. **The leak test**, by the admin (the server team's `edge.md` §6), through a temporary `A` record",
  "   `leaktest.menumesh.in` to the server's IPv4, proxied, before any app record moves (VPS-115):",
  '   forged headers replaced; the log line without an address, a header or a query, and a made-up',
  "   16-character `/t/` token in it shown as `/t/_`; nothing answering straight on the server's",
  '   addresses, IPv4 and IPv6, even with a temporary hPanel accept rule; and a TLS connection without',
  '   the client certificate refused. Then their step 5 removes the test site, and the owner deletes',
  '   the `leaktest` record. Way back: the record deleted.',
  '',
].join('\n');

/** First install's step 20 at cd6a733: both schedulers at once. */
const OLD_SCHEDULERS = [
  '20. The schedulers: `sudo app-compose menumesh up -d scheduler scheduler-staging`. Each turns',
  "    healthy at its first answered minute call. Production's runs on a fresh database: no restaurant",
  '    to remind, no digest until the first admin joins (it goes to joined admins only: The server',
  '    rehearsal and the cut-over, part 4), and the rest cleans up or counts what is there. Until the',
  "    staging night, `scheduler-staging` and Vercel staging's cron jobs both run staging's `daily`",
  '    and `digest`, which is safe for the reasons a second run by hand is (The scheduler (VPS)).',
].join('\n');

/** The staging night's step 5 at cd6a733: Vercel's crons off, and scheduler-staging already on. */
const OLD_STAGING_CRONS = [
  "5. **Vercel's staging project**: Schedules → Cron Jobs → **Disable Cron Jobs**, so that",
  "   `scheduler-staging` runs staging's jobs alone. `CRON_SECRET` stays (part 6 takes it out). Way",
  '   back: **Enable Cron Jobs** there.',
].join('\n');

/** The later production night's skips at 67010b7: step 4 too, with the link and step 3. */
const OLD_LATER_NIGHT = [
  ", without the first admin's link and",
  "steps 3 and 4 when the server's database still holds the first night's admin and settings: sign in",
  'with that login instead. ',
].join('\n');

// The server team's review (docs/DECISIONS.md VPS-135 to VPS-140): the commands its rules hold the
// RUNBOOK to.
const REDACT = 'sudo app-apply edge redact menumesh ~/incoming/log-redact.caddy';
const EDGE_CERT =
  'sudo app-apply edge cert menumesh ~/csr/origin.pem ~/csr/origin-key.pem ~/incoming/aop-ca.pem';
const AOP_CLIENT =
  'sudo install -m 0644 -o root -g root ~/incoming/aop-client.pem /srv/edge/certs/menumesh/';
/** The CSR's key goes only once its certificate is in (their edge.md §3, step 4; VPS-145). */
const KEY_SHRED = 'shred -u ~/csr/origin-key.pem';
const CERT_INSTALL = `${EDGE_CERT} && ${KEY_SHRED} && rm -r ~/csr`;
/** The server team's digest pin, as their edge.md §5, A new Caddy image, steps 1 to 3 (VPS-145). */
const PIN_COPY =
  "scp docker/edge/compose.yml ops@<the tunnel's SSH host>:incoming/edge-compose.yml";
const PIN_CONF = 'sudoedit /etc/apps/edge.conf';
const PIN_PULL = `sudo docker pull "$(sed -n 's/^CADDY_IMAGE=//p' /etc/apps/edge.conf)"`;
const PIN_COMPOSE = 'sudo app-apply edge compose ~/incoming/edge-compose.yml';
const EDGE_COPY = '(umask 077; sudo cat /srv/edge/edge.env > ~/incoming/edge.env)';
const EDGE_ENV = 'sudo app-apply edge env ~/incoming/edge.env && shred -u ~/incoming/edge.env';
const RECREATE = 'sudo app-compose edge up -d';
/** Caddy's own environment, named and counted, never printed: its hash stays unseen. */
const RECREATED =
  "sudo docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' edge-caddy-1 | grep -c '^MENUMESH_STAGING_AUTH_'";
const SHRED_COPIES = 'shred -u ~/incoming/.env ~/incoming/web.env ~/incoming/web-staging.env';
const AOP_VERIFY = 'openssl verify -CAfile aop-ca.pem -purpose sslclient aop-client.pem';
/** The leak test's image, by the digest of its index (an OCI index with linux/amd64). */
const LEAK_IMAGE =
  'traefik/whoami:v1.12.0@sha256:c4717a8d1f0134a7444e24f881160e033991f23027c6c5a9a3f8fd22e70d1d44';
/**
 * The leak test container's flags: detached and removed once stopped, on MenuMesh's edge network
 * under the name its UPSTREAMS entry holds, within hostwatch's limits, and with no capability, no
 * new privileges and a read-only root.
 */
const LEAK_FLAGS = [
  '-d',
  '--rm',
  '--name menumesh-leaktest',
  '--network edge-menumesh',
  '--network-alias menumesh-leaktest',
  '--memory 64m',
  '--cpus 0.25',
  '--cap-drop ALL',
  '--security-opt no-new-privileges',
  '--read-only',
];

/**
 * The redaction file right after the conf (the server team's review, ask 1; VPS-135). From the
 * conf on, hostwatch's daily run raises a critical alert every day the file is missing, and it
 * went in only on the staging night. It needs only the conf, and app-apply refuses it from step
 * 11's edge.env until Caddy is recreated: so it comes at step 9, and neither step 22 nor the
 * staging night installs it again. A new server takes it right after disaster recovery's conf.
 */
const redactEarly = (runbook: string) =>
  inPlaces(
    runbook,
    ['confStep', 'lastStep', 'siteNight', 'recoveryEdge'],
    ({ confStep, lastStep, siteNight, recoveryEdge }) => [
      ...(has(confStep, REDACT)
        ? []
        : ['First install, step 9, doesn’t install the redaction file right after the conf']),
      ...(
        [
          ['First install, step 22,', lastStep],
          ['the staging night’s step 1', siteNight],
        ] as const
      )
        .filter(([, text]) => has(text, 'app-apply edge redact'))
        .map(
          ([where]) => `${where} installs the redaction file, which goes in right after the conf`,
        ),
      ...(has(recoveryEdge, "the redaction file right after step 1's conf")
        ? []
        : ['disaster recovery’s edge doesn’t install the redaction file right after its conf']),
    ],
  );

/**
 * The edge in its order, and edge.env merged (the server team's review, their commitments 3 and 4;
 * VPS-136). app-apply refuses every change that reloads Caddy from `edge env` until Caddy is
 * recreated, so the certificate, with the owner's aop-ca.pem and the client certificate beside it,
 * goes in first, and edge.env last, the recreate right after it. `edge env` installs the file it is
 * given whole, so the admin merges a copy of the live file and shreds it, also on stopping after a
 * refusal (VPS-143). One recreate takes the server team's digest pin as well, its three steps before
 * edge.env, and the staging night first checks that Caddy holds MenuMesh's two lines, by their names
 * alone. The CSR's key goes only once the certificate is in, as in their edge.md §3: a refused
 * install would have shredded the only copy (VPS-145).
 */
const edgeNight = (runbook: string) =>
  inPlaces(runbook, ['edgeStep', 'beforeStaging'], ({ edgeStep, beforeStaging }) => {
    const text = flat(edgeStep);
    const order = [EDGE_CERT, EDGE_COPY, EDGE_ENV, RECREATE].map((words) => text.indexOf(words));
    const pin = [PIN_COPY, PIN_CONF, PIN_PULL, PIN_COMPOSE, EDGE_COPY].map((words) =>
      text.indexOf(words),
    );
    return [
      ...[CERT_INSTALL, AOP_CLIENT, EDGE_COPY, EDGE_ENV]
        .filter((words) => !text.includes(words))
        .map((words) => `First install, step 11, lacks ${words}`),
      ...(text.split(KEY_SHRED).length === text.split(`${EDGE_CERT} && ${KEY_SHRED}`).length
        ? []
        : ['First install, step 11, shreds the CSR’s key whether or not its certificate went in']),
      ...(order.every((at, n) => at >= 0 && (n === 0 || at > order[n - 1])) &&
      has(
        edgeStep,
        'the order is the certificate, then the snippet, then (the redaction file in since step 9) `edge.env`, then the recreate',
      )
        ? []
        : [
            'First install, step 11, doesn’t put the certificate and the snippet before edge.env, and the recreate right after it',
          ]),
      ...(has(
        edgeStep,
        'When the admin stops, either way, the copy goes with `shred -u ~/incoming/edge.env`',
      )
        ? []
        : ['First install, step 11, leaves a copy of edge.env behind when the admin stops']),
      ...(has(edgeStep, "It also takes the server team's digest pin of Caddy") &&
      pin.every((at, n) => at >= 0 && (n === 0 || at > pin[n - 1])) &&
      text.includes(`CADDY_IMAGE=${CADDY}`)
        ? []
        : ['First install, step 11, recreates Caddy without the server team’s digest pin']),
      ...(has(beforeStaging, RECREATED)
        ? []
        : ['the staging night doesn’t check that Caddy was recreated with MenuMesh’s two lines']),
    ];
  });

/**
 * The server team's snippets.caddy (VPS-142), which they install themselves: step 11 copies it in
 * Git Bash at the commit they name, checks the copy's sum, sends it, and compares the server's file
 * with it, each by its sum, installing the copy only on their word (VPS-147).
 */
const SNIPPET_SHOW =
  'git -C <their checkout> show <commit>:docker/edge/config/snippets.caddy > snippets.caddy';
const SNIPPET_SUM = 'sha256sum snippets.caddy';
const SNIPPET_COPY = "scp snippets.caddy ops@<the tunnel's SSH host>:incoming/";
const LIVE_SUM = 'sudo sha256sum /srv/edge/config/snippets.caddy';
const COPY_SUM = 'sha256sum ~/incoming/snippets.caddy';
const SNIPPET_CMP =
  'sudo cmp /srv/edge/config/snippets.caddy ~/incoming/snippets.caddy && echo SAME || echo DIFFERENT';
const SNIPPET = 'sudo app-apply edge config ~/incoming/snippets.caddy';

/**
 * tls_menumesh from the server team's snippets.caddy (their 66c8c61; VPS-142). Their file holds it
 * with client_auth on, Caddy refuses a snippet declared twice, and a later edge config of their file
 * would drop one added on the server. So step 11 keeps their file between the certificate and
 * edge.env, its copy sent and, on their word alone (VPS-147), installed there, says that it holds
 * tls_menumesh with client_auth on, and adds none of MenuMesh's own: the kit has no
 * tls_menumesh.caddy any more.
 */
const serverSnippet = (runbook: string) =>
  inPlaces(runbook, ['edgeStep'], ({ edgeStep }) => {
    const text = flat(edgeStep);
    const at = [EDGE_CERT, SNIPPET_COPY, SNIPPET, EDGE_COPY].map((words) => text.indexOf(words));
    return [
      ...[SNIPPET_COPY, SNIPPET]
        .filter((words) => !text.includes(words))
        .map((words) => `First install, step 11, lacks ${words}`),
      ...(at.every((found, n) => found >= 0 && (n === 0 || found > at[n - 1]))
        ? []
        : [
            'First install, step 11, doesn’t keep the server team’s snippets.caddy between the certificate and edge.env',
          ]),
      ...(has(edgeStep, 'holds `tls_menumesh` with `client_auth` on since their `66c8c61`')
        ? []
        : [
            'First install, step 11, doesn’t say the server team’s snippets.caddy holds tls_menumesh with client_auth on',
          ]),
      ...(has(edgeStep, "MenuMesh's kit never adds a snippet to the server's file") &&
      !text.includes('tls_menumesh.caddy')
        ? []
        : [
            'First install, step 11, adds a snippet of MenuMesh’s own to the server’s snippets.caddy',
          ]),
    ];
  });

/** b2558c3's copy, sent from a working tree at whatever commit it had checked out. */
const TREE_COPY = 'scp docker/edge/config/snippets.caddy';
/**
 * What the admin's message on DIFFERENT gives the server team, who know the sum of every version of
 * their file: an older one they install theirs over, a newer one of a round not yet confirmed they
 * confirm, and one of no commit, a hand edit, they look at before anything is installed (VPS-147).
 */
const THREE_THINGS = "the live file's sum, the copy's sum and the commit the copy came from";
/** Step 11's words for the copy, its check, and the two outcomes of the comparison (VPS-147). */
const IN_GIT_BASH = 'in Git Bash, not PowerShell';
const LATEST = 'at the commit their latest confirmation names';
const SUM_STOP = '`sha256sum` must print the `snippets.caddy` sum that confirmation gives, or stop';
const SAME_PATH =
  '`SAME`, what their install leaves: the server holds their file of that commit, nothing is installed';
const DIFFERENT_STOP = "`DIFFERENT`: stop, and ask in the server team's chat";
const HELD = "Run none of this step's lines below until they answer, `edge.env`'s above all";
const THEIR_INSTALL =
  'Either they install their file themselves, and the three lines, with the copy made again if their answer names another commit, must print `SAME`';
const THEIR_WORD = `or they say in their chat to install that copy, and only then does the admin run \`${SNIPPET}\``;
const AGAIN = 'checks every installed site again, and the three lines must print `SAME`';
const THEIR_FILE = "the server's file is always their file at a commit they name";
/** Disaster recovery's edge takes the same comparison, before its edge.env lines too. */
const RECOVERY_SNIPPET =
  "Before the `edge.env` lines comes that step's comparison of the snippet: on a rebuilt server the server team's edge comes back first";

/**
 * The server's snippets.caddy compared with the server team's, and never installed on the way
 * (their plan of 2026-11-22; VPS-147). `app-apply edge config` installs the whole file, their
 * tls_jainav too, so step 11's copy from a working tree, "at that commit or a later one", could have
 * turned their origin pulls off or made their hosts refuse Cloudflare. They install main's file
 * themselves, right after their kit's refresh, and their confirmation names the commit and gives
 * the installed file's sum. So the admin makes the copy of that commit's file with git show in Git
 * Bash, where PowerShell 5.1's `>` would write it as UTF-16 with CRLF, checks its sum against their
 * confirmation before the scp, and compares the server's file with it, each by its sum, before any
 * edge config and before edge.env: SAME installs nothing; DIFFERENT stops, asks their chat with the
 * live file's sum, the copy's and its commit, holds the step's later lines, edge.env above all, and
 * installs the copy only on their word, the comparison run again after either answer. The staging
 * night's exit 0 and disaster recovery's edge, before its edge.env lines, take the same comparison
 * and give the same three.
 */
const snippetGuard = (runbook: string) =>
  inPlaces(
    runbook,
    ['vps', 'edgeStep', 'siteNight', 'recoveryEdge'],
    ({ vps, edgeStep, siteNight, recoveryEdge }) => {
      const text = flat(edgeStep);
      const copied = text.indexOf(SNIPPET_SHOW);
      const summed = text.indexOf(SNIPPET_SUM);
      const sent = text.indexOf(SNIPPET_COPY);
      const compared = [LIVE_SUM, COPY_SUM, SNIPPET_CMP].map((words) => text.indexOf(words));
      const last = compared[compared.length - 1];
      const installed = text.indexOf(SNIPPET);
      const merged = text.indexOf(EDGE_COPY);
      return [
        ...(has(vps, TREE_COPY)
          ? ['the RUNBOOK sends snippets.caddy from a working tree, at whatever commit it has']
          : []),
        ...(has(vps, 'at that commit or a later one')
          ? [
              'the RUNBOOK takes snippets.caddy at that commit or a later one, not at the commit the server team names',
            ]
          : []),
        ...(copied >= 0 && has(edgeStep, IN_GIT_BASH) && has(edgeStep, LATEST)
          ? []
          : [
              'First install, step 11, doesn’t make its copy of snippets.caddy with git show in Git Bash, at the commit of the server team’s latest confirmation',
            ]),
        ...(copied >= 0 && summed > copied && sent > summed && has(edgeStep, SUM_STOP)
          ? []
          : [
              'First install, step 11, sends its copy of snippets.caddy before sha256sum shows the sum of the server team’s confirmation',
            ]),
        ...(sent >= 0 && compared.every((found, n) => found > (n === 0 ? sent : compared[n - 1]))
          ? []
          : [
              'First install, step 11, doesn’t compare the server’s snippets.caddy with the copy, each by its sum, once the copy is on the server',
            ]),
        ...(last >= 0 && installed >= 0 && installed < last
          ? [
              'First install, step 11, runs edge config before it compares the server’s snippets.caddy with the copy',
            ]
          : []),
        ...(last >= 0 && merged >= 0 && merged < last
          ? [
              'First install, step 11, reaches edge.env before it compares the server’s snippets.caddy with the copy',
            ]
          : []),
        ...(has(edgeStep, SAME_PATH)
          ? []
          : ['First install, step 11, doesn’t say that SAME installs nothing']),
        ...(has(edgeStep, DIFFERENT_STOP)
          ? []
          : [
              'First install, step 11, doesn’t stop on DIFFERENT and ask the server team in their chat',
            ]),
        ...(has(edgeStep, HELD)
          ? []
          : [
              'First install, step 11, doesn’t hold its lines below, edge.env above all, until the server team answers',
            ]),
        ...(has(edgeStep, `giving ${THREE_THINGS}`)
          ? []
          : [
              'First install, step 11’s DIFFERENT doesn’t give the server team the live file’s sum, the copy’s sum and the commit the copy came from',
            ]),
        ...(has(edgeStep, THEIR_WORD)
          ? []
          : [
              'First install, step 11, runs edge config without the server team’s word in their chat',
            ]),
        ...(has(edgeStep, THEIR_INSTALL) && has(edgeStep, AGAIN)
          ? []
          : [
              'First install, step 11, goes on after DIFFERENT without the comparison printing SAME again',
            ]),
        ...(has(edgeStep, THEIR_FILE)
          ? []
          : [
              'First install, step 11, doesn’t say the server’s snippets.caddy is always the server team’s file at a commit they name',
            ]),
        ...(has(siteNight, THREE_THINGS)
          ? []
          : [
              'the staging night’s exit 0 doesn’t give the server team the live file’s sum, the copy’s sum and the commit the copy came from',
            ]),
        ...(has(recoveryEdge, RECOVERY_SNIPPET) && has(recoveryEdge, THREE_THINGS)
          ? []
          : [
              'disaster recovery’s edge doesn’t compare the snippet as First install, step 11, does, giving the server team the live file’s sum, the copy’s sum and the commit the copy came from',
            ]),
      ];
    },
  );

/** First install's step 11 at ac976ce, up to its certificate: MenuMesh's own snippet file added. */
const OLD_EDGE_OPENING = [
  '11. The edge: the Origin CA certificate for `menumesh.in` and `*.menumesh.in` from a CSR made on the',
  '    server, the snippet of `deploy/vps/edge/tls_menumesh.caddy` added to `snippets.caddy`',
  '    (`sudo app-apply edge config snippets.caddy`), and authenticated origin pulls on, **before any',
  "    MenuMesh container runs**: the CSR, the order and the origin test are `edge.md` §3's, whose",
  '    step 5 must see a TLS connection to the server without the client certificate refused (§6,',
  "    step 4). The certificate goes in with `aop-ca.pem`, the owner's CA (step 8), which Caddy checks",
  "    Cloudflare's client certificate against; then `aop-client.pem`, that client certificate without",
  "    its key, goes beside it by hand, as `edge.md` §3 does for theirs, so that hostwatch's daily run",
  '    warns before it expires too:',
  '',
  '    ```sh',
  `    ${EDGE_CERT}`,
  `    ${AOP_CLIENT}`,
  '    shred -u ~/csr/origin-key.pem && rm -r ~/csr',
  '    ```',
  '',
  '',
].join('\n');

/**
 * The copies of the install's secrets that scp leaves in ops' ~/incoming go once they are installed
 * (VPS-140): step 14 shreds the three env files' copies after installing them, and Rotation the copy
 * of an env file installed again.
 */
const copiesGone = (runbook: string) =>
  inPlaces(runbook, ['envStep', 'envRotation'], ({ envStep, envRotation }) => {
    const text = flat(envStep);
    return [
      ...(text.indexOf(SHRED_COPIES) > text.lastIndexOf('sudo install -m 0600')
        ? []
        : ['First install, step 14, leaves the env files’ copies in ~/incoming']),
      ...(has(envRotation, 'its copy in `~/incoming` shredded')
        ? []
        : ['Rotation leaves the copy of an env file installed again in ~/incoming']),
    ];
  });

/** Their edge.md §5, step 8: each of Jainav's four hosts refuses a client without a certificate. */
const JAINAV_LOOP =
  'for h in jainavinfotech.in www.jainavinfotech.in staging.jainavinfotech.in analytics.jainavinfotech.in; do curl -sk -o /dev/null --max-time 5 --resolve "$h:443:127.0.0.1" "https://$h/"; echo "$h exit $?"; done';

/**
 * MenuMesh's first container waits for the server team's word that origin pulls are on for every
 * zone of the server (their commitment 1; VPS-135): First install, step 16, says so first, and the
 * server rehearsal where it runs First install. Since their merged edge.md §5, step 8 (VPS-143),
 * the step proves it before db's first container: their loop over Jainav's four hosts, run on the
 * server, and a stop on an exit 0.
 */
const originGate = (runbook: string) =>
  inPlaces(runbook, ['dbStep', 'rehearsal'], ({ dbStep, rehearsal }) => {
    const text = flat(dbStep);
    const proof = text.indexOf(JAINAV_LOOP);
    return [
      ...(text.startsWith(
        ' 16. Not before the server team confirms in their chat that authenticated origin pulls are on',
      ) && has(dbStep, 'until then this step, and every step after it, waits')
        ? []
        : ['First install, step 16, starts db without waiting for the server team’s origin pulls']),
      ...(proof >= 0 &&
      proof < text.indexOf('sudo app-compose menumesh up -d db') &&
      has(dbStep, "If one ends in 0, stop: the server team's round of origin pulls comes first")
        ? []
        : [
            'First install, step 16, starts db without proving that Jainav’s hosts refuse a client without a certificate',
          ]),
      ...(has(rehearsal, "Step 16 waits for the server team's word")
        ? []
        : ['the server rehearsal doesn’t say step 16 waits for the server team’s origin pulls']),
    ];
  });

/**
 * The drills on the second weekend (the server team's review, Q3; VPS-138): theirs take the first,
 * and app-compose's memory rule refuses our restore test beside theirs, and our two together. So
 * ours keep to the second weekend, or the third when it is missed, outside the backups' 20:20 to
 * 21:30 UTC, and the drill waits in the same terminal for the restore test to end.
 */
const drillDays = (runbook: string) =>
  inPlaces(runbook, ['restoreTest', 'drill'], ({ restoreTest, drill }) => [
    ...(has(
      restoreTest,
      'on the second weekend of the month, its Saturday (the 8th to the 14th) or the Sunday after, or on the third if the second is missed',
    ) && has(restoreTest, 'outside 20:20 to 21:30 UTC')
      ? []
      : [
          'the restore test doesn’t keep to the second weekend, or the third, outside 20:20 to 21:30 UTC',
        ]),
    ...(has(restoreTest, 'third week')
      ? ['the restore test still says the third week, which the server team’s drills can take']
      : []),
    ...(has(drill, 'right after the restore test has ended, in the same terminal')
      ? []
      : ['the drill doesn’t wait in the same terminal for the restore test to end']),
  ]);

/**
 * Origin pulls from MenuMesh's own CA (the server team's review, their commitment 3; VPS-136). The
 * owner makes the CA and a client certificate for client authentication alone, which Caddy's check
 * requires, each -subj kept from Git Bash's path rewriting, and checks the pair with openssl;
 * uploads the client pair at the zone level, never the global toggle's shared certificate; keeps
 * the keys in the password manager and off the server; and the admin gets the two certificates
 * alone, which a new server takes from the password manager too.
 */
const ownCA = (runbook: string) =>
  inPlaces(
    runbook,
    ['zoneStep', 'zoneMove', 'recoveryEdge'],
    ({ zoneStep, zoneMove, recoveryEdge }) => {
      const lines = zoneStep.split('\n').map((line) => line.trim());
      return [
        ...['extendedKeyUsage=clientAuth', '-days 3650', '-days 825', AOP_VERIFY]
          .filter((words) => !lines.some((line) => line.includes(words)))
          .map(
            (words) =>
              `First install, step 8, makes the origin pulls’ certificates without ${words}`,
          ),
        ...lines
          .filter((line) => line.includes("-subj '/") && !line.startsWith('MSYS_NO_PATHCONV=1 '))
          .map((line) => `a -subj that Git Bash turns into a path: ${line}`),
        ...(has(zoneStep, 'never the global toggle')
          ? []
          : [
              'First install, step 8, doesn’t keep to zone-level pulls with MenuMesh’s certificate',
            ]),
        ...(has(zoneStep, 'The admin gets only `aop-ca.pem` and `aop-client.pem`') &&
        has(zoneStep, "the CA's key never goes to a server")
          ? []
          : ['First install, step 8, gives the server more than the two certificates']),
        ...(has(
          zoneMove,
          "with MenuMesh's own client certificate, which the owner makes and uploads",
        )
          ? []
          : [
              'part 1 doesn’t say the owner makes and uploads the origin pulls’ client certificate',
            ]),
        ...(has(recoveryEdge, '`aop-ca.pem`, `aop-client.pem` and `edge.env` from the')
          ? []
          : ['disaster recovery’s edge doesn’t take both certificates from the password manager']),
      ];
    },
  );

/**
 * The leak test's container (the server team's review, Q8; VPS-137). The RUNBOOK named neither an
 * image nor a command, so the container could have been anything, pinned or not. It is
 * traefik/whoami by its index digest, pulled first, then run with LEAK_FLAGS, never with the
 * kit.throwaway label, which hostwatch's limits check passes over; its UPSTREAMS entry goes in
 * before it starts, the admin tells the server team's chat first, and the wrong-project alert it
 * brings is expected. Since their merged edge.md §6 (VPS-143) the entry names port 80 itself, and
 * the alert is hostwatch's whole line, on every 5-minute run, which Telegram gets once and then
 * every 6 hours.
 */
const leakContainer = (runbook: string) =>
  inPlaces(runbook, ['leakTest'], ({ leakTest }) => {
    const lines = leakTest.split('\n').map((line) => line.trim());
    const pulls = lines.filter((line) => line.startsWith('sudo docker pull '));
    const runs = lines.filter((line) => line.startsWith('sudo docker run '));
    const words = runs.length === 1 ? runs[0].split(' ').slice(3) : [];
    const image = words.at(-1) ?? '';
    const flags = ` ${words.slice(0, -1).join(' ')} `;
    const text = flat(leakTest);
    const entry = text.indexOf('`menumesh-leaktest:80` goes into `UPSTREAMS`');
    const pulled = text.indexOf(`sudo docker pull ${LEAK_IMAGE}`);
    const started = text.indexOf('sudo docker run ');
    return [
      ...(runs.length === 1
        ? [
            ...(image === LEAK_IMAGE
              ? []
              : [`the leak test’s container is not ${LEAK_IMAGE}: ${image}`]),
            ...LEAK_FLAGS.filter((flag) => !flags.includes(` ${flag} `)).map(
              (flag) => `the leak test’s container starts without ${flag}`,
            ),
            ...(flags.includes('kit.throwaway')
              ? [
                  'the leak test’s container carries the kit.throwaway label, which hostwatch’s limits check passes over',
                ]
              : []),
          ]
        : [`the leak test starts ${runs.length} containers with docker run, not 1`]),
      ...(pulls.length === 1 && pulls[0] === `sudo docker pull ${LEAK_IMAGE}` && pulled < started
        ? []
        : ['the leak test doesn’t pull its image by its digest before the container starts']),
      ...(started < 0 || (entry >= 0 && entry < started)
        ? []
        : ['the leak test doesn’t put its UPSTREAMS entry in before the container starts']),
      ...(has(leakTest, "tells the server team's chat before the container starts")
        ? []
        : ['the leak test doesn’t tell the server team’s chat before the container starts']),
      ...(has(
        leakTest,
        "hostwatch's 5-minute check reports `networks: edge network rules broken: menumesh-leaktest@edge-menumesh:wrong-project` on every run, as critical",
      ) && has(leakTest, 'Telegram gets it once, then again every 6 hours while it lasts')
        ? []
        : ['the leak test doesn’t say hostwatch’s wrong-project alert comes while it runs']),
      ...(has(leakTest, 'the image listens on port 80')
        ? []
        : ['the leak test doesn’t say the image listens on port 80']),
    ];
  });

/** The leak test's step 1 passes on what the server team's upstream snippet sets and removes. */
const VENDOR = join('deploy', 'vps', 'test', 'vendor', 'jainav-infotech');
const SNIPPETS = readFileSync(join(VENDOR, 'snippets.caddy'), 'utf8');
const UPSTREAM_SETS = ['X-Real-IP', 'X-Forwarded-For', 'CF-Connecting-IP', 'Sb-Forwarded-For'];
const UPSTREAM_DROPS = ['True-Client-IP', 'X-Client-IP', 'Forwarded'];

/**
 * The leak test's checks as their merged edge.md §6 words them (VPS-143). Step 1: whoami prints
 * the header names as Go writes them, and it passes when the four address headers hold the admin's
 * own address, X-Forwarded-Host the host, and the other three are gone, as the vendored upstream
 * snippet sets and removes them; menumesh.caddy adds no header of its own, so those are what its
 * upstreams get. Step 3: the origin's addresses time out, again with a temporary hPanel accept rule
 * for the admin's own address, removed after.
 */
const leakChecks = (runbook: string, snippets: string, site: string) =>
  inPlaces(runbook, ['leakTest'], ({ leakTest }) => {
    const upstream = (/\n\(upstream\) \{\n([\s\S]*?)\n\}/.exec(snippets)?.[1] ?? '')
      .split('\n')
      .map((line) => line.trim());
    const own = site
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(header|header_up|header_down|request_header)\b/.test(line));
    return [
      ...UPSTREAM_SETS.filter((name) => !upstream.includes(`header_up ${name} {client_ip}`)).map(
        (name) => `the server team’s upstream snippet doesn’t set ${name} to the client’s address`,
      ),
      ...(upstream.includes('header_up X-Forwarded-Host {host}')
        ? []
        : ['the server team’s upstream snippet doesn’t set X-Forwarded-Host to the host']),
      ...UPSTREAM_DROPS.filter((name) => !upstream.includes(`header_up -${name}`)).map(
        (name) => `the server team’s upstream snippet doesn’t remove ${name}`,
      ),
      ...own.map((line) => `menumesh.caddy sets a header of its own: ${line}`),
      ...(has(leakTest, 'their names as Go writes them (`X-Real-Ip`, `Cf-Connecting-Ip`)')
        ? []
        : ['the leak test’s step 1 doesn’t say whoami prints header names as Go writes them']),
      ...(has(
        leakTest,
        `${UPSTREAM_SETS.slice(0, -1)
          .map((name) => `\`${name}\``)
          .join(', ')} and \`${UPSTREAM_SETS.at(-1)}\`, each hold the admin's own address`,
      ) &&
      has(leakTest, '`X-Forwarded-Host` is `leaktest.menumesh.in`') &&
      has(
        leakTest,
        `${UPSTREAM_DROPS.slice(0, -1)
          .map((name) => `\`${name}\``)
          .join(', ')} and \`${UPSTREAM_DROPS.at(-1)}\` are absent`,
      ) &&
      has(leakTest, '`menumesh.caddy` adds no header of its own')
        ? []
        : [
            'the leak test’s step 1 doesn’t pass on the headers the upstream snippet sets and removes, which are MenuMesh’s upstreams’ own',
          ]),
      ...(has(
        leakTest,
        "again with a temporary hPanel accept rule for the admin's own address, removed after",
      )
        ? []
        : [
            'the leak test’s step 3 doesn’t run again with a temporary hPanel accept rule for the admin’s own address, removed after',
          ]),
    ];
  });

/** Whether `text` holds each of `words`, each after the end of the one before it. */
function inOrder(text: string, words: string[]): boolean {
  let from = 0;
  return words.every((word) => {
    const at = text.indexOf(word, from);
    from = at + word.length;
    return at >= 0;
  });
}

/** The server team's merged edge.env, as their edge.md §5, step 6, makes it (VPS-143). */
const NEWLINE_GUARD = '[ -z "$(tail -c1 ~/incoming/edge.env)" ] || echo >> ~/incoming/edge.env';
const APPEND = 'cat >> ~/incoming/edge.env';
/** Their check of the names and their values' lengths, copied from that step: it prints no value. */
const NAMES_CHECK = `awk '/^[A-Za-z_][A-Za-z0-9_]*=/ {i = index($0, "="); k = substr($0, 1, i - 1); n[k]++; printf "%s(%d) ", k, length($0) - i} END {for (k in n) if (n[k] > 1) printf "TWICE:%s ", k; print ""}' ~/incoming/edge.env`;
/** Rotation's removal of the old hash's line from the copy, as a second line of a name is refused. */
const HASH_OUT = "sed -i '/^MENUMESH_STAGING_AUTH_HASH=/d' ~/incoming/edge.env";
const EXAMPLE = readFileSync(join('deploy', 'vps', 'edge', 'edge.env.example'), 'utf8');

/**
 * edge.env merged in the server team's form (their edge.md §5, step 6; VPS-143), where `(echo; cat)`
 * left a blank line whenever the copy ended in its line end: the copy, the newline guard, the lines
 * pasted into `cat >>`, which expands nothing of a hash's `$`, then their check of the names and
 * lengths, before the install, with what it must show for MenuMesh's two lines, and the two lines
 * kept in the password manager, as the edge has no settings archive. Rotation's new hash goes
 * through the same copy, its old line taken out first, and disaster recovery's lines through the
 * same steps; edge.env.example's header gives the same commands and points at step 11.
 */
const mergedCopy = (runbook: string, example: string) =>
  inPlaces(
    runbook,
    ['vps', 'edgeStep', 'stagingPassword', 'recoveryEdge'],
    ({ vps, edgeStep, stagingPassword, recoveryEdge }) => {
      const text = flat(edgeStep);
      const header = flat(example);
      return [
        ...[NEWLINE_GUARD, APPEND, NAMES_CHECK]
          .filter((words) => !text.includes(words))
          .map((words) => `First install, step 11, lacks ${words}`),
        ...(inOrder(text, [EDGE_COPY, NEWLINE_GUARD, APPEND, NAMES_CHECK, EDGE_ENV])
          ? []
          : [
              'First install, step 11, doesn’t merge edge.env in the server team’s order: the copy, the newline guard, cat >>, the check of names and lengths, then the install',
            ]),
        ...(vps.includes('(echo; cat)')
          ? ['the RUNBOOK still appends to edge.env with (echo; cat)']
          : []),
        ...(has(edgeStep, 'none with `(0)`, no `TWICE:`') &&
        has(edgeStep, 'then `MENUMESH_STAGING_AUTH_USER(8)`') &&
        has(
          edgeStep,
          '`MENUMESH_STAGING_AUTH_HASH(62)`: a 60-character bcrypt hash and its two quotes',
        )
          ? []
          : ['First install, step 11, doesn’t say what the check of names and lengths must show']),
        ...(has(edgeStep, 'The two lines also go into the password manager')
          ? []
          : ['First install, step 11, keeps MenuMesh’s edge.env lines on the server alone']),
        ...(has(stagingPassword, "through that step's merged copy") &&
        has(stagingPassword, HASH_OUT) &&
        has(stagingPassword, "then that step's check of the names and lengths")
          ? []
          : [
              'Rotation doesn’t put staging’s new hash in through step 11’s merged copy, its old line out first and the names and lengths checked',
            ]),
        ...(has(
          recoveryEdge,
          "through that step's copy, newline guard and `cat >>`, its check of the names and lengths",
        )
          ? []
          : [
              'disaster recovery’s edge doesn’t merge MenuMesh’s lines into the new server’s edge.env as First install, step 11, does',
            ]),
        ...[EDGE_COPY, NEWLINE_GUARD, EDGE_ENV]
          .filter((words) => !header.includes(words))
          .map((words) => `edge.env.example’s header lacks ${words}`),
        ...(has(example, 'docs/RUNBOOK.md, First install, step 11')
          ? []
          : ['edge.env.example’s header doesn’t point at First install, step 11']),
      ];
    },
  );

/** The recreate's checks and its way back (their edge.md §5, step 7; VPS-143). */
const EDGE_PS = 'sudo app-compose edge ps';
const EDGE_VALIDATE = 'sudo app-apply edge validate';
const CADDY_JOURNAL = 'sudo journalctl CONTAINER_NAME=edge-caddy-1 -n 20 -o cat --no-pager';
const EDGE_BACK = 'sudo app-apply edge env /var/lib/app-apply/srv/edge/edge.env.<time>';
const APP_APPLY = readFileSync(join(VENDOR, 'app-apply'), 'utf8');
/** What the vendored app-apply does that the recreate's checks and way back tell the admin. */
const KEPT = [
  'EDGE_DIR=/srv/edge',
  'KEEP_DIR=/var/lib/app-apply',
  'CADDY_CONTAINER=edge-caddy-1',
  'stamp=$(date -u +%Y%m%dT%H%M%SZ)',
  'if [ "${#copies[@]}" -gt 5 ]',
  'keep_previous "$EDGE_DIR/edge.env"',
  'say "the live edge tree is valid"',
];

/**
 * The recreate checked, with a way back (their edge.md §5, step 7; VPS-143): after
 * `app-compose edge up -d`, `edge ps` and `edge validate`, what each shows when it worked, Caddy's
 * journal when it didn't, and the edge.env the install replaced put back from where app-apply keeps
 * it, which the vendored app-apply must still do as the step says: /var/lib/app-apply plus the live
 * file's path, the name with its UTC stamp, five kept, and validate's line.
 */
const recreateChecked = (runbook: string, appApply: string) =>
  inPlaces(runbook, ['edgeStep'], ({ edgeStep }) => {
    const text = flat(edgeStep);
    return [
      ...KEPT.filter((words) => !appApply.includes(words)).map(
        (words) =>
          `the vendored app-apply has no ${words}, which First install, step 11, tells the admin`,
      ),
      ...(inOrder(text, [EDGE_ENV, RECREATE, EDGE_PS, EDGE_VALIDATE, EDGE_BACK])
        ? []
        : [
            'First install, step 11, doesn’t check Caddy and the live tree after the recreate, with its way back after them',
          ]),
      ...(has(edgeStep, '`edge-caddy-1` is `Up` and turns `(healthy)` within about a minute') &&
      has(edgeStep, '`validate` prints `the live edge tree is valid`') &&
      has(edgeStep, CADDY_JOURNAL)
        ? []
        : [
            'First install, step 11, doesn’t say what the recreate’s checks show, or where to look when they fail',
          ]),
      ...(has(
        edgeStep,
        'keeps the last five it replaced as `edge.env.<time>`, the time in UTC (`YYYYMMDDTHHMMSSZ`), in `/var/lib/app-apply/srv/edge/`',
      )
        ? []
        : ['First install, step 11, doesn’t say where app-apply keeps the edge.env it replaced']),
    ];
  });

/** Their edge.md §5, step 2: both edge networks internal, and Caddy on each. */
const NETWORK_CHECK =
  "sudo docker network inspect -f '{{.Name}} internal={{.Internal}}:{{range .Containers}} {{.Name}}{{end}}' edge-menumesh edge-menumesh-staging";

/**
 * Where the RUNBOOK says the edge networks exist already, at First install, step 15 (ask 4;
 * VPS-135), the server team's own check of them, as their merged edge.md §5, step 2, gives it
 * (VPS-143), with what each line shows.
 */
const networksChecked = (runbook: string) =>
  inPlaces(runbook, ['composeStep'], ({ composeStep }) =>
    has(composeStep, NETWORK_CHECK) &&
    has(composeStep, 'whose two lines each show `internal=true` and `edge-caddy-1`')
      ? []
      : [
          'First install, step 15, doesn’t check that both edge networks are internal, with Caddy on each',
        ],
  );

/** Their kit on the server, with their fix of hostwatch's alerts by commit and PR (VPS-146). */
const HOSTWATCH_FIX =
  "their kit is refreshed on the server with their fix of hostwatch's alerts in it, merged as `ccb9388` (nanu1605/jainav-infotech#87)";
/** The refresh and their word before the recreate night's edge.env lines (VPS-146). */
const REFRESH_FIRST = "The refresh and their word come before that night's `edge.env` lines";
/** On an earlier night, or first on that night, as the server team plans the refresh (VPS-146). */
const REFRESH_NIGHT = "on an earlier night, or as that night's first step";

/**
 * The recreate night waits for the server team's fix of hostwatch's alerts on the server (their
 * PR #87; VPS-146). Since 2026-11-08 the alerts that hostwatch's 5-minute and daily runs raise
 * reach no one on Telegram, and the staging night's leak test, which comes after that night, and
 * backup turning unhealthy rely on them. The fix reaches the server with their kit's refresh, and
 * their kit records no commit there: so step 11's (a) names the fix in that refresh, by its commit
 * and PR, and the admin goes by the server team's word in their chat, as for step 16. The refresh
 * is the first step of their re-apply night, which may be the recreate night itself, and from
 * `app-apply edge env` until the recreate, app-apply refuses the edge's commands: so (a) takes the
 * refresh and their word before that night's edge.env lines, on an earlier night or as that night's
 * first step, and never holds the night back for them.
 */
const alertsFixed = (runbook: string) =>
  inPlaces(runbook, ['edgeStep'], ({ edgeStep }) => {
    const wait = part(flat(edgeStep), ' - (a) ', ' - (b) ') ?? '';
    return [
      ...(has(wait, HOSTWATCH_FIX)
        ? []
        : [
            'First install, step 11, recreates Caddy before the server team’s kit on the server holds their fix of hostwatch’s alerts',
          ]),
      ...(has(wait, 'which the server team confirms in their chat')
        ? []
        : [
            'First install, step 11, doesn’t wait for the server team’s word in their chat that their kit on the server holds the fix',
          ]),
      ...(has(wait, REFRESH_FIRST)
        ? []
        : [
            'First install, step 11, doesn’t put the server team’s refresh and their word before the recreate night’s edge.env lines',
          ]),
      ...(has(wait, REFRESH_NIGHT)
        ? []
        : [
            'First install, step 11, holds the recreate night back for the server team’s refresh, which may be that night’s first step',
          ]),
    ];
  });

/** First install's step 8 at 21a13bf: origin pulls left to "the admin's certificate". */
const OLD_ZONE_STEP = [
  '8. **The zone:** `menumesh.in` on Cloudflare, moved from GoDaddy with its settings (The server',
  '   rehearsal and the cut-over, part 1), Full (strict), with zone-level authenticated origin pulls',
  "   ready for the admin's certificate (the server team's `edge.md` §3).",
].join('\n');

/** First install's step 9 at 21a13bf: the conf alone. */
const OLD_CONF_STEP = [
  '9. `/etc/apps/menumesh.conf` as above, `BACKUP_RECIPIENT` filled in:',
  "   `grep '^BACKUP_RECIPIENT=' /etc/apps/menumesh.conf` prints the owner's `age1…` key.",
].join('\n');

/** First install's step 11 at 21a13bf, up to the hash: no aop-ca.pem, and edge.env as two lines. */
const OLD_EDGE_STEP = [
  '11. The edge: the Origin CA certificate for `menumesh.in` and `*.menumesh.in` from a CSR made on the',
  '    server (`sudo app-apply edge cert menumesh origin.pem origin-key.pem`), the snippet of',
  '    `deploy/vps/edge/tls_menumesh.caddy` added to `snippets.caddy`',
  '    (`sudo app-apply edge config snippets.caddy`), and authenticated origin pulls on, **before any',
  "    MenuMesh container runs**: the CSR, the order and the origin test are `edge.md` §3's, whose",
  '    step 5 must see a TLS connection to the server without the client certificate refused (§6,',
  "    step 4). For `menumesh.in` that test proves nothing yet: until MenuMesh's site file is in, no",
  "    site imports `tls_menumesh`, so its `client_auth` guards none of MenuMesh's hosts, whatever the",
  '    test prints. The test that proves it runs right after the site file, on the staging night (The',
  '    server rehearsal and the cut-over, part 3, step 1). Then the two lines of',
  '    `deploy/vps/edge/edge.env.example` in `/srv/edge/edge.env`, installed with',
  '    `sudo app-apply edge env edge.env` and `sudo app-compose edge up -d` between 01:00 and 07:00',
  '    IST, as recreating Caddy drops every connection on the shared edge. The hash comes from the',
  "    owner, who makes it on their own machine with the edge's Caddy image, never on the server: there",
  "    staging's password would stay in the shell's history and show in the process list. Without",
  '    `--plaintext`, Caddy reads the password from the terminal without echoing it, and the admin gets',
  '    only the hash:',
].join('\n');

/** Part 1's line on origin pulls at 21a13bf. */
const OLD_PULLS_LINE =
  "   - Authenticated origin pulls come with the admin's certificate (First install, steps 8 and 11).";

/** Disaster recovery's step 8 at 21a13bf: the redaction file with the site file, at the end. */
const OLD_RECOVERY_EDGE = [
  '  8. The edge, by the admin: new certificates from fresh CSRs, `aop-ca.pem` and `edge.env` from the',
  '     password manager, then the site and redaction files from this repository, the leak test, and',
  '     DNS to the new address.',
].join('\n');

/** The restore test's and the drill's timing at 21a13bf: the third week, the drill after it. */
const OLD_RESTORE_TIME = [
  '- **The monthly restore test**, in the third week of the month (the first one before the first',
  '  restaurant), never while hostwatch reports the server throttled.',
].join('\n');
const OLD_DRILL_TIME = [
  '- **The monthly point-in-time drill**, right after the restore test and with the same key on its',
  '  ramfs (before the `rm` and `umount` of the key):',
].join('\n');

/** The leak test at 21a13bf: MenuMesh's pieces, but no image and no command for its container. */
const LEAK_TEST_21A13BF = [
  "2. **The leak test**, by the admin (the server team's `edge.md` §6), through a temporary `A` record",
  "   `leaktest.menumesh.in` to the server's IPv4, proxied, which the owner adds, before any app record",
  "   moves (VPS-115), with MenuMesh's pieces in place of theirs: an app has one site file, whose hosts",
  '   stay in its `ZONE` and whose upstreams are its `UPSTREAMS`. Their step 1 here: the throwaway',
  "   container that answers with the request's headers runs on `edge-menumesh` as `menumesh-leaktest`",
  '   (an upstream is `menumesh-<name>:<port>`); `menumesh-leaktest:<port>` goes into `UPSTREAMS` in',
  '   `/etc/apps/menumesh.conf` for the test; and a temporary copy of `menumesh.caddy` with one more',
  '   block, which imports what the others import, is installed with',
  '   `sudo app-apply menumesh site ~/incoming/menumesh-leaktest.caddy`:',
  '',
  '   ```text',
  '   https://leaktest.menumesh.in {',
  '       import site_common',
  '       import tls_menumesh',
  '       reverse_proxy menumesh-leaktest:<port> {',
  '           import upstream',
  '       }',
  '   }',
  '   ```',
  '',
  "   Until the container stops, hostwatch reports it, as for the server team's own test: its check of",
  '   the edge networks as `wrong-project` (it is no service of the compose project), and as',
  '   `not-an-upstream` too unless it was started with `--network-alias menumesh-leaktest` (hostwatch',
  "   reads the container's network aliases, not its name); and its check of the limits, unless it was",
  '   started with `--memory` and `--cpus`. Their steps 1 to 4 must then show: forged headers replaced;',
  '   the log line without an address, a header or a query, and a made-up 16-character `/t/` token in',
  "   it shown as `/t/_`; nothing answering straight on the server's addresses, IPv4 and IPv6, even",
  '   with a temporary hPanel accept rule; and a TLS connection without the client certificate refused',
  "   (step 1's test, the leak test's host added).",
  '',
  '   Their step 5 here, in this order: `menumesh.caddy` as it is installed again,',
  "   `sudo app-apply menumesh site ~/incoming/menumesh.caddy` (never removed: it is the zone's only",
  '   site file); the container stopped; its `UPSTREAMS` entry taken out; and the owner deletes the',
  '   `leaktest` record. Way back: the same four.',
  '',
  '',
].join('\n');

/** First install, step 11's edge.env at ac976ce: `(echo; cat)`, no check, the recreate unchecked. */
const EDGE_ENV_AC976CE = [
  '    `edge.env` comes last. From `app-apply edge env` until Caddy is recreated, `app-apply` refuses',
  '    every change that reloads Caddy, a site file, `edge config`, `edge redact` or `edge cert`, the',
  "    server team's own among them (`edge.env differs from what edge-caddy-1 was created with`). So",
  '    the order is the certificate, then the snippet, then (the redaction file in since step 9)',
  '    `edge.env`, then the recreate, the last two on the same night, with nothing of the edge between',
  '    them. `app-apply edge env` puts the file it is given in place of the live one, so `edge.env` is',
  "    one merged file, as the server team's `edge.md` gives it: the live file copied, the two lines of",
  "    `deploy/vps/edge/edge.env.example` appended with the owner's hash on lines of their own (the",
  '    `echo` first: a live file whose last line has no line end would take the first of them into its',
  '    value, and a blank line is skipped), the copy installed and then shredded. A copy that',
  '    `app-apply` refuses is shredded all the same (`shred -u ~/incoming/edge.env`) unless it is',
  "    mended and run again at once: it holds the server team's values too.",
  '',
  '    ```sh',
  `    ${EDGE_COPY}`,
  '    (echo; cat) >> ~/incoming/edge.env     # paste the two lines, the hash in its single quotes, then Ctrl-D',
  `    ${EDGE_ENV}`,
  `    ${RECREATE}     # between 01:00 and 07:00 IST, on the night the owner picks`,
  '    ```',
  '',
  '    The recreate drops every connection on the shared edge, hence the window. It also takes the',
  "    server team's digest pin of Caddy (their `edge.conf`'s `CADDY_IMAGE`, VPS-130): one recreate for",
  '    both. That night comes only after:',
  '',
].join('\n');

/** Rotation's staging password at ac976ce: the hash line edited, no check of names and lengths. */
const ROTATION_AC976CE = [
  "- Staging's password: a new hash, made off the server as in First install, step 11, which the admin",
  "  puts in `edge.env` through that step's merged copy, its `MENUMESH_STAGING_AUTH_HASH` line given",
  '  the new hash in an editor, as a second line of that name is refused (`app-apply edge env`, then',
  '  recreate Caddy between 01:00 and 07:00 IST, as it drops every connection on the shared edge); the',
  '  GitHub secret `STAGING_SMOKE_BASIC_AUTH`; and the testers.',
  '',
].join('\n');

/** Disaster recovery's step 8 at ac976ce: edge.env from the password manager, never merged. */
const RECOVERY_EDGE_AC976CE = [
  "  8. The edge, by the admin: the redaction file right after step 1's conf (First install, step 9),",
  '     then new certificates from fresh CSRs, `aop-ca.pem`, `aop-client.pem` and `edge.env` from the',
  "     password manager, in First install, step 11's order, then the site file from this repository,",
  "     the leak test, and DNS to the new address. The origin pulls' CA and client certificate stay as",
  '     they were, the client pair at Cloudflare too.',
].join('\n');

/** The leak test at ac976ce: `<port>`, a copy of the repository's menumesh.caddy, four steps back. */
const LEAK_TEST_AC976CE = [
  "2. **The leak test**, by the admin (the server team's `edge.md` §6), through a temporary `A` record",
  "   `leaktest.menumesh.in` to the server's IPv4, proxied, which the owner adds, before any app record",
  "   moves (VPS-115), with MenuMesh's pieces in place of theirs: an app has one site file, whose hosts",
  "   stay in its `ZONE` and whose upstreams are its `UPSTREAMS`. The admin, who runs the server's",
  "   steps, tells the server team's chat before the container starts. Their step 1 here, in this",
  '   order: `menumesh-leaktest:<port>` goes into `UPSTREAMS` in `/etc/apps/menumesh.conf` for the test',
  '   (`<port>` is 80, where the image listens); the throwaway container that answers with the',
  "   request's headers runs on `edge-menumesh` as `menumesh-leaktest` (an upstream is",
  '   `menumesh-<name>:<port>`), from an image pinned by its index digest and pulled first, so that a',
  '   failed pull shows on its own, with no capability, no new privileges and a read-only root, and',
  "   without the `kit.throwaway` label, which only `app-apply`'s own containers carry (`--rm` removes",
  '   it once it is stopped):',
  '',
  '   ```sh',
  `   sudo docker pull ${LEAK_IMAGE}`,
  `   sudo docker run ${LEAK_FLAGS.join(' ')} ${LEAK_IMAGE}`,
  '   ```',
  '',
  '   and a temporary copy of `menumesh.caddy` with one more block, which imports what the others',
  '   import, is installed with `sudo app-apply menumesh site ~/incoming/menumesh-leaktest.caddy`:',
  '',
  '   ```text',
  '   https://leaktest.menumesh.in {',
  '       import site_common',
  '       import tls_menumesh',
  '       reverse_proxy menumesh-leaktest:<port> {',
  '           import upstream',
  '       }',
  '   }',
  '   ```',
  '',
  '   Until the container stops, hostwatch raises a critical',
  '   `networks: … menumesh-leaktest@edge-menumesh:wrong-project` every 5 minutes (it is no service of',
  "   the compose project), which the chat expects, as for the server team's own test. Its",
  "   `--network-alias` keeps hostwatch from adding `not-an-upstream` (hostwatch reads the container's",
  '   network aliases, not its name), and its `--memory` and `--cpus` keep it from a limits alert.',
  '   Their steps 1 to 4 must then show: forged headers replaced; the log line without an address, a',
  '   header or a query, and a made-up 16-character `/t/` token in it shown as `/t/_`; nothing',
  "   answering straight on the server's addresses, IPv4 and IPv6, even with a temporary hPanel accept",
  "   rule; and a TLS connection without the client certificate refused (step 1's test, the leak",
  "   test's host added).",
  '',
  '   Their step 5 here, in this order: `menumesh.caddy` as it is installed again,',
  "   `sudo app-apply menumesh site ~/incoming/menumesh.caddy` (never removed: it is the zone's only",
  '   site file); the container stopped; its `UPSTREAMS` entry taken out; and the owner deletes the',
  '   `leaktest` record. Way back: the same four.',
  '',
  '',
].join('\n');

/** edge.env.example's header at ac976ce, from its fourth line: no newline guard and no check. */
const EXAMPLE_HEADER_AC976CE = [
  "# of the live one. So the server's admin copies the live file under umask 077,",
  `#   ${EDGE_COPY}`,
  "# appends the two lines below to it with the owner's hash, installs it with",
  `#   ${EDGE_ENV}`,
  '# and recreates Caddy between 01:00 and 07:00 IST (sudo app-compose edge up -d), which reads',
  '# edge.env only when it is created. Values never in git: the password and its hash live in the',
  "# owner's password manager.",
].join('\n');

/** First install, step 11's (a) at 4fb9e7b: their kit refreshed, and the fix not named. */
const NIGHT_WAIT_4FB9E7B = [
  "    - (a) the server team's two PRs, their scripts and their onboarding, are merged, and their kit",
  '      is refreshed on the server;',
].join('\n');

/** First install, step 11's (a) at 776eb08: the fix and their word, with no time of their own. */
const NIGHT_WAIT_776EB08 = [
  "    - (a) the server team's two PRs, their scripts and their onboarding, are merged, and their kit",
  "      is refreshed on the server with their fix of hostwatch's alerts in it, merged as `ccb9388`",
  '      (nanu1605/jainav-infotech#87), which the server team confirms in their chat, as for step 16',
  "      (their kit records no commit on the server): until then the alerts that hostwatch's 5-minute",
  "      and daily runs raise reach no one on Telegram, and the staging night's leak test and `backup`",
  '      turning unhealthy (Logs and alerts (VPS), WAL alerts) rely on them (VPS-146);',
].join('\n');

/** First install, step 11's snippet at b2558c3: a working tree's file, sent unchecked, installed. */
const SNIPPET_B2558C3 = [
  '    Then the snippet, as their `edge.md` §5, step 5, installs it: their own `snippets.caddy`, which',
  "    holds `tls_menumesh` with `client_auth` on since their `66c8c61`, as MenuMesh's origin pulls",
  '    are on before any of its containers runs. The admin copies it from the root of their',
  "    repository, at that commit or a later one, on the admin's own machine, then installs it, which",
  "    checks every installed site again. MenuMesh's kit never adds a snippet to the server's file:",
  "    Caddy refuses a snippet declared twice, and the file stays the same as their repository's,",
  '    whose next `edge config` would drop a snippet added here:',
  '',
  '    ```sh',
  `    ${TREE_COPY} ops@<the tunnel's SSH host>:incoming/     # on the admin's machine, in their repository's root`,
  `    ${SNIPPET}`,
  '    ```',
  '',
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
  'that the stolen key, or an older',
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
  '<each key of the list it does not keep>`',
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
  'key of that list signed a night the backup never ran: take that key for stolen (step 5)',
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
  // Read by the rules of the seventh re-review, with has() or from folded text: item 3's line
  // before step 7's deploy, the clauses of items 1 and 2 pinned, step 5's reason, the owner's note.
  "line of `deploys.log` before step 7's deploy",
  'release that stayed live is then the one live just before that deploy began, read from',
  "(`PITR_ACCEPT_CUT`) or before `deploys.log`'s last production line",
  'After a recovery to `latest` on the same server',
  '`migrate: applied <file>` line comes only after its file',
  'Then note,',
  'server too, as for a release (Production, step 2)',
  // The backup's records a night and a key are judged by, where they reach, the key of a list that
  // signed, the drill's count once a key has left the list, and the drill's night checked.
  "same server the journal's lines and the backup monitor's pings from the server's own address",
  "inside the night's window, never a Telegram message; after a rebuild, those pings alone:",
  'over its 180 days, or from the first',
  "can't reach, after a rebuild, those pings alone",
  'A ping from elsewhere, two `backup` pings',
  "different ids in one night's window but for a run by hand",
  'backup --since -180d --utc -o short-iso',
  'and reach its stamp (no reach as root',
  "An older month's copy, stamped before the records reach",
  'list of several signed a seal, check it with each key of the list alone, in a file of one key',
  "each: only the signer's gets past the seal",
  'as from an old copy of `.env`, each other key of the list whose private half was on the server',
  'or once a key has left the list, n above',
  "that id against the backup's own journal line, as for the restore test",
  // The versions put back: the backup's own removal's markers kept, a seal's version from the
  // backup's own run, two that verify taken for a stolen key, and what was put over deleted.
  "but for the backup's own removal, which in a night's run removes what",
  'stamp to its line in the journal), is that removal and stays',
  'Only a marker over a younger version or a history file, or a second version not alike',
  "for a seal, the one that went up in the backup's own",
  'Two versions of a seal that a list verifies, not',
  "(by a stolen key's file only for a night from before its theft; after a leaked",
  'for a WAL file, its first, as nobody can name one before its upload',
  'Delete what someone else put over it to make it',
  // The orders the seventh re-review's design notes found unpinned: 2.4's newest key before the
  // conf's check of that same key.
  'two commands print the same `age1…` key',
  // And the clauses its design notes found loose besides: item 2's migrations, item 3's time, and
  // the reached server's alerts as its scripts send them.
  'or at least before its migrations ran (step 5)',
  'that line is later than that time; on a new server',
  '`the upload of <walfile> to the bucket failed (rclone)`',
  'backup fails at `reaching the bucket`',
  // Read by the rules of the eighth re-review, with has() or from folded text: the records on the
  // same server and after a rebuild, the journal's reach, a night that sent no ping, the window
  // and what a ping names, and the signs, in step 2 and in sub-step 4.
  'line the command prints where it holds less (a full journal or a vacuum cuts it short:',
  'never a Telegram message, and the',
  "from the server's own address inside the night's window",
  "a day after it, so a long base's late ping counts)",
  'which none can send without root, so a',
  "the server's own address being the old server's",
  'Such a ping names its own night and the',
  'its seal or its ping lost, as the monitor alerted that day unless a run by hand pinged first: on',
  "journal's reach that the journal does not name, on a day journald dropped no lines (hostwatch's",
  'is itself a sign the `.env` leaked (step 5)',
  'never a Telegram message',
  'Two `backup` lines',
  'inside its night (from its stamp to a day after it, so a',
  // The stolen key's file: every key of the list on the server since the trouble, its first among
  // them, in step 2, sub-step 1, sub-step 4, 2.2 and Rotation.
  "the first among them, goes into the stolen key's file with it",
  "Where that is not the list's first key,",
  'the list whose private half was on the server since the trouble could have begun, the list',
  'Then recover it, when a key of that file signed it',
  'That file holds the stolen key and every other key the list held whose private half was',
  'signed: one that an older key of the kept list',
  'So does every other key of the list whose private half was on the',
  // Disaster recovery's step 2 named by the old server's own pings, and step 5's night checked.
  "inside its night's window (from its stamp to a day after it, so a long base's late ping",
  'a ping from elsewhere, or two naming different ids in one',
  "Telegram's failure lines, which that `.env`",
  "the one its line `pitr: to <point>, from the night of <id>: …` names against the backup's own",
  // The owner's note with both times, each in its own bullet, and step 7 on a new server going by
  // the time a release went live, from the notes of each deploy since the archive.
  "the one the owner's own notes of each",
  "deploy since step 2's archive leave live, step 7's own not counted, or with none since, the",
  "archive is only in the owner's own notes of each deploy since it",
  "server the owner's notes count a release as live at a time, or as gone live since it, by the",
  "time it went live, as these lines do; step 5's bound goes by the time its deploy began",
  'read from its `deploying` line',
  'rather than from memory, the time it went',
  'live, from its new line in `deploys.log` (`sudo tail -1 /srv/menumesh/deploys.log`), the',
  'the times it began and went live (UTC), the',
  'and that the one rolled back did not stay live',
  'never the **VPS release** runs alone',
  // Read by the rules of the ninth re-review: after a rebuild, a night of a nightly's slot that no
  // ping of that stamp names, a run by hand's not counted, and the records on the same server.
  "old server's stamped from a nightly's 20:30 UTC to the next, where no ping from its address names",
  "a night of that stamp (a run by hand's ping names its own, stamped at another time, and does not",
  "same server those records are the journal's lines above",
  // And disaster recovery's step 5, which checks its night against the records as the stolen-token
  // step 2 reads them.
  'records, as A stolen or leaked bucket token (VPS), step 2, reads them (on the same server the',
  "journal's lines and the server's own pings inside the night's window), before step 6 starts",
  'that sent no ping, as the monitor alerted that day (A stolen or leaked bucket token (VPS),',
  // Read by the cut-over's rules (Stop D): a piece of each phrase that stands on one line.
  "Vercel's records stay **DNS only**",
  "Vercel's records, its name, type and value",
  "back to Vercel's written-down values, DNS only",
  'before any app record moves',
  '**The `staging` record**',
  '`DEPLOY_STAGING` `false`',
  'and `VPS_DEPLOY_STAGING` are `true`, from the staging',
  '`CRON_SECRET` stays (part 6 takes it out)',
  'Schedules → Cron Jobs → **Enable Cron Jobs**',
  'General → **Pause project**',
  '**`BACKUP_PRODUCTION`** `false`',
  '`BACKUP_PRODUCTION` `true`',
  'For 14 days after the production night',
  'It loses nothing until the first real write on the server',
  'write is the point of no return',
  // Read by the rules of Stop D's review: a piece of each phrase that stands on one line.
  'that test proves nothing yet',
  'proves it runs right after the site file',
  'do curl -sk -o /dev/null',
  'menumesh up -d scheduler-staging',
  'menumesh stop scheduler-staging',
  '**Disable Cron Jobs**',
  'for the whole night:',
  'deploy as in First install, step 19',
  'run of that commit',
  "select 'auth', 'users'",
  'are the `auth` `users` row',
  'goes into `UPSTREAMS` in',
  'import site_common',
  'app-apply menumesh site',
  'its `UPSTREAMS` entry taken out',
  '(never removed:',
  'app-compose edge up -d',
  'between 01:00 and 07:00 IST',
  'waits for the staging night',
  "while it runs other than step 6's",
  "without the first admin's link and",
  'the Vercel parts retire, 14 days',
  // Read by the rules of Stop D's re-review: a piece of each phrase that stands on one line.
  "the staging night's step 5",
  'First install, step 20',
  "step 3 when the server's database still holds",
  "only what differs from hosted's `/super` that night",
  // Read by the rules of the server team's review: a piece of each phrase that stands on one line.
  'app-apply edge redact menumesh ~/incoming/log-redact.caddy',
  "the redaction file right after step 1's conf",
  'the order is the certificate, then the snippet',
  "server team's digest pin of Caddy",
  'its copy in `~/incoming` shredded',
  'Not before the server team confirms in their chat',
  'this step, and every step after it, waits',
  "Step 16 waits for the server team's",
  'on the second weekend of the month',
  'outside 20:20 to 21:30 UTC',
  'right after the restore test has ended, in the same',
  'never the global toggle',
  "the CA's key never goes to a server",
  "with MenuMesh's own client certificate, which the",
  "tells the server team's chat before the container starts",
  // Read by the rules of the copy at the server team's 66c8c61 (VPS-142): a piece of each phrase
  // that stands on one line.
  'has no `client_auth`, so its',
  'app-apply edge config ~/incoming/snippets.caddy',
  'holds `tls_menumesh` with `client_auth` on',
  "MenuMesh's kit never adds a snippet",
  // Read by the rules of the server team's merged edge.md (VPS-143): a piece of each phrase that
  // stands on one line.
  'When the admin stops, either way,',
  'none with `(0)`, no',
  'then `MENUMESH_STAGING_AUTH_USER(8)`',
  '`MENUMESH_STAGING_AUTH_HASH(62)`: a 60-character bcrypt hash and its two quotes',
  'two lines also go into the',
  "through that step's merged copy",
  "then that step's check of the names and lengths",
  "sed -i '/^MENUMESH_STAGING_AUTH_HASH=/d'",
  "through that step's copy, newline guard and",
  '`edge-caddy-1` is `Up` and turns `(healthy)`',
  'the live edge tree is valid',
  'sudo journalctl CONTAINER_NAME=edge-caddy-1 -n 20 -o cat --no-pager',
  'keeps the last five it replaced as',
  'the time in UTC (`YYYYMMDDTHHMMSSZ`)',
  'whose two lines each show `internal=true` and `edge-caddy-1`',
  "If one ends in 0, stop: the server team's round of origin pulls comes first",
  'the image listens on',
  "hostwatch's 5-minute check reports",
  '`networks: edge network rules broken: menumesh-leaktest@edge-menumesh:wrong-project` on every',
  'Telegram gets it once, then again',
  'their names as Go writes',
  "`X-Forwarded-For`, `CF-Connecting-IP` and `Sb-Forwarded-For`, each hold the admin's own",
  '`X-Forwarded-Host` is `leaktest.menumesh.in`',
  '`Forwarded` are absent',
  '`menumesh.caddy` adds no header of its own',
  "a temporary hPanel accept rule for the admin's own",
  // Read by the rules of the last review round (VPS-145): a piece of each phrase that stands on
  // one line.
  '&& shred -u ~/csr/origin-key.pem',
  'scp docker/edge/compose.yml',
  'app-apply edge compose ~/incoming/edge-compose.yml',
  // Read by the rule of the server team's fix of hostwatch's alerts (VPS-146): a piece of each
  // phrase that stands on one line.
  "their fix of hostwatch's alerts in it, merged as",
  'which the server team confirms in their chat',
  "come before that night's `edge.env` lines",
  REFRESH_NIGHT,
  // Read by the rules of the server team's own install of their snippets.caddy (VPS-147): a piece
  // of each phrase that stands on one line.
  'in Git Bash, not PowerShell',
  'their latest confirmation names',
  'must print the `snippets.caddy` sum that',
  'git -C <their checkout> show <commit>:docker/edge/config/snippets.caddy',
  'sha256sum snippets.caddy',
  SNIPPET_COPY,
  LIVE_SUM,
  COPY_SUM,
  'sudo cmp /srv/edge/config/snippets.caddy',
  '`SAME`, what their install leaves',
  DIFFERENT_STOP,
  "none of this step's lines below until they answer",
  'install their file themselves, and the three lines',
  'names another commit, must print `SAME`',
  'or they say in their chat to install that copy',
  "the server's file is always their file at a commit they",
  "and asks in the server team's chat as its `DIFFERENT` does",
  'the comparison prints `SAME` and every exit is not 0',
  THREE_THINGS,
  'Before the `edge.env` lines',
  "comes that step's comparison of the snippet",
  "on a rebuilt server the server team's edge comes",
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
      ' Where the bucket keeps versions, make the versions',
      ' Then recover it',
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
        '`BACKUP_SIGNING_PUBLIC_KEY=<the stolen key> <each key of the list it does not keep>`',
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
        cut(RUNBOOK, '        That file holds the stolen key', "That archive's `.env`"),
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
        cut(RUNBOOK, ' After a theft of the signing key, a night from before', ' Its `<id>` names'),
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
        ' names one stamped later\nthan now (`restore: not taking the night of <id>, stamped later than now`),',
        '',
        trigger,
      ],
      [
        "\n(`pitr: not taking the night of <id>: its seal …, so it is not the backup's`)",
        '',
        trigger,
      ],
      [
        "\n(`<n> objects passed over, not the backup's`, n above 0, or once a key has left the list, n above\nwhat the first drill since printed)",
        '',
        trigger,
      ],
      [
        'never ran: take that key for stolen (step 5).',
        'never ran: keep that key in the list.',
        key,
      ],
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
        " A line only keeps an id from going, never a version put over the backup's:",
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
        'never left the new one live: the\n        release is its old one.',
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

  it('takes a key for stolen only by the backup’s own records where they reach, finds which key of a list it was, and holds the drill’s count and night to them (Stop C’s seventh re-review, findings R1, R2, H1 and H2, theft design notes)', () => {
    expect(oldCopies(RUNBOOK)).toEqual([]);
    const records =
      'the stolen-token steps count a ping a leaked .env can send, or a Telegram message, among the backup’s records';
    const reach =
      'the stolen-token steps take the key of a month’s copy older than the records for stolen';
    const which =
      'the stolen-token steps never say which key of a list signed a night the backup never ran';
    const first =
      'the stolen-token steps keep the list’s first key nowhere when an older key of the list signed';
    const count =
      'the stolen-token steps take the history files of a key that left the list for a sign of theft';
    const drillNight = 'the drill never checks the night it takes against the backup’s own records';
    // As the sixth re-review's fixes left them: the trigger's and step 2's records with alert lines
    // and the monitor's log, 30 days of the journal shown, no reach, no key of a list found, any
    // count above 0, and no word of the drill's night.
    const before = swap(
      swap(
        swap(
          swap(
            RUNBOOK,
            cut(
              RUNBOOK,
              'restore test, drill or recovery takes a night that none',
              '\nbucket holds names the backup never writes',
            ),
            ROUND_7_SIGNS,
          ),
          '--since -180d --utc -o short-iso',
          '--since -30d -o cat',
        ),
        cut(RUNBOOK, '   A seal a list verifies that no record', '\n\n3. **Remove what'),
        ROUND_7_STOLEN_KEY,
      ),
      cut(RUNBOOK, ' Check\n  that id against', ' For a point instead'),
      '',
    );
    for (const problem of [records, reach, which, first, count, drillNight])
      refuses(oldCopies, before, problem);
    // Each part dropped or turned in turn.
    for (const [from, to, problem] of [
      [
        "inside the night's window, never a Telegram message; after a rebuild,",
        "inside the night's window, and alert lines; after a rebuild,",
        records,
      ],
      [
        "backup monitor's pings from the server's own address inside the night's window (from",
        "backup monitor's pings (from",
        records,
      ],
      [cut(RUNBOOK, ' A ping from elsewhere', ' To find which key'), '', records],
      [cut(RUNBOOK, " An older month's copy, stamped", ' A ping from elsewhere'), '', reach],
      ['and reach its stamp (no reach', '(no reach', reach],
      ['--since -180d --utc -o short-iso', '--since -30d -o cat', reach],
      [cut(RUNBOOK, ' To find which key', " Where that is not the list's first key,"), '', which],
      [
        cut(RUNBOOK, " Where that is not the list's first key,", ' That id stays all the same'),
        '',
        first,
      ],
      [
        ', or once a key has left the list, n above\nwhat the first drill since printed)',
        ')',
        count,
      ],
      [cut(RUNBOOK, ' Check\n  that id against', ' For a point instead'), '', drillNight],
    ])
      refuses(oldCopies, swap(RUNBOOK, from, to), problem);
  });

  it('makes .env’s backup key the newest before the conf is checked against that same key, judges the bucket again only after the revocation, and quotes the reached server’s alerts as sent (Stop C’s seventh re-review, design notes)', () => {
    expect(rootKeys(RUNBOOK)).toEqual([]);
    const conf =
      'step 2.4 checks the admin’s conf against the backup key the archive held, or before .env holds the newest one';
    const order = 'the theft’s step 5 does step 2 again before step 1’s token is revoked';
    // The conf checked against the archive's key.
    refuses(
      rootKeys,
      swap(
        RUNBOOK,
        'first check that it is that same key: the',
        "first check that it is that same key, the archive's: the",
      ),
      conf,
    );
    // The newest key put in only after the conf's check and the timer.
    const newestKey = cut(
      RUNBOOK,
      ' `BACKUP_AGE_RECIPIENT`\n        becomes the newest',
      '\n\n        Then, on a new server',
    );
    const timers = "        systemctl list-timers 'app-config-archive@*'\n        ```\n";
    refuses(
      rootKeys,
      swap(swap(RUNBOOK, newestKey, ''), timers, `${timers}\n       ${newestKey}\n`),
      conf,
    );
    // Step 2 done again before the revocation, with step 3's sentence kept.
    refuses(
      rootKeys,
      swap(
        swap(
          RUNBOOK,
          ', so only then is\n      step 2 done again, its versions among them, and only then does step 3 lift a lock.',
          ', so only then does step 3 lift a lock.',
        ),
        " The bucket's token goes new once more,",
        " First, so only then is step 2 done again, its versions among them. The bucket's token goes new once more,",
      ),
      order,
    );
    // The reached server's alerts after the revocation, quoted as the scripts send them (P3).
    const quoted =
      'the theft’s step 5 quotes alerts the reached server never sends once step 1’s token is revoked';
    expect(SHIPPER).toContain('stopped "the upload of $walfile to the bucket failed (rclone)"');
    expect(BACKUP).toContain("reason='reaching the bucket'");
    for (const [from, to] of [
      ['`the upload of <walfile> to the bucket failed (rclone)`', '`the WAL could not be shipped`'],
      ['backup fails at `reaching the bucket`', 'backup fails at `the seal`'],
    ])
      refuses(rootKeys, swap(RUNBOOK, from, to), quoted);
  });

  it('keeps the delete markers of the backup’s own removal, takes a seal’s version from its own run and two that verify for a stolen key, and deletes what was put over (Stop C’s seventh re-review, findings R3, R6 and R5, theft design notes)', () => {
    expect(oldCopies(RUNBOOK)).toEqual([]);
    const removal =
      'the stolen-token steps take the delete markers the backup’s own removal leaves for someone else’s deletions';
    const newest = 'the stolen-token steps make current the newest seal a list verifies';
    const kinds =
      'the stolen-token steps put back a version of a seal, part or WAL file that may not be the backup’s';
    const copied = 'the stolen-token steps copy a WAL file back';
    // As the sixth re-review's fixes left it: every delete marker someone else's, the newest seal a
    // list verifies, and no word of how a version is made current.
    const before = swap(
      RUNBOOK,
      cut(
        RUNBOOK,
        '   Where the bucket keeps versions (versioning, or S3 Object Lock)',
        '\n\n   A seal a list verifies that no record',
      ),
      ROUND_7_VERSIONS,
    );
    for (const problem of [removal, newest, copied]) refuses(oldCopies, before, problem);
    // Each choice turned or dropped in turn, the per-kind ones the review found no rule held.
    const sealChoice = cut(
      RUNBOOK,
      "the one that went up in the backup's own",
      ' (by a stolen key',
    );
    for (const [from, to, problem] of [
      [
        cut(RUNBOOK, ", but for the backup's own removal,", '\n\n   For each such name'),
        '.',
        removal,
      ],
      [' is that removal and stays,', ' is put back,', removal],
      ['younger version or a history file,', 'younger version,', removal],
      [sealChoice, 'the newest a list verifies as above', newest],
      [sealChoice, 'the oldest a list verifies as above', newest],
      [cut(RUNBOOK, ' Two versions of a seal', '\n   A line only keeps'), '', newest],
      [
        " (by a stolen key's file only for a night from before its theft; after a leaked\n   `.env`, step 5, only a version from before the trouble)",
        '',
        kinds,
      ],
      [
        "for a part, the one whose size and\n   sha256 its night's seal lists",
        "for a part, the one whose size its night's seal lists",
        kinds,
      ],
      [
        'for a WAL file, its first, as nobody can name one before its upload',
        'for a WAL file, its newest',
        kinds,
      ],
      [
        cut(RUNBOOK, ' Delete what someone else put over it', ' Two versions of a seal'),
        '',
        copied,
      ],
    ])
      refuses(oldCopies, swap(RUNBOOK, from, to), problem);
  });

  it('reads the release that stayed live off deploys.log before step 7’s deploy, and asks for the owner’s note of the day (Stop C’s seventh re-review, findings Q1 and Q2, deploy design notes)', () => {
    expect(releaseDeployed(RUNBOOK)).toEqual([]);
    expect(rewindRoute(RUNBOOK)).toEqual([]);
    const stayed =
      'step 7 reads the release that stayed live off deploys.log’s last production line, which after step 1’s deploy is step 7’s own';
    const noted =
      'Production and Rolling back by hand never ask for the owner’s own note of the day';
    const flushed = 'step 5 says a `migrate: applied` line may wait for the end of the run';
    // As the sixth re-review's fixes left them: item 3 read off deploys.log's last production
    // line, no note asked for, and a `migrate: applied` line said to wait for the end of the run.
    const before = swap(
      swap(
        swap(
          swap(
            RUNBOOK,
            cut(RUNBOOK, '     3. **The release that stayed live**', '\n\n  8. The edge'),
            ROUND_7_STAYED_LIVE,
          ),
          cut(RUNBOOK, ' Then note,\n     off the server', '\n\n  3. From this machine'),
          '',
        ),
        cut(RUNBOOK, ' Note it off the\n  server too', ' Migrations are never'),
        '',
      ),
      '     committed). On a new server,',
      '     committed, and may wait for the end of the run). On a new server,',
    );
    refuses(releaseDeployed, before, stayed);
    refuses(releaseDeployed, before, noted);
    refuses(rewindRoute, before, flushed);
    // The clauses the review found no rule held, each dropped in turn.
    for (const [from, to, problem] of [
      [
        cut(RUNBOOK, ' In 3 the\n', '\n\n     3. **The release that stayed live**'),
        '',
        'step 7 leaves out, after a recovery from before a bad release, the good release live just before its deploy',
      ],
      [
        " or before `deploys.log`'s last production line (as when WAL stopped\n        reaching the bucket before the loss)",
        '',
        'step 7 takes images.env’s release after `latest` on a new server, or after WAL that stopped',
      ],
      [
        'After a recovery to `latest` on the same server, unless',
        'After a recovery to `latest`, unless',
        'step 7 takes images.env’s release after `latest` on a new server, or after WAL that stopped',
      ],
      [" (the old image of step 7's own line)", '', stayed],
      [', when\n        that line is later than that time;', ';', stayed],
      [
        ', or at least before its migrations ran (step 5)',
        '',
        'step 7 sends out, after a recovery to a state from before a bad release, a later release',
      ],
      [' Then note,\n     off the server,', ' Then note,\n     on the server,', noted],
    ])
      refuses(releaseDeployed, swap(RUNBOOK, from, to), problem);
  });

  it('counts the server’s own pings and a night that sent no ping, reads the journal’s reach off its first line, and takes only different ids in a window for a sign (Stop C’s eighth re-review, findings T1, T2, H1 and H2)', () => {
    expect(oldCopies(RUNBOOK)).toEqual([]);
    expect(theftRecords(RUNBOOK)).toEqual([]);
    const records = 'the stolen-token steps count a ping a leaked .env can send';
    const sameServer = 'the stolen-token steps count on the same server the journal’s lines alone';
    const noPing =
      'the stolen-token steps take the key of a night that failed after its seal, or lost its ping';
    const window = 'the stolen-token steps hold a ping to about 2 hours after its night’s stamp';
    const reach = 'the stolen-token steps take the journal’s reach for its 180 days';
    const retried = 'the stolen-token steps take a ping that curl’s retry sent again';
    const retriedBefore = 'the theft’s step 5 takes a ping that curl’s retry sent again';
    const lateBefore =
      'the theft’s step 5 names a night from before the trouble only by a ping within about 2 hours';
    // As the seventh re-review's fixes left them: the journal's lines alone on the same server,
    // only a night killed after its seal excepted, the window 2 hours, the reach 180 days, and any
    // second ping in a window a sign, in step 2 and in sub-step 4.
    const before = swap(
      swap(
        swap(
          RUNBOOK,
          cut(RUNBOOK, "same server the journal's lines and", '), names one stamped later'),
          ROUND_8_TRIGGER,
        ),
        cut(RUNBOOK, '   A seal a list verifies that no record', '\n\n3. **Remove what'),
        ROUND_8_STOLEN_KEY,
      ),
      cut(
        RUNBOOK,
        "      from the server's own address and inside its night",
        ' Where the bucket keeps versions, make',
      ),
      ROUND_8_NIGHT_BEFORE,
    );
    for (const problem of [sameServer, noPing, window, reach, retried])
      refuses(oldCopies, before, problem);
    for (const problem of [retriedBefore, lateBefore]) refuses(theftRecords, before, problem);
    // Each clause dropped or turned in turn.
    for (const [from, to, problem] of [
      [
        " and the backup monitor's pings from the server's own address\ninside the night's window,",
        ',',
        sameServer,
      ],
      [cut(RUNBOOK, ', which none can send without root', '; only where the'), '', sameServer],
      [
        cut(RUNBOOK, 'and not a night that sent no ping', '), that a'),
        'and not a night killed after its seal, which leaves no line at all: the monitor alerted on it',
        noPing,
      ],
      [
        cut(
          RUNBOOK,
          ', and after a rebuild a night of the',
          ' is judged by its seal alone and is no sign of theft)',
        ) + ' is judged by its seal alone and is no sign of theft',
        '',
        noPing,
      ],
      [
        `${cut(RUNBOOK, "the night's window (from its stamp to", 'late ping counts)')}late ping counts)`,
        "the night's window (from its stamp to about 2 hours after)",
        window,
      ],
      [cut(RUNBOOK, ", the server's own address being", ', as sub-step 4 reads them'), '', window],
      [cut(RUNBOOK, ' Such a ping names', " An older month's copy"), '', window],
      [cut(RUNBOOK, ', or from the first', ', never a Telegram message, and'), '', reach],
      [
        cut(RUNBOOK, 'an alert naming a night', ', is itself a sign'),
        'an alert naming a night the whole journal does not name',
        reach,
      ],
      [cut(RUNBOOK, ', on a day journald', ', is itself a sign'), '', reach],
      [
        cut(RUNBOOK, 'A ping from elsewhere, two `backup` pings', " night's window but for a run"),
        'A ping from elsewhere, two `backup` pings in one',
        retried,
      ],
      [
        "can't reach, after a rebuild, those pings alone",
        "can't reach, after a rebuild, the backup monitor's whole log",
        records,
      ],
    ])
      refuses(oldCopies, swap(RUNBOOK, from, to), problem);
    for (const [from, to, problem] of [
      [
        cut(RUNBOOK, 'Two `backup` lines naming', ' or an id that no record'),
        "Two `backup` lines in one night's window,",
        retriedBefore,
      ],
      [
        `${cut(RUNBOOK, 'inside its night (from its stamp to', 'late ping counts)')}late ping counts)`,
        'inside its night (from its stamp to about 2 hours after)',
        lateBefore,
      ],
    ])
      refuses(theftRecords, swap(RUNBOOK, from, to), problem);
  });

  it('keeps apart every key of the list that was on the server since the trouble, the list’s first among them, wherever the stolen key’s file is defined (Stop C’s eighth re-review, finding T3)', () => {
    expect(theftList(RUNBOOK)).toEqual([]);
    expect(oldCopies(RUNBOOK)).toEqual([]);
    const file = 'the stolen key’s file leaves out a key of the list that was on the server since';
    const first = 'the stolen-token steps put only the list’s first key into the stolen key’s file';
    // As the seventh re-review's fixes left them: step 2 put the list's first key alone in that
    // file, and sub-step 1, sub-step 4, 2.2 and Rotation spoke of the older keys that may have
    // leaked.
    const before = swap(
      swap(
        swap(
          swap(
            swap(
              RUNBOOK,
              cut(RUNBOOK, ' So does every other key of the list', ' while one whose private half'),
              ' So does an older key whose private half may have leaked with it,\n ',
            ),
            cut(
              RUNBOOK,
              '        That file holds the stolen key',
              '\n        night, and that file',
            ),
            '        That file is for a night the stolen key, or an older key that may have leaked, signed:\n        one that an older key of the kept list signed is checked with the kept list, as any',
          ),
          cut(RUNBOOK, " Where that is not the list's first key,", ' That id stays all the same'),
          " Where that is not the list's first key,\n   as from an old copy of `.env`, the first goes into the stolen key's file with it (step 5), as its\n   private half was on the server since the trouble could have begun.",
        ),
        cut(RUNBOOK, ' The stolen key and every other key of', ' in a file\n      of their own'),
        ' The stolen key, and any older key\n      that may have leaked with it, are kept apart, as\n      `BACKUP_SIGNING_PUBLIC_KEY=<the stolen key> <each older key that may have leaked>`',
      ),
      'Then recover it, when a key of that file signed it,',
      'Then recover it, when the stolen key or an older key that may have leaked signed it,',
    );
    refuses(theftList, before, file);
    refuses(oldCopies, before, first);
    // Each clause dropped or turned in turn.
    for (const [from, to] of [
      [", the first among them where the thief's was an older\n  one,", ','],
      ['<each key of the list it does not keep>`', '<each older key that may have leaked>`'],
      [", the list's\n      first among them,", ''],
      [
        'Then recover it, when a key of that file signed it,',
        'Then recover it, when the stolen key signed it,',
      ],
      [", its first among them (that section's\n        step 5),", ','],
    ])
      refuses(theftList, swap(RUNBOOK, from, to), file);
    for (const [from, to] of [
      [', the first among them, goes into', ' goes into'],
      [
        cut(
          RUNBOOK,
          'each other key of the list whose private half',
          ', the first among them, goes',
        ),
        'each other key of the list that may have leaked',
      ],
    ])
      refuses(oldCopies, swap(RUNBOOK, from, to), first);
  });

  it('names disaster recovery’s night only by a ping from the old server’s own address inside its window, and checks the night a point-in-time recovery took before db starts, by the records the stolen-token step 2 reads (Stop C’s eighth re-review, finding T4, and the ninth’s V3)', () => {
    expect(theftRecords(RUNBOOK)).toEqual([]);
    const named =
      'disaster recovery’s step 2 names the night whose settings archive it unpacks from any ping';
    const started =
      'disaster recovery’s step 5 starts db on the night a point-in-time recovery took without checking it';
    const checked = 'disaster recovery’s step 5 reads the records as its own step 2 does';
    // As the seventh re-review's fixes left them: any ping of the monitor's log, and Telegram's
    // failure lines, named step 2's night, and step 5 said nothing of the night it took.
    const before = swap(
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          '(First install, step 3), and in it only',
          ' After a theft of the signing key, a night from before',
        ),
        "(First install, step 3), and Telegram's failure lines.",
      ),
      cut(RUNBOOK, ' Whichever night it took,', '\n\n     The volumes of a new server'),
      '',
    );
    refuses(theftRecords, before, named);
    refuses(theftRecords, before, started);
    // Each clause dropped or turned in turn.
    for (const [from, to, problem] of [
      [
        cut(RUNBOOK, ', and in it only a ping from the old', ', as A stolen or leaked'),
        ', and any ping',
        named,
      ],
      [
        cut(RUNBOOK, "inside its night's window (from its stamp to", ', as A stolen or leaked'),
        "inside its night's window",
        named,
      ],
      [
        cut(RUNBOOK, ': a ping from elsewhere, or two naming', " Telegram's failure lines,"),
        '.',
        named,
      ],
      [
        cut(RUNBOOK, ', or two naming different ids in one', ' but for a run by hand, is a sign'),
        ", or two in one night's window",
        named,
      ],
      [
        cut(
          RUNBOOK,
          " Telegram's failure lines, which",
          ' After a theft of the signing key, a night',
        ),
        '',
        named,
      ],
      [
        cut(RUNBOOK, ' Whichever night it took,', '\n\n     The volumes of a new server'),
        '',
        started,
      ],
      ['`db` stays stopped while that section is followed.', '`db` starts all the same.', started],
      // Step 5's records as the eighth re-review's fixes left them, as disaster recovery's step 2
      // reads them (the ninth re-review's V3), and the same-server records dropped.
      [
        cut(
          RUNBOOK,
          ', as A stolen or leaked bucket token (VPS), step 2, reads them (on',
          ', before step 6 starts',
        ),
        ', as step 2 reads them',
        checked,
      ],
      [cut(RUNBOOK, ' (on the same server the', ', before step 6 starts'), '', checked],
    ])
      refuses(theftRecords, swap(RUNBOOK, from, to), problem);
  });

  it('notes when a release went live as well as when its deploy began, each in its own bullet, and counts a new server’s releases by when they went live (Stop C’s eighth re-review, finding S1, deploy design notes)', () => {
    expect(releaseDeployed(RUNBOOK)).toEqual([]);
    const noted =
      'Production and Rolling back by hand never ask for the owner’s own note of the day';
    const began = 'Production and Rolling back by hand note only when a deploy began';
    const counted = 'step 7 counts a release of the owner’s notes live from when its deploy began';
    const ofTheDay = 'step 7 takes a new server’s releases from the owner’s note of the day alone';
    const production = cut(
      RUNBOOK,
      ' Then note,\n     off the server',
      '\n\n  3. From this machine',
    );
    // As the seventh re-review's fixes left them: the note held when the deploy began alone, and a
    // new server's step 7 went by the owner's note of the day.
    const before = swap(
      swap(
        swap(
          swap(
            swap(
              RUNBOOK,
              production,
              " Then note,\n     off the server, the time the deploy began (UTC), the release and whether it stayed live: that\n     is the owner's own note of the day, which a recovery on a new server goes by (Backups and\n     restore (VPS), Disaster recovery, steps 5 and 7).",
            ),
            cut(RUNBOOK, ' Note it off the\n  server too', ' Migrations are never'),
            ' Note it off the\n  server too, as for a release (Production, step 2): the time (UTC), the release brought back,\n  and that the one rolled back did not stay live.',
          ),
          "archive is only in the owner's own notes of each deploy since it.",
          "archive is only in the owner's own note of the day.",
        ),
        cut(RUNBOOK, ' On a new\n        server the owner', ' A\n        line with'),
        '',
      ),
      cut(
        RUNBOOK,
        "on a new server, the one the owner's own notes of each",
        ' never the **VPS release** runs alone',
      ),
      "on a new server, the owner's own note of the day,",
    );
    for (const problem of [began, counted, ofTheDay]) refuses(releaseDeployed, before, problem);
    // The notes the deploy design notes found unpinned: the rollback's details dropped or turned,
    // and Production's note moved to the Staging bullet.
    const staging = 'and any deploy with under 5 GiB of disk free.';
    for (const bad of [
      swap(
        RUNBOOK,
        cut(RUNBOOK, ': the times it began and went live (UTC), the', ' Migrations are never'),
        '.',
      ),
      swap(
        RUNBOOK,
        'and that the one rolled back did not stay live',
        'and that the one rolled back stayed live',
      ),
      swap(swap(RUNBOOK, production, ''), staging, `${staging}${production}`),
    ])
      refuses(releaseDeployed, bad, noted);
    // Each clause of this round dropped or turned in turn.
    for (const [from, to, problem] of [
      [cut(RUNBOOK, ' the time it went\n     live,', ' the\n     release and whether'), '', began],
      [cut(RUNBOOK, ' read from its `deploying` line', ' the time it went'), '', began],
      ['the times it began and went live (UTC)', 'the time (UTC)', began],
      [cut(RUNBOOK, ' On a new\n        server the owner', ' A\n        line with'), '', counted],
      [
        'or as gone live since it, by the\n        time it went live,',
        'or as gone live since it, by the\n        time its deploy began,',
        counted,
      ],
      [" step 7's own not counted,", '', ofTheDay],
      [
        "archive is only in the owner's own notes of each deploy since it.",
        "archive is only in the owner's own note of the day.",
        ofTheDay,
      ],
    ])
      refuses(releaseDeployed, swap(RUNBOOK, from, to), problem);
  });

  it('ties a rebuilt server’s night that sent no ping to its nightly, a run by hand’s ping not counted, and holds the journal’s lines as the records on the same server (Stop C’s ninth re-review, finding V1, theft design notes)', () => {
    expect(oldCopies(RUNBOOK)).toEqual([]);
    const slot =
      'the stolen-token steps take the key of a night that sent no ping for stolen after a rebuild once a run by hand pinged after it';
    const journal = 'the stolen-token steps leave the journal’s lines out of the records';
    // As the eighth re-review's fixes left it: after a rebuild, a night of the old server's on a day
    // the monitor got no ping from its address, which no day bounds.
    refuses(
      oldCopies,
      swap(
        RUNBOOK,
        cut(RUNBOOK, 'and not a night that sent no ping', '), that a'),
        ROUND_9_NO_PING,
      ),
      slot,
    );
    // Each clause dropped or turned in turn.
    for (const [from, to] of [
      [cut(RUNBOOK, " (a run by hand's ping names its own,", ', is judged by its seal alone'), ''],
      [
        cut(RUNBOOK, 'where no ping from its address names', " (a run by hand's ping"),
        'where no ping from its address names a night stamped 20:30 UTC',
      ],
      ["stamped from a nightly's 20:30 UTC to the next", 'on that day'],
      [' unless a run by hand pinged first', ''],
    ])
      refuses(oldCopies, swap(RUNBOOK, from, to), slot);
    refuses(
      oldCopies,
      swap(
        RUNBOOK,
        "those records are the journal's lines above",
        "those records are the monitor's pings above",
      ),
      journal,
    );
  });

  it('runs a ping’s window to a day after its stamp, so a run by hand begun just before a nightly keeps its own ping, in step 2, sub-step 4 and disaster recovery’s step 2 (Stop C’s ninth re-review, finding H1)', () => {
    expect(oldCopies(RUNBOOK)).toEqual([]);
    expect(theftRecords(RUNBOOK)).toEqual([]);
    const day = 'the stolen-token steps end a ping’s window at the next night’s stamp';
    const dayBefore =
      'the theft’s step 5 and disaster recovery’s step 2 end a ping’s window at the next night’s stamp';
    // As the eighth re-review's fixes left them: each window ran to the next night's.
    const step2 = `${cut(RUNBOOK, "the night's window (from its stamp to", 'late ping counts)')}late ping counts)`;
    const step2Before =
      "the night's window (from its stamp to the next night's, so a long base's late ping counts)";
    const subStep4 = `${cut(RUNBOOK, 'inside its night (from its stamp to', 'late ping counts)')}late ping counts)`;
    const subStep4Before = "inside its night (from its stamp to the next night's)";
    const recovery = cut(
      RUNBOOK,
      "inside its night's window (from its stamp to",
      ', as A stolen or leaked',
    );
    const recoveryBefore = "inside its night's window (from its stamp to the next night's)";
    const before = swap(
      swap(swap(RUNBOOK, step2, step2Before), subStep4, subStep4Before),
      recovery,
      recoveryBefore,
    );
    refuses(oldCopies, before, day);
    refuses(theftRecords, before, dayBefore);
    // Each place turned back alone.
    refuses(oldCopies, swap(RUNBOOK, step2, step2Before), day);
    refuses(theftRecords, swap(RUNBOOK, subStep4, subStep4Before), dayBefore);
    refuses(theftRecords, swap(RUNBOOK, recovery, recoveryBefore), dayBefore);
  });

  it('keeps Vercel’s records DNS only and written down, and runs the leak test through a temporary record before any app record moves (Stop D, VPS-113 and VPS-115)', () => {
    expect(zoneAndLeak(RUNBOOK)).toEqual([]);
    refuses(
      zoneAndLeak,
      swap(
        RUNBOOK,
        "Vercel's records stay **DNS only** (the grey cloud)",
        "Vercel's records go proxied",
      ),
      'the zone move doesn’t keep Vercel’s records DNS only',
    );
    refuses(
      zoneAndLeak,
      swap(RUNBOOK, cut(RUNBOOK, ' Write down each of\n', '\n   - GoDaddy'), ''),
      'the zone move doesn’t write down Vercel’s records for the way back',
    );
    refuses(
      zoneAndLeak,
      swap(
        RUNBOOK,
        "back to Vercel's written-down values, DNS only",
        "back to Vercel's values, proxied",
      ),
      'the way back doesn’t set Vercel’s written-down values again, DNS only',
    );
    // The leak test after the staging record, and the outline's leak test in its place.
    const leakTest = cut(RUNBOOK, '2. **The leak test**', '3. **The `staging` record**');
    const stagingRecord = cut(RUNBOOK, '3. **The `staging` record**', '4. **GitHub');
    const leakLast = `${stagingRecord.replace('3.', '2.')}${leakTest.replace('2.', '3.')}`;
    const problem =
      'the staging night moves the staging record before the leak test through leaktest.menumesh.in';
    refuses(zoneAndLeak, swap(RUNBOOK, `${leakTest}${stagingRecord}`, leakLast), problem);
    refuses(zoneAndLeak, swap(RUNBOOK, leakTest, `${OUTLINE_LEAK.replace('4.', '2.')}\n`), problem);
    refuses(
      zoneAndLeak,
      swap(
        RUNBOOK,
        'They need nothing from the server.',
        "`staging` goes to the server's IPv4 the same day.",
      ),
      'a record points at the server before the staging night',
    );
    refuses(
      zoneAndLeak,
      swap(
        RUNBOOK,
        cut(RUNBOOK, '22. At the staging night', '\n\n### Secrets (VPS)'),
        OLD_LAST_STEP,
      ),
      'First install, step 22, runs the leak test without its temporary record',
    );
  });

  it('turns VPS_IMAGES and VPS_DEPLOY_STAGING on and DEPLOY_STAGING off at the staging night (Stop D, VPS-116)', () => {
    expect(stagingSwitches(RUNBOOK)).toEqual([]);
    refuses(
      stagingSwitches,
      swap(
        RUNBOOK,
        '`DEPLOY_STAGING` `false`. From now on',
        '`DEPLOY_STAGING` `true`. From now on',
      ),
      'the staging night doesn’t set `DEPLOY_STAGING` `false`',
    );
    refuses(
      stagingSwitches,
      swap(
        RUNBOOK,
        '(it may be already), `VPS_DEPLOY_STAGING` `true` and',
        '(it may be already), `VPS_DEPLOY_STAGING` `false` and',
      ),
      'the staging night doesn’t set `VPS_DEPLOY_STAGING` `true`',
    );
    // The outline's last step: VPS_DEPLOY_STAGING on only after the move.
    refuses(
      stagingSwitches,
      swap(
        RUNBOOK,
        '- `CRON_SECRET` out of both Vercel projects.',
        '- `CRON_SECRET` out of both Vercel projects, and `VPS_DEPLOY_STAGING` on.',
      ),
      'VPS_DEPLOY_STAGING waits for the Vercel parts to retire',
    );
    refuses(
      stagingSwitches,
      swap(RUNBOOK, cut(RUNBOOK, ', from the staging\n', ' A merge that\n'), '.'),
      'Deploys on the VPS doesn’t say staging follows main on the server from the staging night',
    );
    // First install, step 17, turning VPS_DEPLOY_STAGING on with VPS_IMAGES, or not waiting (Stop D
    // review, T1 of the docs).
    refuses(
      stagingSwitches,
      swap(
        RUNBOOK,
        'the variables, `VPS_IMAGES` set to `true`, and the secrets;',
        'the variables, `VPS_IMAGES` and `VPS_DEPLOY_STAGING` set to `true`, and the secrets;',
      ),
      'First install turns VPS_DEPLOY_STAGING on before the staging night',
    );
    refuses(
      stagingSwitches,
      swap(
        RUNBOOK,
        '`VPS_DEPLOY_STAGING` waits for the staging night',
        '`VPS_DEPLOY_STAGING` goes on with it',
      ),
      'First install turns VPS_DEPLOY_STAGING on before the staging night',
    );
    // cd6a733's intro, which forbade the merge of its own step 6 (D2 of the docs).
    refuses(
      stagingSwitches,
      swap(RUNBOOK, " other than step 6's", ''),
      'the staging night forbids the merge its step 6 needs',
    );
  });

  it('keeps Vercel’s cron jobs, CRON_SECRET and the hosted project’s backup as the way back for its 14 days, until the first real write on the server (Stop D, VPS-117 to VPS-120)', () => {
    expect(windowKept(RUNBOOK)).toEqual([]);
    // The outline's step 5: CRON_SECRET out of Vercel at the move.
    const outlined = swap(
      RUNBOOK,
      "5. **Vercel's production project**: Schedules → Cron Jobs → **Disable Cron Jobs**.",
      "5. **Vercel's production project**: `CRON_SECRET` out of Vercel.",
    );
    refuses(
      windowKept,
      outlined,
      'the production night doesn’t disable Vercel’s cron jobs with CRON_SECRET kept',
    );
    refuses(windowKept, outlined, 'CRON_SECRET leaves Vercel before the 14 days end');
    refuses(
      windowKept,
      swap(RUNBOOK, ' `CRON_SECRET` stays (part 6 takes it out).', ''),
      'the staging night doesn’t disable Vercel’s cron jobs with CRON_SECRET kept',
    );
    refuses(
      windowKept,
      swap(RUNBOOK, 'Schedules → Cron Jobs → **Enable Cron Jobs**.', 'nothing.'),
      'the way back doesn’t enable Vercel’s cron jobs again',
    );
    refuses(
      windowKept,
      swap(RUNBOOK, cut(RUNBOOK, '8. **`BACKUP_PRODUCTION`**', '9. **That morning'), ''),
      'the production night doesn’t turn BACKUP_PRODUCTION off after pausing the hosted project',
    );
    refuses(
      windowKept,
      swap(RUNBOOK, '4. `BACKUP_PRODUCTION` `true`.\n', ''),
      'the way back doesn’t restore the hosted project and turn BACKUP_PRODUCTION on',
    );
    refuses(
      windowKept,
      swap(
        RUNBOOK,
        'For 14 days after the production night',
        'For 30 days after the production night',
      ),
      'the way back doesn’t last the 14 days',
    );
    const noReturn = /That\s+write is the point of no return\./.exec(RUNBOOK)?.[0] ?? '(missing)';
    refuses(
      windowKept,
      swap(RUNBOOK, noReturn, ''),
      'the way back doesn’t end at the first real write on the server, its point of no return',
    );
    // cd6a733's later night, which ran the tool and the settings again (Stop D review, D4 of the
    // cut-over sequence).
    const laterNight = cut(RUNBOOK, ", without the first admin's link and", 'It comes once');
    refuses(
      windowKept,
      swap(RUNBOOK, `${laterNight}It comes once`, ', once'),
      'a later production night doesn’t skip just the first admin’s link and step 3 while the server holds the first night’s admin',
    );
    // 67010b7's later night, which skipped step 4 too, losing what hosted's /super changed during
    // the way back (Stop D's re-review, R2-2).
    const skipped = swap(RUNBOOK, laterNight, OLD_LATER_NIGHT);
    refuses(
      windowKept,
      skipped,
      'a later production night doesn’t skip just the first admin’s link and step 3 while the server holds the first night’s admin',
    );
    refuses(
      windowKept,
      skipped,
      'a later production night doesn’t type again just what hosted’s /super changed during the way back',
    );
    // Without its step-4 clause the night types every setting again over the first night's.
    refuses(
      windowKept,
      swap(RUNBOOK, cut(RUNBOOK, 'Step 4 then types again', 'It comes once'), ''),
      'a later production night doesn’t type again just what hosted’s /super changed during the way back',
    );
    // cd6a733's After the move: the Vercel rules until Stop D rewrote them (D3 of the docs).
    refuses(
      windowKept,
      swap(
        RUNBOOK,
        cut(RUNBOOK, '- **After the move:** until', ' (Deploying, One-time setup'),
        '- **After the move:** until the cut-over (Stop D) rewrites them, the Vercel rules in this runbook\n  describe the live deploy path',
      ),
      'After the move ends the Vercel rules before the Vercel parts retire',
    );
  });

  it('proves authenticated origin pulls for every host the site file serves, right after it goes in (Stop D review, D1 of the cut-over sequence)', () => {
    expect(siteBlocks(SITE, 'tls_menumesh')).toEqual(
      ['menumesh.in', 'www.menumesh.in', 'api.menumesh.in', 'staging.menumesh.in'].map((host) => ({
        host,
        imports: true,
      })),
    );
    expect(originPulls(RUNBOOK, SITE)).toEqual([]);
    const pulls = (text: string) => originPulls(text, SITE);
    // cd6a733's step 1: the site file, and no origin test for its hosts after it.
    refuses(
      pulls,
      swap(RUNBOOK, cut(RUNBOOK, '1. **The site file', '2. **The leak test**'), OLD_SITE_STEP),
      'the staging night doesn’t run the origin test for MenuMesh’s hosts right after its site file',
    );
    // A host left out, and the server team's own host, whose snippet is not MenuMesh's.
    refuses(
      pulls,
      swap(RUNBOOK, ' api.menumesh.in; do curl', '; do curl'),
      'the origin test leaves out api.menumesh.in, which menumesh.caddy serves',
    );
    refuses(
      pulls,
      swap(RUNBOOK, 'for h in menumesh.in ', 'for h in jainavinfotech.in menumesh.in '),
      'the origin test names jainavinfotech.in, which menumesh.caddy doesn’t serve',
    );
    // A block of the site file that the test could not speak for.
    refuses(
      (site) => originPulls(RUNBOOK, site),
      swap(
        SITE,
        'https://api.menumesh.in {\n\timport site_common\n\timport tls_menumesh\n',
        'https://api.menumesh.in {\n\timport site_common\n',
      ),
      'menumesh.caddy’s api.menumesh.in block doesn’t import tls_menumesh',
    );
    refuses(
      pulls,
      swap(RUNBOOK, cut(RUNBOOK, 'An exit 0 means the server', ' The night goes no'), ''),
      'the origin test doesn’t stop the night on an exit 0',
    );
    // b2558c3's stop, which had the admin install the server team's file again unasked, and one
    // that sends the admin to turn origin pulls on as their edge.md §3 says.
    const unasked =
      'the origin test’s exit 0 doesn’t stop for the server team’s answer in their chat';
    refuses(
      pulls,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          "   the server team's of `66c8c61` or later: stop.",
          '\n\n2. **The leak test**',
        ),
        STAGING_STOP_B2558C3,
      ),
      unasked,
    );
    refuses(
      pulls,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          ' The admin makes the copy and runs the comparison',
          ' and every exit is not 0.',
        ),
        " The night goes no further until the admin has turned authenticated origin pulls on as `edge.md` §3 says (Cloudflare's zone-level pulls first, then `client_auth`)",
      ),
      unasked,
    );
    // ac976ce's stop, when an exit 0 meant MenuMesh's own snippet with client_auth commented out.
    const commentedOut = swap(
      RUNBOOK,
      cut(RUNBOOK, '   An exit 0 means', '\n\n2. **The leak test**'),
      OLD_STOP_ON_EXIT_0,
    );
    refuses(pulls, commentedOut, 'the origin test doesn’t stop the night on an exit 0');
    refuses(pulls, commentedOut, unasked);
    // cd6a733's step 11: its own test, which proves nothing before the site file, as the only one.
    refuses(
      pulls,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          ' For `menumesh.in` that test proves nothing yet',
          '\n\n    `edge.env` comes last',
        ),
        '',
      ),
      'First install, step 11, doesn’t say its origin test proves nothing for menumesh.in yet',
    );
  });

  it('starts scheduler-staging only on the staging night, once Vercel staging’s cron jobs are off and web-staging runs Vercel staging’s commit, and its way back stops it, every earlier command that would make it saying to leave it out (Stop D review, D2 and D7 of the cut-over sequence, and its re-review’s R2-1)', () => {
    expect(stagingScheduler(RUNBOOK)).toEqual([]);
    // cd6a733's step 20: both schedulers at the first install, called safe together.
    const both = swap(RUNBOOK, cut(RUNBOOK, '\n20. ', '\n21. ').slice(1), OLD_SCHEDULERS);
    refuses(
      stagingScheduler,
      both,
      'First install, step 20, starts scheduler-staging before the staging night',
    );
    refuses(
      stagingScheduler,
      both,
      'First install, step 20, calls Vercel staging’s cron jobs and scheduler-staging safe together',
    );
    // cd6a733's part 2: the staging scheduler's first day checked in the rehearsal.
    refuses(
      stagingScheduler,
      swap(
        RUNBOOK,
        " (staging's come\n     on the staging night, part 3, step 9):",
        " (and\n     `scheduler-staging`'s the same):",
      ),
      'the server rehearsal checks scheduler-staging before the staging night',
    );
    // No deploy by hand before the record moves: testers would get First install's image.
    refuses(
      stagingScheduler,
      swap(RUNBOOK, cut(RUNBOOK, '- **The same day**', '\nThen, in order:'), ''),
      'the staging night doesn’t deploy web-staging by hand on the commit Vercel staging serves before its record moves',
    );
    // cd6a733's step 5: Vercel's crons off, with nothing started or stopped after them.
    const step5 = cut(RUNBOOK, "5. **Vercel's staging project**", '\n6. **The first deploy**');
    const oldStep5 = swap(RUNBOOK, step5, OLD_STAGING_CRONS);
    refuses(
      stagingScheduler,
      oldStep5,
      'the staging night doesn’t start scheduler-staging once, after Vercel staging’s cron jobs are disabled',
    );
    refuses(
      stagingScheduler,
      oldStep5,
      'step 5’s way back doesn’t stop scheduler-staging before Vercel staging’s cron jobs go on',
    );
    // Started before Vercel's crons are off too.
    refuses(
      stagingScheduler,
      swap(
        RUNBOOK,
        '- **The same day**',
        '- `sudo app-compose menumesh up -d scheduler-staging` the day before.\n- **The same day**',
      ),
      'the staging night doesn’t start scheduler-staging once, after Vercel staging’s cron jobs are disabled',
    );
    // cd6a733's way back for the whole night, which left it running.
    refuses(
      stagingScheduler,
      swap(
        RUNBOOK,
        cut(RUNBOOK, 'Way back, for the whole night: ', "; the `staging` record to Vercel's value"),
        'Way back, for the whole night: nothing on the server',
      ),
      'the staging night’s way back doesn’t stop scheduler-staging',
    );
    // 67010b7's commands outside First install, each without the limit (Stop D's re-review, R2-1):
    // Rotation's cron secrets and its heartbeats, After a change's STAGING_* values, and disaster
    // recovery's step 7.
    refuses(
      stagingScheduler,
      swap(
        RUNBOOK,
        cut(RUNBOOK, '`web-staging scheduler-staging`, or', '); the minute'),
        '`web-staging scheduler-staging`',
      ),
      'Secrets (VPS), Rotation, starts scheduler-staging before the staging night: `web-staging scheduler-staging`',
    );
    refuses(
      stagingScheduler,
      swap(RUNBOOK, cut(RUNBOOK, ' (`scheduler` alone until the staging night', '. A bucket'), ''),
      'Secrets (VPS), Rotation, starts scheduler-staging before the staging night: `scheduler scheduler-staging`',
    );
    refuses(
      stagingScheduler,
      swap(
        RUNBOOK,
        cut(RUNBOOK, "ones once the staging night's step 5", ', each with its web container'),
        'ones',
      ),
      'The scheduler (VPS), After a change, starts scheduler-staging before the staging night: `scheduler-staging`',
    );
    const stepSeven = cut(RUNBOOK, ' (`scheduler` alone before the', 'First install, step 20)');
    refuses(
      stagingScheduler,
      swap(RUNBOOK, `${stepSeven}First install, step 20)`, ''),
      'Backups and restore (VPS), Disaster recovery, starts scheduler-staging before the staging night: `sudo app-compose menumesh up -d scheduler scheduler-staging`',
    );
  });

  it('counts the app’s tables and the logins in one statement, the logins a named row (Stop D review, D3 of the cut-over sequence)', () => {
    expect(oneCount(RUNBOOK)).toEqual([]);
    // cd6a733's count: two statements, of which the SQL editor shows the logins alone.
    const two = swap(
      RUNBOOK,
      "   union all\n   select 'auth', 'users', (select count(*) from auth.users)\n   order by rows desc, 1, 2;\n",
      '   order by rows desc, 1, 2;\n   select count(*) from auth.users;\n',
    );
    refuses(
      oneCount,
      two,
      'part 1’s count runs 2 statements, and the SQL editor shows only the last one’s result',
    );
    refuses(
      oneCount,
      two,
      'part 1’s count doesn’t give the logins as a named row of its one result',
    );
    refuses(
      oneCount,
      swap(RUNBOOK, 'The logins are the `auth` `users` row; ', ''),
      'part 1’s count doesn’t give the logins as a named row of its one result',
    );
  });

  it('serves the leak test’s host with MenuMesh’s own pieces, and puts its one site file back (Stop D review, D1 of the docs; the server team’s merged edge.md, VPS-143)', () => {
    expect(leakPieces(RUNBOOK)).toEqual([]);
    const leakTest = cut(RUNBOOK, '2. **The leak test**', '3. **The `staging` record**');
    const backOrder =
      'the leak test’s step 5 doesn’t put menumesh.caddy back, never removing it, then stop the container, then take its UPSTREAMS entry out';
    // cd6a733's leak test: the server team's steps, with nothing to serve leaktest.menumesh.in,
    // and their step 5 readable as removing menumesh.caddy.
    const old = swap(RUNBOOK, leakTest, OLD_LEAK_TEST);
    for (const piece of LEAK_PIECES) {
      refuses(leakPieces, old, `the leak test’s setup lacks MenuMesh’s ${piece}`);
    }
    refuses(leakPieces, old, backOrder);
    // ac976ce's: `<port>`, a copy of the repository's menumesh.caddy, and that file back, never
    // the copy of what was installed; nothing took the copies or the image away.
    const ac976ce = swap(RUNBOOK, leakTest, LEAK_TEST_AC976CE);
    for (const problem of [
      `the leak test’s setup lacks MenuMesh’s ${LEAK_PIECES[1]}`,
      `the leak test’s setup lacks MenuMesh’s ${LEAK_PIECES[2]}`,
      'the leak test’s site copy isn’t made from the installed menumesh.caddy',
      backOrder,
      'the leak test’s step 5 leaves its copies or its image on the server',
    ]) {
      refuses(leakPieces, ac976ce, problem);
    }
    // Their step 5 out of order: the entry out before the site file that needs it is back, and
    // the container stopped first.
    const back = `   ${SITE_BACK}\n   ${LEAK_STOP}\n   ${CONF_EDIT}     # menumesh-leaktest:80 out of UPSTREAMS\n`;
    refuses(
      leakPieces,
      swap(
        RUNBOOK,
        back,
        `   ${CONF_EDIT}     # menumesh-leaktest:80 out of UPSTREAMS\n   ${SITE_BACK}\n   ${LEAK_STOP}\n`,
      ),
      backOrder,
    );
    refuses(
      leakPieces,
      swap(
        RUNBOOK,
        back,
        `   ${LEAK_STOP}\n   ${SITE_BACK}\n   ${CONF_EDIT}     # menumesh-leaktest:80 out of UPSTREAMS\n`,
      ),
      backOrder,
    );
    // The copy made from the repository's file, as before, and the copies left behind.
    refuses(
      leakPieces,
      swap(
        RUNBOOK,
        `   ${LIVE_COPY}\n`,
        '   cp ~/incoming/menumesh.caddy ~/incoming/menumesh-live.caddy\n',
      ),
      'the leak test’s site copy isn’t made from the installed menumesh.caddy',
    );
    refuses(
      leakPieces,
      swap(RUNBOOK, `   ${COPIES_GONE}\n`, ''),
      'the leak test’s step 5 leaves its copies or its image on the server',
    );
  });

  it('recreates Caddy only between 01:00 and 07:00 IST (Stop D review, D5 of the cut-over sequence)', () => {
    expect(edgeWindow(RUNBOOK)).toEqual([]);
    // cd6a733's step 11 and staging's password rotation, each with no window.
    refuses(
      edgeWindow,
      swap(
        RUNBOOK,
        'sudo app-compose edge up -d     # between 01:00 and 07:00 IST, on the night the owner picks\n',
        'sudo app-compose edge up -d\n',
      ),
      'sudo app-compose edge up -d without the 01:00 to 07:00 IST window',
    );
    refuses(
      edgeWindow,
      swap(
        RUNBOOK,
        'then recreate Caddy between 01:00 and 07:00 IST, as it drops every connection on the shared\n  edge, and check',
        'then recreate Caddy, and check',
      ),
      'recreate Caddy without the 01:00 to 07:00 IST window',
    );
    // The recreate of step 11's way back without it.
    refuses(
      edgeWindow,
      swap(
        RUNBOOK,
        `    ${RECREATE}     # between 01:00 and 07:00 IST, the same night\n`,
        `    ${RECREATE}\n`,
      ),
      'sudo app-compose edge up -d without the 01:00 to 07:00 IST window',
    );
  });

  it('installs the redaction file right after the conf, and never on the staging night (the server team’s review, VPS-135)', () => {
    expect(redactEarly(RUNBOOK)).toEqual([]);
    // 21a13bf's step 9: the conf alone.
    refuses(
      redactEarly,
      swap(
        RUNBOOK,
        cut(RUNBOOK, '9. `/etc/apps/menumesh.conf`', '\n10. The deploy user'),
        OLD_CONF_STEP,
      ),
      'First install, step 9, doesn’t install the redaction file right after the conf',
    );
    // The redaction file on the staging night, as 935373d's step 22 and cd6a733's step 1 had it.
    refuses(
      redactEarly,
      swap(
        RUNBOOK,
        cut(RUNBOOK, '22. At the staging night', '\n\n### Secrets (VPS)'),
        OLD_LAST_STEP,
      ),
      'First install, step 22, installs the redaction file',
    );
    refuses(
      redactEarly,
      swap(RUNBOOK, cut(RUNBOOK, '1. **The site file', '2. **The leak test**'), OLD_SITE_STEP),
      'the staging night’s step 1 installs the redaction file',
    );
    // 21a13bf's disaster recovery: the redaction file with the site file, last.
    refuses(
      redactEarly,
      swap(
        RUNBOOK,
        cut(RUNBOOK, '  8. The edge', '\n  9. The key off the ramfs'),
        OLD_RECOVERY_EDGE,
      ),
      'disaster recovery’s edge doesn’t install the redaction file right after its conf',
    );
  });

  it('puts the edge in in its order, edge.env merged and Caddy recreated once, and checks the recreate before the staging night (the server team’s review, VPS-136)', () => {
    expect(edgeNight(RUNBOOK)).toEqual([]);
    // 21a13bf's step 11: the certificate without aop-ca.pem, and edge.env as MenuMesh's two lines.
    const old = swap(
      RUNBOOK,
      cut(RUNBOOK, '11. The edge:', '\n\n    ```sh\n    docker run --rm -it'),
      OLD_EDGE_STEP,
    );
    for (const words of [CERT_INSTALL, AOP_CLIENT, EDGE_COPY, EDGE_ENV]) {
      refuses(edgeNight, old, `First install, step 11, lacks ${words}`);
    }
    // ac976ce's block, kept to 0a35068: the CSR's key shredded on a line of its own, whatever the
    // install did.
    const unchained = swap(
      RUNBOOK,
      `    ${CERT_INSTALL}\n    ${AOP_CLIENT}\n`,
      `    ${EDGE_CERT}\n    ${AOP_CLIENT}\n    ${KEY_SHRED} && rm -r ~/csr\n`,
    );
    refuses(edgeNight, unchained, `First install, step 11, lacks ${CERT_INSTALL}`);
    refuses(edgeNight, unchained, 'shreds the CSR’s key whether or not its certificate went in');
    // 0a35068's step 11: the digest pin named, none of its steps, so `edge compose` was refused;
    // its `edge compose` after edge.env; and a CADDY_IMAGE that is not the kit's CADDY.
    const unpinned = 'recreates Caddy without the server team’s digest pin';
    refuses(
      edgeNight,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          "    Then the server team's digest pin of Caddy",
          '    `edge.env` comes last.',
        ),
        '',
      ),
      unpinned,
    );
    refuses(
      edgeNight,
      swap(
        swap(RUNBOOK, `    ${PIN_COMPOSE}\n`, ''),
        `    ${EDGE_ENV}\n`,
        `    ${EDGE_ENV}\n    ${PIN_COMPOSE}\n`,
      ),
      unpinned,
    );
    refuses(
      edgeNight,
      swap(RUNBOOK, `\`CADDY_IMAGE=${CADDY}\``, '`CADDY_IMAGE=caddy:2.11.9-alpine`'),
      unpinned,
    );
    for (const problem of [
      'doesn’t put the certificate and the snippet before edge.env',
      'leaves a copy of edge.env behind when the admin stops',
      'recreates Caddy without the server team’s digest pin',
    ]) {
      refuses(edgeNight, old, problem);
    }
    // The recreate before edge.env, a copy kept when the admin stops, and the staging night
    // without its check.
    const recreate = `    ${RECREATE}     # between 01:00 and 07:00 IST, on the night the owner picks\n`;
    refuses(
      edgeNight,
      swap(swap(RUNBOOK, recreate, ''), `    ${EDGE_ENV}\n`, `${recreate}    ${EDGE_ENV}\n`),
      'doesn’t put the certificate and the snippet before edge.env, and the recreate right after it',
    );
    refuses(
      edgeNight,
      swap(RUNBOOK, cut(RUNBOOK, ' When the admin stops,', ' values too.'), ''),
      'leaves a copy of edge.env behind when the admin stops',
    );
    refuses(
      edgeNight,
      swap(RUNBOOK, RECREATED, 'sudo docker ps'),
      'the staging night doesn’t check that Caddy was recreated with MenuMesh’s two lines',
    );
  });

  it('keeps the server team’s snippets.caddy, whose tls_menumesh has client_auth on, between the certificate and edge.env, its copy sent and, on their word alone, installed there, and adds no snippet of MenuMesh’s own (VPS-142, VPS-147)', () => {
    expect(serverSnippet(RUNBOOK)).toEqual([]);
    // ac976ce's step 11: deploy/vps/edge/tls_menumesh.caddy added to the server's file.
    const own = swap(
      RUNBOOK,
      cut(RUNBOOK, '11. The edge:', '    For `menumesh.in` that test proves nothing yet'),
      OLD_EDGE_OPENING,
    );
    for (const words of [SNIPPET_COPY, SNIPPET]) {
      refuses(serverSnippet, own, `First install, step 11, lacks ${words}`);
    }
    for (const problem of [
      'doesn’t keep the server team’s snippets.caddy between the certificate and edge.env',
      'doesn’t say the server team’s snippets.caddy holds tls_menumesh with client_auth on',
      'adds a snippet of MenuMesh’s own to the server’s snippets.caddy',
    ]) {
      refuses(serverSnippet, own, problem);
    }
    // Their file installed only after edge.env, when app-apply refuses it until the recreate.
    refuses(
      serverSnippet,
      swap(
        swap(
          RUNBOOK,
          `only then does the admin run \`${SNIPPET}\``,
          'only then does the admin run it',
        ),
        `    ${EDGE_ENV}\n`,
        `    ${EDGE_ENV}\n    ${SNIPPET}\n`,
      ),
      'doesn’t keep the server team’s snippets.caddy between the certificate and edge.env',
    );
    // A snippet of MenuMesh's own named again.
    refuses(
      serverSnippet,
      swap(
        RUNBOOK,
        "MenuMesh's kit never adds a snippet to the server's file:",
        "MenuMesh's `deploy/vps/edge/tls_menumesh.caddy` goes into the server's file too:",
      ),
      'adds a snippet of MenuMesh’s own to the server’s snippets.caddy',
    );
  });

  it('shreds the copies of the install’s secrets in ~/incoming once they are installed (VPS-140)', () => {
    expect(copiesGone(RUNBOOK)).toEqual([]);
    // 21a13bf's step 14 and Rotation's env files: the copies left where scp put them.
    refuses(
      copiesGone,
      swap(RUNBOOK, cut(RUNBOOK, '\n\n    Then the three copies `scp` left', '\n\n15. '), ''),
      'First install, step 14, leaves the env files’ copies in ~/incoming',
    );
    refuses(
      copiesGone,
      swap(RUNBOOK, ' and its copy in `~/incoming` shredded (First install, step 14)', ''),
      'Rotation leaves the copy of an env file installed again in ~/incoming',
    );
  });

  it('starts no container before the server team says origin pulls are on for every zone (VPS-135)', () => {
    expect(originGate(RUNBOOK)).toEqual([]);
    // 21a13bf's step 16, and its rehearsal's first step.
    refuses(
      originGate,
      swap(RUNBOOK, cut(RUNBOOK, '16. Not before', 'Then the database, then the Supabase'), '16. '),
      'First install, step 16, starts db without waiting for the server team’s origin pulls',
    );
    refuses(
      originGate,
      swap(
        RUNBOOK,
        cut(RUNBOOK, " Step 16 waits for the server team's", " Production's first deploy"),
        '',
      ),
      'the server rehearsal doesn’t say step 16 waits for the server team’s origin pulls',
    );
    // ac976ce's step 16: the word in the chat alone, no proof on the server (VPS-143); a host of
    // Jainav's left out; and the loop with no stop on an exit 0.
    const unproved =
      'First install, step 16, starts db without proving that Jainav’s hosts refuse a client without a certificate';
    refuses(
      originGate,
      swap(
        RUNBOOK,
        cut(RUNBOOK, ' Then, on the server and before `db`', ' Then the database,'),
        '',
      ),
      unproved,
    );
    refuses(originGate, swap(RUNBOOK, ' analytics.jainavinfotech.in; do', '; do'), unproved);
    refuses(
      originGate,
      swap(RUNBOOK, cut(RUNBOOK, '    If one ends in 0, stop:', ' Then the database,'), '   '),
      unproved,
    );
  });

  it('keeps the drills to the second weekend, or the third, outside the backups (the server team’s review, VPS-138)', () => {
    expect(drillDays(RUNBOOK)).toEqual([]);
    // 21a13bf's timing: the third week, and the drill right after the restore test.
    const restore = cut(RUNBOOK, '- **The monthly restore test**', ' First the month');
    const third = swap(RUNBOOK, restore, OLD_RESTORE_TIME);
    refuses(drillDays, third, 'the restore test doesn’t keep to the second weekend, or the third');
    refuses(drillDays, third, 'the restore test still says the third week');
    refuses(
      drillDays,
      swap(RUNBOOK, ', or on the third if the second is missed', ''),
      'the restore test doesn’t keep to the second weekend, or the third',
    );
    refuses(
      drillDays,
      swap(
        RUNBOOK,
        cut(
          RUNBOOK,
          '- **The monthly point-in-time drill**',
          '\n\n  ```sh\n  sudo app-compose menumesh --profile pitr-test',
        ),
        OLD_DRILL_TIME,
      ),
      'the drill doesn’t wait in the same terminal for the restore test to end',
    );
  });

  it('makes the origin pulls’ CA and client certificate the owner’s, uploaded at the zone level, and gives the server only the two certificates (the server team’s review, VPS-136)', () => {
    expect(ownCA(RUNBOOK)).toEqual([]);
    // 21a13bf's step 8: pulls "ready for the admin's certificate", and nothing made.
    const old = swap(
      RUNBOOK,
      cut(RUNBOOK, '8. **The zone:**', "\n\n**The server's admin**"),
      OLD_ZONE_STEP,
    );
    for (const words of ['extendedKeyUsage=clientAuth', '-days 3650', '-days 825', AOP_VERIFY]) {
      refuses(ownCA, old, `makes the origin pulls’ certificates without ${words}`);
    }
    refuses(ownCA, old, 'doesn’t keep to zone-level pulls with MenuMesh’s certificate');
    refuses(ownCA, old, 'gives the server more than the two certificates');
    // A -subj left to Git Bash, a server certificate in place of a client one, and 21a13bf's part
    // 1 and disaster recovery.
    refuses(
      ownCA,
      swap(
        RUNBOOK,
        "MSYS_NO_PATHCONV=1 openssl req -new -newkey rsa:2048 -nodes -subj '/CN=menumesh.in",
        "openssl req -new -newkey rsa:2048 -nodes -subj '/CN=menumesh.in",
      ),
      'a -subj that Git Bash turns into a path',
    );
    refuses(
      ownCA,
      swap(RUNBOOK, 'extendedKeyUsage=clientAuth', 'extendedKeyUsage=serverAuth'),
      'makes the origin pulls’ certificates without extendedKeyUsage=clientAuth',
    );
    refuses(
      ownCA,
      swap(
        RUNBOOK,
        cut(RUNBOOK, '   - Authenticated origin pulls come', '\n\n   Way back: each setting'),
        OLD_PULLS_LINE,
      ),
      'part 1 doesn’t say the owner makes and uploads the origin pulls’ client certificate',
    );
    refuses(
      ownCA,
      swap(
        RUNBOOK,
        cut(RUNBOOK, '  8. The edge', '\n  9. The key off the ramfs'),
        OLD_RECOVERY_EDGE,
      ),
      'disaster recovery’s edge doesn’t take both certificates from the password manager',
    );
  });

  it('runs the leak test’s container from traefik/whoami by digest, pulled first, after its UPSTREAMS entry, with hostwatch’s alias and limits and no privilege (the server team’s review, VPS-137)', () => {
    expect(leakContainer(RUNBOOK)).toEqual([]);
    // 21a13bf's leak test: MenuMesh's pieces, and no image or command for the container.
    const old = swap(
      RUNBOOK,
      cut(RUNBOOK, '2. **The leak test**', '3. **The `staging` record**'),
      LEAK_TEST_21A13BF,
    );
    for (const problem of [
      'the leak test starts 0 containers with docker run, not 1',
      'the leak test doesn’t pull its image by its digest before the container starts',
      'the leak test doesn’t tell the server team’s chat before the container starts',
      'the leak test doesn’t say hostwatch’s wrong-project alert comes while it runs',
      'the leak test doesn’t say the image listens on port 80',
    ]) {
      refuses(leakContainer, old, problem);
    }
    // The image without its digest, in the run and in the pull.
    refuses(
      leakContainer,
      swap(RUNBOOK, `--read-only ${LEAK_IMAGE}`, '--read-only traefik/whoami:v1.12.0'),
      `the leak test’s container is not ${LEAK_IMAGE}: traefik/whoami:v1.12.0`,
    );
    refuses(
      leakContainer,
      swap(RUNBOOK, `sudo docker pull ${LEAK_IMAGE}`, 'sudo docker pull traefik/whoami:v1.12.0'),
      'the leak test doesn’t pull its image by its digest before the container starts',
    );
    // A flag left out, and the kit.throwaway label.
    refuses(
      leakContainer,
      swap(RUNBOOK, ' -d --rm --name ', ' -d --name '),
      'the leak test’s container starts without --rm',
    );
    for (const flag of [
      '--network-alias menumesh-leaktest',
      '--memory 64m',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--read-only',
    ]) {
      refuses(
        leakContainer,
        swap(RUNBOOK, ` ${flag} `, ' '),
        `the leak test’s container starts without ${flag}`,
      );
    }
    refuses(
      leakContainer,
      swap(RUNBOOK, ' --rm --name', ' --rm --label kit.throwaway=1 --name'),
      'carries the kit.throwaway label',
    );
    // The container started before its UPSTREAMS entry goes in.
    const entry = cut(RUNBOOK, '`menumesh-leaktest:80` goes into `UPSTREAMS` in', 'port 80); ');
    refuses(
      leakContainer,
      swap(
        swap(RUNBOOK, `${entry}port 80); `, ''),
        '\n\n   then a copy',
        `\n\n   then ${entry}port 80), and a copy`,
      ),
      'the leak test doesn’t put its UPSTREAMS entry in before the container starts',
    );
    // ac976ce's alert: `networks: …` every 5 minutes, without hostwatch's whole line, every run,
    // and Telegram's once and every 6 hours (VPS-143).
    refuses(
      leakContainer,
      swap(
        RUNBOOK,
        cut(RUNBOOK, '2. **The leak test**', '3. **The `staging` record**'),
        LEAK_TEST_AC976CE,
      ),
      'the leak test doesn’t say hostwatch’s wrong-project alert comes while it runs',
    );
    refuses(
      leakContainer,
      swap(RUNBOOK, ': Telegram gets it once, then again\n   every 6 hours while it lasts.', '.'),
      'the leak test doesn’t say hostwatch’s wrong-project alert comes while it runs',
    );
  });

  it('merges edge.env as the server team’s edge.md §5, step 6, does, its names and lengths checked before the install, in step 11, Rotation, disaster recovery and the example (VPS-143)', () => {
    expect(mergedCopy(RUNBOOK, EXAMPLE)).toEqual([]);
    // ac976ce's step 11: `(echo; cat)`, which left a blank line after a copy that ended in its line
    // end, and no check before the install.
    const ac976ce = swap(
      RUNBOOK,
      cut(RUNBOOK, '    `edge.env` comes last.', '    - (a) the server team'),
      EDGE_ENV_AC976CE,
    );
    for (const words of [NEWLINE_GUARD, APPEND, NAMES_CHECK]) {
      refuses(
        (text) => mergedCopy(text, EXAMPLE),
        ac976ce,
        `First install, step 11, lacks ${words}`,
      );
    }
    for (const problem of [
      'doesn’t merge edge.env in the server team’s order',
      'the RUNBOOK still appends to edge.env with (echo; cat)',
      'doesn’t say what the check of names and lengths must show',
      'keeps MenuMesh’s edge.env lines on the server alone',
    ]) {
      refuses((text) => mergedCopy(text, EXAMPLE), ac976ce, problem);
    }
    // The check after the install, when it can no longer stop it, and a check that prints values.
    refuses(
      (text) => mergedCopy(text, EXAMPLE),
      swap(
        swap(RUNBOOK, `    ${NAMES_CHECK}\n`, ''),
        `    ${EDGE_ENV}\n`,
        `    ${EDGE_ENV}\n    ${NAMES_CHECK}\n`,
      ),
      'doesn’t merge edge.env in the server team’s order',
    );
    refuses(
      (text) => mergedCopy(text, EXAMPLE),
      swap(RUNBOOK, 'printf "%s(%d) ", k, length($0) - i}', 'print}'),
      `First install, step 11, lacks ${NAMES_CHECK}`,
    );
    // ac976ce's Rotation, its line edited in place, and disaster recovery's lines never merged.
    refuses(
      (text) => mergedCopy(text, EXAMPLE),
      swap(
        RUNBOOK,
        cut(RUNBOOK, "- Staging's password:", '- The deploy key or the Access token'),
        ROTATION_AC976CE,
      ),
      'Rotation doesn’t put staging’s new hash in through step 11’s merged copy',
    );
    refuses(
      (text) => mergedCopy(text, EXAMPLE),
      swap(
        RUNBOOK,
        cut(RUNBOOK, '  8. The edge, by the admin:', '\n  9. The key off the ramfs'),
        RECOVERY_EDGE_AC976CE,
      ),
      'disaster recovery’s edge doesn’t merge MenuMesh’s lines',
    );
    // ac976ce's example header: the copy and the install, but no newline guard, no check and no
    // pointer to step 11.
    const oldExample = swap(
      EXAMPLE,
      cut(EXAMPLE, '# of the live one.', "\n\n# Staging's basic auth"),
      EXAMPLE_HEADER_AC976CE,
    );
    refuses(
      (example) => mergedCopy(RUNBOOK, example),
      oldExample,
      `edge.env.example’s header lacks ${NEWLINE_GUARD}`,
    );
    refuses(
      (example) => mergedCopy(RUNBOOK, example),
      oldExample,
      'edge.env.example’s header doesn’t point at First install, step 11',
    );
    // The placeholder the kit's bites need stays as it was.
    expect(EXAMPLE).toContain("\nMENUMESH_STAGING_AUTH_HASH='$2a$14$replace-me'\n");
  });

  it('checks Caddy and the live tree after the recreate, with a way back from the edge.env app-apply keeps (VPS-143)', () => {
    expect(recreateChecked(RUNBOOK, APP_APPLY)).toEqual([]);
    // ac976ce's step 11: the recreate, and nothing after it.
    const ac976ce = swap(
      RUNBOOK,
      cut(RUNBOOK, '    `edge.env` comes last.', '    - (a) the server team'),
      EDGE_ENV_AC976CE,
    );
    for (const problem of [
      'doesn’t check Caddy and the live tree after the recreate',
      'doesn’t say what the recreate’s checks show',
      'doesn’t say where app-apply keeps the edge.env it replaced',
    ]) {
      refuses((text) => recreateChecked(text, APP_APPLY), ac976ce, problem);
    }
    // The validate left out, and the way back before the checks.
    refuses(
      (text) => recreateChecked(text, APP_APPLY),
      swap(RUNBOOK, `    ${EDGE_VALIDATE}\n`, ''),
      'doesn’t check Caddy and the live tree after the recreate',
    );
    // An app-apply that kept three copies, or under another folder, would make the step wrong.
    refuses(
      (appApply) => recreateChecked(RUNBOOK, appApply),
      swap(APP_APPLY, 'if [ "${#copies[@]}" -gt 5 ]', 'if [ "${#copies[@]}" -gt 3 ]'),
      'the vendored app-apply has no if [ "${#copies[@]}" -gt 5 ]',
    );
    refuses(
      (appApply) => recreateChecked(RUNBOOK, appApply),
      swap(APP_APPLY, 'KEEP_DIR=/var/lib/app-apply', 'KEEP_DIR=/var/backups/app-apply'),
      'the vendored app-apply has no KEEP_DIR=/var/lib/app-apply',
    );
    refuses(
      (appApply) => recreateChecked(RUNBOOK, appApply),
      swap(APP_APPLY, 'say "the live edge tree is valid"', 'say "the edge is valid"'),
      'the vendored app-apply has no say "the live edge tree is valid"',
    );
  });

  it('checks that the edge networks are internal, with Caddy on each, where step 15 says they exist (VPS-143)', () => {
    expect(networksChecked(RUNBOOK)).toEqual([]);
    // ac976ce's step 15: the networks said to exist, and nothing to show it.
    refuses(
      networksChecked,
      swap(RUNBOOK, cut(RUNBOOK, " Before it, the server team's check", '\n16. '), '\n'),
      'First install, step 15, doesn’t check that both edge networks are internal',
    );
    refuses(
      networksChecked,
      swap(RUNBOOK, ' edge-menumesh edge-menumesh-staging\n', ' edge-menumesh\n'),
      'First install, step 15, doesn’t check that both edge networks are internal',
    );
  });

  it('passes the leak test’s headers on what the server team’s upstream snippet sets and removes, and runs the origin check again with a temporary accept rule (VPS-143)', () => {
    expect(leakChecks(RUNBOOK, SNIPPETS, SITE)).toEqual([]);
    // ac976ce's checks: "forged headers replaced" and "a temporary hPanel accept rule" alone.
    const ac976ce = swap(
      RUNBOOK,
      cut(RUNBOOK, '2. **The leak test**', '3. **The `staging` record**'),
      LEAK_TEST_AC976CE,
    );
    for (const problem of [
      'doesn’t say whoami prints header names as Go writes them',
      'doesn’t pass on the headers the upstream snippet sets and removes',
      'doesn’t run again with a temporary hPanel accept rule',
    ]) {
      refuses((text) => leakChecks(text, SNIPPETS, SITE), ac976ce, problem);
    }
    // A snippet that no longer removes Forwarded, or sets X-Real-IP from elsewhere: the step's
    // pass would then say what the upstreams don't get.
    refuses(
      (snippets) => leakChecks(RUNBOOK, snippets, SITE),
      swap(SNIPPETS, '\theader_up -Forwarded\n', ''),
      'the server team’s upstream snippet doesn’t remove Forwarded',
    );
    refuses(
      (snippets) => leakChecks(RUNBOOK, snippets, SITE),
      swap(
        SNIPPETS,
        '\theader_up X-Real-IP {client_ip}\n',
        '\theader_up X-Real-IP {remote_host}\n',
      ),
      'the server team’s upstream snippet doesn’t set X-Real-IP to the client’s address',
    );
    // A header of menumesh.caddy's own, which the echo server would not show for the app's hosts.
    refuses(
      (site) => leakChecks(RUNBOOK, SNIPPETS, site),
      swap(
        SITE,
        '\treverse_proxy menumesh-web:3000 {\n\t\timport upstream\n',
        '\treverse_proxy menumesh-web:3000 {\n\t\timport upstream\n\t\theader_up X-Menumesh 1\n',
      ),
      'menumesh.caddy sets a header of its own: header_up X-Menumesh 1',
    );
  });

  it('recreates Caddy only once the server team says their kit on the server holds their fix of hostwatch’s alerts, which may be that night’s first step, before its edge.env lines (VPS-146)', () => {
    expect(alertsFixed(RUNBOOK)).toEqual([]);
    // 4fb9e7b's (a): their kit refreshed on the server, and no word of the fix.
    const old = swap(
      RUNBOOK,
      cut(RUNBOOK, "    - (a) the server team's", '\n    - (b) '),
      NIGHT_WAIT_4FB9E7B,
    );
    const unfixed =
      'recreates Caddy before the server team’s kit on the server holds their fix of hostwatch’s alerts';
    const unsaid = 'doesn’t wait for the server team’s word in their chat';
    refuses(alertsFixed, old, unfixed);
    refuses(alertsFixed, old, unsaid);
    // The fix named at 66c8c61, which lacks it, and no word of theirs in the chat.
    refuses(alertsFixed, swap(RUNBOOK, 'merged as `ccb9388`', 'merged as `66c8c61`'), unfixed);
    refuses(
      alertsFixed,
      swap(RUNBOOK, ', which the server team confirms in their chat', ''),
      unsaid,
    );
    // 776eb08's (a): the fix and their word, with no time of their own, so that night waited for
    // the refresh even as its first step.
    const untimed = swap(
      RUNBOOK,
      cut(RUNBOOK, "    - (a) the server team's", '\n    - (b) '),
      NIGHT_WAIT_776EB08,
    );
    const late =
      'doesn’t put the server team’s refresh and their word before the recreate night’s edge.env lines';
    const heldBack = 'holds the recreate night back for the server team’s refresh';
    refuses(alertsFixed, untimed, late);
    refuses(alertsFixed, untimed, heldBack);
    // The refresh after the edge.env lines, where app-apply refuses the edge's commands until the
    // recreate, and on an earlier night only.
    refuses(
      alertsFixed,
      swap(
        RUNBOOK,
        "come before that night's `edge.env` lines",
        "come after that night's `edge.env` lines",
      ),
      late,
    );
    refuses(alertsFixed, swap(RUNBOOK, ", or as that night's first step", ''), heldBack);
  });

  it('compares the server’s snippets.caddy with a Git Bash copy of the commit the server team names, its sum checked before the scp, before any edge config and edge.env, and stops on DIFFERENT for their answer, given the live file’s sum, the copy’s and its commit (VPS-147)', () => {
    expect(snippetGuard(RUNBOOK)).toEqual([]);
    // b2558c3's block: a working tree's file, at whatever commit it had, sent unchecked and
    // installed whole.
    const old = swap(
      RUNBOOK,
      cut(RUNBOOK, '    Then the snippet', '    For `menumesh.in` that test proves nothing yet'),
      SNIPPET_B2558C3,
    );
    for (const problem of [
      'the RUNBOOK sends snippets.caddy from a working tree',
      'the RUNBOOK takes snippets.caddy at that commit or a later one',
      'doesn’t make its copy of snippets.caddy with git show in Git Bash',
      'sends its copy of snippets.caddy before sha256sum shows the sum',
      'doesn’t compare the server’s snippets.caddy with the copy',
      'doesn’t say that SAME installs nothing',
      'doesn’t stop on DIFFERENT and ask the server team in their chat',
      'doesn’t give the server team the live file’s sum',
      'runs edge config without the server team’s word in their chat',
      'doesn’t say the server’s snippets.caddy is always the server team’s file',
    ]) {
      refuses(snippetGuard, old, problem);
    }
    // The comparison after edge config, and after edge.env.
    refuses(
      snippetGuard,
      swap(RUNBOOK, `    ${LIVE_SUM}\n`, `    ${SNIPPET}\n    ${LIVE_SUM}\n`),
      'runs edge config before it compares the server’s snippets.caddy with the copy',
    );
    const compare = `    ${LIVE_SUM}\n    ${COPY_SUM}\n    ${SNIPPET_CMP}\n`;
    refuses(
      snippetGuard,
      swap(swap(RUNBOOK, compare, ''), `    ${EDGE_ENV}\n`, `    ${EDGE_ENV}\n${compare}`),
      'reaches edge.env before it compares the server’s snippets.caddy with the copy',
    );
    // The stop clause dropped: DIFFERENT asks, but neither stops nor holds the lines below.
    const unstopped = swap(
      swap(RUNBOOK, DIFFERENT_STOP, "`DIFFERENT`: ask in the server team's chat"),
      " Run\n      none of this step's lines below until they answer, `edge.env`'s above all.",
      '',
    );
    refuses(snippetGuard, unstopped, 'doesn’t stop on DIFFERENT and ask the server team');
    refuses(snippetGuard, unstopped, 'doesn’t hold its lines below, edge.env above all');
    // The comparison's SAME dropped after either answer: their own install, and the copy's.
    const unchecked = 'goes on after DIFFERENT without the comparison printing SAME again';
    refuses(
      snippetGuard,
      swap(
        RUNBOOK,
        ', with the copy made again if their answer\n      names another commit, must print `SAME`;',
        ' need not run again;',
      ),
      unchecked,
    );
    refuses(
      snippetGuard,
      swap(RUNBOOK, ', and the three lines must print `SAME`.', '.'),
      unchecked,
    );
    // The admin-side check dropped, and the copy made in PowerShell, whose `>` writes UTF-16.
    refuses(
      snippetGuard,
      swap(
        RUNBOOK,
        `    ${SNIPPET_SUM}     # the snippets.caddy sum of their latest confirmation, or stop\n`,
        '',
      ),
      'sends its copy of snippets.caddy before sha256sum shows the sum of the server team’s confirmation',
    );
    refuses(
      snippetGuard,
      swap(RUNBOOK, 'in Git Bash, not PowerShell (', 'in PowerShell or Git Bash ('),
      'doesn’t make its copy of snippets.caddy with git show in Git Bash',
    );
    // The three things the server team reads the server's file by, dropped from step 11's message,
    // from the staging night's and from disaster recovery's.
    const unnamed =
      'doesn’t give the server team the live file’s sum, the copy’s sum and the commit the copy came from';
    refuses(
      snippetGuard,
      swap(RUNBOOK, cut(RUNBOOK, ", giving the live file's sum, the copy's", ' Run\n'), '.'),
      `First install, step 11’s DIFFERENT ${unnamed}`,
    );
    refuses(
      snippetGuard,
      swap(
        RUNBOOK,
        ", giving\n   the live file's sum, the copy's sum and the commit the copy came from.",
        '.',
      ),
      `the staging night’s exit 0 ${unnamed}`,
    );
    refuses(
      snippetGuard,
      swap(
        RUNBOOK,
        ", giving the live file's\n     sum, the copy's sum and the commit the copy came from.",
        '.',
      ),
      'disaster recovery’s edge doesn’t compare the snippet as First install, step 11, does',
    );
    // Disaster recovery's comparison after its edge.env lines, when app-apply refuses edge config
    // until the recreate.
    refuses(
      snippetGuard,
      swap(RUNBOOK, 'Before the `edge.env` lines', 'After the `edge.env` lines'),
      'disaster recovery’s edge doesn’t compare the snippet as First install, step 11, does',
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
    expect(zoneAndLeak(rewrapped)).toEqual([]);
    expect(stagingSwitches(rewrapped)).toEqual([]);
    expect(windowKept(rewrapped)).toEqual([]);
    expect(originPulls(rewrapped, SITE)).toEqual([]);
    expect(stagingScheduler(rewrapped)).toEqual([]);
    expect(oneCount(rewrapped)).toEqual([]);
    expect(leakPieces(rewrapped)).toEqual([]);
    expect(edgeWindow(rewrapped)).toEqual([]);
    expect(redactEarly(rewrapped)).toEqual([]);
    expect(edgeNight(rewrapped)).toEqual([]);
    expect(serverSnippet(rewrapped)).toEqual([]);
    expect(copiesGone(rewrapped)).toEqual([]);
    expect(originGate(rewrapped)).toEqual([]);
    expect(drillDays(rewrapped)).toEqual([]);
    expect(ownCA(rewrapped)).toEqual([]);
    expect(leakContainer(rewrapped)).toEqual([]);
    expect(mergedCopy(rewrapped, EXAMPLE)).toEqual([]);
    expect(recreateChecked(rewrapped, APP_APPLY)).toEqual([]);
    expect(networksChecked(rewrapped)).toEqual([]);
    expect(leakChecks(rewrapped, SNIPPETS, SITE)).toEqual([]);
    expect(alertsFixed(rewrapped)).toEqual([]);
    expect(snippetGuard(rewrapped)).toEqual([]);
  });
});
