import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { posthogHosts } from '@/lib/posthog-hosts';

import {
  accessLines,
  caddyRunArgs,
  compareDumps,
  composeServices as services,
  cronCallJobs,
  dumpObjects,
  envoyBootstrap,
  envoyKeyNames,
  labelRefusal,
  lintCrontab,
  memAvailableMib,
  REHEARSAL_IMAGES,
  rehearsalImagesEnv,
  renderListeners,
  restoreDifferences,
  seedFiles,
  serviceKey as key,
  serviceMounts,
  SIGNING_PAIR_CHECK,
  statsMib,
  WAL_FILE,
  walMessage,
  walObject,
  webContext,
} from '../../scripts/vps-kit.mts';
import {
  RECORD_MAX,
  recordMessage,
  recordOf,
  recordText,
  recordVerdict,
  SEAL_MAX,
  sealOf,
  type SealPart,
  sealPartName,
  sealText,
  sealVerdict,
  signedBy,
  signedWith,
} from '../../scripts/vps-seal.mts';

/**
 * The shared server kit (deploy/vps; docs/DECISIONS.md VPS-31 to VPS-121) is checked by the
 * server's own code only when the owner installs it, and some of it only when it first runs there.
 * These text rules pin what each file must keep, so a change that would break the contract, leak a
 * secret or undo a decision fails in CI first. Every rule is also run on a copy with one mistake
 * and must refuse it, as docker-image.test.ts does, so a rule that stopped matching can't pass
 * everything quietly.
 */

const KIT = 'deploy/vps';
const VENDOR = join(KIT, 'test', 'vendor', 'jainav-infotech');
const kit = (path: string) => readFileSync(join(KIT, path), 'utf8');
const workflow = (name: string) => readFileSync(join('.github', 'workflows', name), 'utf8');

/** The lines that are not blank or a comment. */
const code = (text: string) =>
  text.split('\n').filter((line) => line.trim() && !line.trimStart().startsWith('#'));

/** `text` with `from` replaced by `to`; `from` must occur exactly once, so the bad copy applies. */
function swap(text: string, from: string, to: string): string {
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`${JSON.stringify(from)} occurs ${count} times`);
  return text.replace(from, () => to);
}

/** A rule's problems on a bad copy, which must hold `problem`. */
function refuses(rule: (text: string) => string[], bad: string, problem: string | RegExp) {
  const found = rule(bad).join('\n');
  if (typeof problem === 'string') expect(found).toContain(problem);
  else expect(found).toMatch(problem);
}

// --- compose.yml ---

// The services as written (each name with its lines, comments left out) and one key of a
// service: vps-kit.mts reads compose.yml with the same helpers.
const compose = kit('compose.yml');

/** A key's value on its own line, e.g. mem_limit's. */
const value = (service: readonly string[], name: string) =>
  key(service, name)?.[0].slice(`    ${name}:`.length).trim();
/** compose's sizes in MiB: 1536m, 1g. */
const mib = (size = '') => {
  const match = /^(\d+)([mg])$/.exec(size);
  return match ? Number(match[1]) * (match[2] === 'g' ? 1024 : 1) : NaN;
};

/** The same swap, inside one service, where the same line can stand in several. */
function swapIn(text: string, service: string, from: string, to: string): string {
  const start = text.indexOf(`\n  ${service}:\n`);
  if (start < 0) throw new Error(`no service ${service}`);
  const rest = text.slice(start + 1).search(/\n {2}[a-z0-9][a-z0-9-]*:\n|\n\S/);
  const end = rest < 0 ? text.length : start + 1 + rest;
  return text.slice(0, start) + swap(text.slice(start, end), from, to) + text.slice(end);
}

/** The keys app-apply lets a service set (check_service_keys' allow-list), read from its code. */
const ALLOWED_KEYS = [
  ...(
    /def allowed: ([\s\S]*?);\n/.exec(readFileSync(join(VENDOR, 'app-apply'), 'utf8'))?.[1] ?? ''
  ).matchAll(/"([a-z_]+)"/g),
].map((match) => match[1]);

const topLevel = (text: string) => [
  ...code(text)
    .filter((line) => /^\S/.test(line))
    .map((line) => /^([^:\s]+)/.exec(line)?.[1] ?? line)
    .filter((name) => !/^(name|services|networks|volumes|x-[A-Za-z0-9_.-]+)$/.test(name))
    .map((name) => `top-level key ${name}`),
  ...(/^name: menumesh$/m.test(text) ? [] : ['the project is not named menumesh']),
];

/** Nothing the server refuses: keys off app-apply's list, logging, the Docker socket, ports. */
const refusedKeys = (text: string) => [
  ...[...services(text)].flatMap(([name, service]) =>
    service
      .map((line) => /^ {4}([^\s:]+):/.exec(line)?.[1])
      .filter((found): found is string => found !== undefined && found !== '<<')
      .filter((found) => !ALLOWED_KEYS.includes(found) || found === 'logging')
      .map((found) => `service ${name}: ${found}`),
  ),
  ...(text.includes('docker.sock') ? ['the Docker socket'] : []),
  ...(/^ {4}external: true$/m.test(text.slice(text.indexOf('\nvolumes:')))
    ? ['an external volume']
    : []),
];

/** ${...} only where an env file may change a value: image, environment, healthcheck. */
function interpolation(text: string): string[] {
  const problems: string[] = [];
  let section = '';
  let current = '';
  for (const line of code(text)) {
    if (/^\S/.test(line)) [section, current] = [line.split(':')[0], ''];
    else if (/^ {2}\S/.test(line)) current = '';
    else if (/^ {4}\S/.test(line)) current = line.trim().split(':')[0];
    if (!line.includes('${')) continue;
    if (section !== 'services' || !['image', 'environment', 'healthcheck'].includes(current)) {
      problems.push(`${section}${current ? ` ${current}` : ''}: ${line.trim()}`);
    }
  }
  return problems;
}

const LIMITS = ['mem_limit', 'memswap_limit', 'cpus', 'cpu_shares', 'pids_limit', 'oom_score_adj'];
/** The six limits on every service, one-offs too, in app-apply's ranges; oom_score_adj not 0. */
const limits = (text: string) =>
  [...services(text)].flatMap(([name, service]) => {
    const missing = LIMITS.filter((limit) => !value(service, limit));
    if (missing.length) return [`service ${name} has no ${missing.join(', ')}`];
    const [mem, swapLimit] = [
      mib(value(service, 'mem_limit')),
      mib(value(service, 'memswap_limit')),
    ];
    const number = (limit: string) => Number(value(service, limit));
    return [
      ...(number('cpus') > 1.5 ? [`service ${name}: cpus over 1.5`] : []),
      ...(number('cpu_shares') > 1024 ? [`service ${name}: cpu_shares over 1024`] : []),
      ...(number('pids_limit') > 2048 ? [`service ${name}: pids_limit over 2048`] : []),
      ...(number('oom_score_adj') === 0 ||
      number('oom_score_adj') < -900 ||
      number('oom_score_adj') > 1000
        ? [`service ${name}: oom_score_adj must be set, -900 to 1000`]
        : []),
      ...(!(swapLimit >= mem && swapLimit <= mem + 256)
        ? [`service ${name}: memswap_limit not from mem_limit to mem_limit + 256m`]
        : []),
    ];
  });

/** The webs: the image's own command, 25 s to drain, the heap of VPS-6, only app-deploy's images. */
const webs = (text: string) =>
  (
    [
      ['web', '1000'],
      ['web-staging', '500'],
    ] as const
  ).flatMap(([name, heap]) => {
    const service = services(text).get(name);
    if (!service) return [`no service ${name}`];
    return [
      ...['command', 'entrypoint']
        .filter((found) => key(service, found))
        .map((found) => `${name} sets ${found}`),
      ...(value(service, 'stop_grace_period') === '25s' ? [] : [`${name}: stop_grace_period`]),
      ...(service.includes(`      NODE_OPTIONS: --max-old-space-size=${heap}`)
        ? []
        : [`${name}: NODE_OPTIONS is not --max-old-space-size=${heap}`]),
      ...(value(service, 'pull_policy') === 'never' ? [] : [`${name}: pull_policy`]),
    ];
  });

/** The settings the app reads: the keys of its two schemas (src/lib/env.server.ts, env.ts). */
const READ_BY_APP = new Set(
  ['src/lib/env.server.ts', 'src/lib/env.ts'].flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]),
  ),
);
/** Read by Node itself: the image's CMD leaves the heap size to the deploy (Dockerfile, VPS-6). */
const NODE_OWN = ['NODE_OPTIONS'];
/** An env template's names. */
const templateNames = (text: string) =>
  [...text.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]);

/**
 * What web and web-staging are given is a setting the app (or Node) reads, and no name is in both
 * a service's environment and its env file, where the environment would win without a word.
 */
const webSettings = (text: string, templates: { web: string; 'web-staging': string }) =>
  (['web', 'web-staging'] as const).flatMap((name) => {
    const given = (key(services(text).get(name) ?? [], 'environment') ?? [])
      .map((line) => /^ {6}([A-Za-z_][A-Za-z0-9_]*):/.exec(line)?.[1])
      .filter((found) => found !== undefined);
    const filed = templateNames(templates[name]);
    return [
      ...[...given, ...filed]
        .filter((found) => !READ_BY_APP.has(found) && !NODE_OWN.includes(found))
        .map((found) => `${name}: ${found} is read by neither the app nor Node`),
      ...given
        .filter((found) => filed.includes(found))
        .map((found) => `${name}: ${found} is in both its environment and its env file`),
    ];
  });

/** Every service merges the hardened anchor: steady ones restart, profiled ones don't. */
const hardening = (text: string) => [
  ...(text.includes(
    "x-hardened: &hardened\n  cap_drop: [ALL]\n  security_opt: ['no-new-privileges:true']\n",
  )
    ? []
    : ['x-hardened lost cap_drop ALL or no-new-privileges']),
  ...(text.includes('x-steady: &steady\n  <<: *hardened\n  restart: unless-stopped\n')
    ? []
    : ['x-steady lost its restart']),
  ...(text.includes("x-oneoff: &oneoff\n  <<: *hardened\n  restart: 'no'\n")
    ? []
    : ['x-oneoff lost its restart']),
  ...[...services(text)]
    .filter(
      ([, service]) => service[0] !== `    <<: *${key(service, 'profiles') ? 'oneoff' : 'steady'}`,
    )
    .map(([name]) => `service ${name} does not start with its anchor`),
];

/**
 * BusyBox crond ignores SIGTERM and SIGINT as process 1, so a stop of a cron container waited out
 * its 10 s and killed it (exit 137). Docker's init runs crond as its child and passes the signal
 * on, and the stop takes under a second. The webs keep node as process 1, which drains (VPS-16).
 */
const CRON_SERVICES = ['scheduler', 'scheduler-staging', 'backup'];
const crondInit = (text: string) =>
  [...services(text)].flatMap(([name, service]) => {
    const init = value(service, 'init');
    if (CRON_SERVICES.includes(name)) {
      return init === 'true' ? [] : [`${name} runs crond as process 1`];
    }
    return name.startsWith('web') && init !== undefined ? [`${name} sets init`] : [];
  });

/** Third-party images by tag and digest; this repository's from images.env, pulled by app-deploy only. */
const images = (text: string) =>
  [...services(text)].flatMap(([name, service]) => {
    const image = value(service, 'image') ?? '';
    const own = /^\$\{([A-Z_]+_IMAGE):\?set \1 in images\.env\}$/.test(image);
    if (own) return value(service, 'pull_policy') === 'never' ? [] : [`${name}: pull_policy`];
    return /^[a-z0-9./-]+:(?!latest@)[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/.test(image)
      ? []
      : [`${name}: ${image} is not pinned by tag and digest`];
  });

/** The steady limits add up to the contract's 6,560 MiB (VPS-33). */
const steadyTotal = (text: string) => {
  const total = [...services(text).values()]
    .filter((service) => !key(service, 'profiles'))
    .reduce((sum, service) => sum + mib(value(service, 'mem_limit')), 0);
  return total === 6560 ? [] : [`the steady limits add up to ${total} MiB, not 6,560`];
};

/** Every ${NAME} the file uses has its line in a template, and every template line is used. */
const envNames = (text: string) => {
  const used = new Set(
    [
      ...code(text)
        .join('\n')
        .matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g),
    ].map((m) => m[1]),
  );
  const listed = new Set(
    templateNames(`${kit('env/project.env.example')}\n${kit('env/images.env.example')}`),
  );
  return [
    ...[...used].filter((name) => !listed.has(name)).map((name) => `${name} is in no template`),
    ...[...listed].filter((name) => !used.has(name)).map((name) => `${name} is not used`),
  ];
};

/**
 * What db's log may hold (VPS-34): errors only, each on one line, and no statement text. The
 * image's settings file logs every DDL statement (log_statement = 'ddl'), and auto_explain logs
 * any statement over 10 s with its values, so the command says otherwise.
 */
const DB_LOG_FLAGS = [
  'log_min_messages=error',
  'log_min_error_statement=panic',
  'log_error_verbosity=terse',
  'log_statement=none',
  'auto_explain.log_min_duration=-1',
];
const quietDatabase = (text: string) => {
  const command = (key(services(text).get('db') ?? [], 'command') ?? []).map((line) => line.trim());
  return DB_LOG_FLAGS.filter((flag) => !command.includes(`- ${flag}`)).map(
    (flag) => `db does not run with ${flag}`,
  );
};

/**
 * db archives every WAL file it finishes into /wal-spool (VPS-43): basic_archive, at least once a
 * minute while anything is written (the owner's RPO), through host rules of its own, the image's
 * file with the backup's replication line. wal-spool.sh, its entrypoint, makes the spool
 * postgres's, then runs the image's entrypoint with db's command, which still starts with postgres.
 */
const ARCHIVE_FLAGS = [
  'hba_file=/etc/postgresql-menumesh/pg_hba.conf',
  'archive_mode=on',
  'archive_library=basic_archive',
  'basic_archive.archive_directory=/wal-spool',
  'archive_timeout=60',
];
const walArchive = (text: string) => {
  const db = services(text).get('db') ?? [];
  const command = (key(db, 'command') ?? []).slice(1).map((line) => line.trim());
  const volumes = (key(db, 'volumes') ?? []).map((line) => line.trim());
  return [
    ...ARCHIVE_FLAGS.filter((flag) => !command.includes(`- ${flag}`)).map(
      (flag) => `db does not run with ${flag}`,
    ),
    ...(command[0] === '- postgres' ? [] : ['db’s command does not start with postgres']),
    ...(value(db, 'entrypoint') === "['/bin/sh', '/opt/menumesh/wal-spool.sh']"
      ? []
      : ['db does not start through wal-spool.sh']),
    ...[
      '- ./config/db/wal-spool.sh:/opt/menumesh/wal-spool.sh:ro',
      '- ./config/db/pg_hba.conf:/etc/postgresql-menumesh/pg_hba.conf:ro',
    ]
      .filter((mount) => !volumes.includes(mount))
      .map((mount) => `db lacks the mount ${mount.slice(2)}`),
  ];
};

/**
 * The WAL spool is db's and the backup's alone, writable in both: db's archiver fills it and the
 * shipper removes what it sent. No other service mounts it.
 */
const walSpoolMounts = (text: string) => {
  const mounts = [...services(text)].flatMap(([name, service]) =>
    (key(service, 'volumes') ?? [])
      .map((line) => /^\s+- wal-spool:(\S+)$/.exec(line)?.[1])
      .filter((target) => target !== undefined)
      .map((target) => `${name} ${target}`),
  );
  return [
    ...(mounts.join(', ') === 'db /wal-spool, backup /wal-spool'
      ? []
      : [
          `wal-spool is mounted as ${mounts.join(', ') || 'nowhere'}: db and backup alone, at /wal-spool, writable`,
        ]),
    ...(text.slice(text.indexOf('\nvolumes:\n')).includes('\n  wal-spool: {}\n')
      ? []
      : ['no wal-spool volume']),
  ];
};

/**
 * The backup image is built on Postgres's, which declares a volume for its data folder: the
 * long-running backup service mounts a small tmpfs there, so Docker makes no anonymous volume for
 * it that would outlive the container (the one-offs' go with their `run --rm`).
 */
const backupDataFolder = (text: string, dockerfile: string) =>
  !/^FROM postgres:/m.test(dockerfile) ||
  listOf(services(text).get('backup') ?? [], 'tmpfs').includes(
    '/var/lib/postgresql/data:size=1m,mode=0700',
  )
    ? []
    : ['the backup service leaves its image’s /var/lib/postgresql/data to an anonymous volume'];

/**
 * The backup service's /tmp is a small tmpfs, counted in its mem_limit, open to root's backup.sh
 * and the shipper's uid 100 alike (1777): their work folders, the signing helpers' files and the
 * shipper's record while the spool can't keep it never need the server's disk, so a full disk
 * stops neither script before its alert (Stop C's review, finding C3). vps:backup-test measures a
 * night in the service with the shipper at once against its size.
 */
const backupTmp = (text: string) => {
  const tmp = listOf(services(text).get('backup') ?? [], 'tmpfs').find((entry) =>
    entry.startsWith('/tmp:'),
  );
  const size = Number(/^\/tmp:size=(\d+)m,mode=1777$/.exec(tmp ?? '')?.[1]);
  return size >= 1 && size <= 64
    ? []
    : [
        `the backup service’s /tmp is ${tmp ?? 'on the server’s disk'}, not a tmpfs of at most 64m, mode 1777`,
      ];
};

/**
 * The backup's signing key goes to the backup service alone; the restores get its public key,
 * which they check every night and WAL file against, and the shipper its heartbeat (VPS-43).
 */
const signingEnv = (text: string) => {
  const holds = (name: string, line: string) =>
    (key(services(text).get(name) ?? [], 'environment') ?? []).some(
      (found) => found.trim() === line,
    );
  const given = [...services(text)]
    .filter(([, service]) => service.some((line) => line.includes('BACKUP_SIGNING_KEY')))
    .map(([name]) => name);
  return [
    ...(given.join() === 'backup' && holds('backup', 'BACKUP_SIGNING_KEY: ${BACKUP_SIGNING_KEY:?}')
      ? []
      : [`BACKUP_SIGNING_KEY goes to ${given.join(', ') || 'no service'}, not to backup alone`]),
    ...['backup', 'restore-test', 'recover', 'pitr-test', 'recover-pitr']
      .filter((name) => !holds(name, 'BACKUP_SIGNING_PUBLIC_KEY: ${BACKUP_SIGNING_PUBLIC_KEY:?}'))
      .map((name) => `${name} does not require BACKUP_SIGNING_PUBLIC_KEY`),
    ...(holds('backup', 'HEARTBEAT_WAL_URL: ${HEARTBEAT_WAL_URL:-}')
      ? []
      : ['backup has no HEARTBEAT_WAL_URL']),
  ];
};

/** A key's list as a service writes it, inline (`[a, 'b']`) or one `- ` line an item: its items. */
const listOf = (service: readonly string[], name: string): string[] => {
  const lines = key(service, name) ?? [];
  const inline = lines[0]?.slice(`    ${name}:`.length).trim() ?? '';
  if (inline) return [...inline.matchAll(/'([^']*)'|([^\s,'[\]]+)/g)].map((m) => m[1] ?? m[2]);
  return lines.slice(1).map((line) =>
    line
      .trim()
      .replace(/^- /, '')
      .replace(/^'(.*)'$/, '$1'),
  );
};

/** What the point-in-time recovery's one-offs are given: the bucket, the key's path, the point. */
const PITR_ENV = [
  'BACKUP_BUCKET: ${BACKUP_BUCKET:?}',
  'RCLONE_CONFIG_BACKUPS_TYPE: s3',
  'RCLONE_CONFIG_BACKUPS_PROVIDER: ${BACKUP_S3_PROVIDER:?}',
  'RCLONE_CONFIG_BACKUPS_ENDPOINT: ${BACKUP_S3_ENDPOINT:?}',
  'RCLONE_CONFIG_BACKUPS_REGION: ${BACKUP_S3_REGION:-}',
  'RCLONE_CONFIG_BACKUPS_ACCESS_KEY_ID: ${BACKUP_S3_ACCESS_KEY_ID:?}',
  'RCLONE_CONFIG_BACKUPS_SECRET_ACCESS_KEY: ${BACKUP_S3_SECRET_ACCESS_KEY:?}',
  "RCLONE_CONFIG_BACKUPS_NO_CHECK_BUCKET: 'true'",
  'AGE_IDENTITY_FILE: /run/age/identity.txt',
  'BACKUP_SIGNING_PUBLIC_KEY: ${BACKUP_SIGNING_PUBLIC_KEY:?}',
  'PITR_TARGET: ${PITR_TARGET:-}',
];
const PITR_ONEOFFS = {
  'pitr-test': {
    profiles: '[pitr-test]',
    entrypoint: "['/usr/local/bin/pitr.sh', '--test']",
    cap: '[CHOWN, SETUID, SETGID]',
    tmpfs: ['/var/lib/postgresql/data:size=1g,mode=0700', '/run/pitr:size=1m,mode=0700'],
    volumes: [] as string[],
    env: [] as string[],
  },
  'recover-pitr': {
    profiles: '[recover]',
    entrypoint: "['/usr/local/bin/pitr.sh', '--into']",
    cap: '[CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID]',
    tmpfs: ['/run/pitr:size=1m,mode=0700'],
    volumes: ['db-data:/var/lib/postgresql/data'],
    env: ['PITR_ACCEPT_CUT: ${PITR_ACCEPT_CUT:-}'],
  },
};
/**
 * The point-in-time recovery's one-offs (VPS-43), each the backup image's pitr.sh: pitr-test, the
 * monthly drill, behind a profile of its own, replays into a tmpfs of 1g and keeps nothing;
 * recover-pitr, behind recover's, replays into the real db-data volume, its one mount. Both reach
 * the bucket alone (the default network: no database, no restore network), wait for nothing (db
 * must not run while recover-pitr fills db-data), keep the copy of the age key on a tmpfs of their
 * own, and get the bucket's settings, the key's path, the public signing key and PITR_TARGET, and
 * nothing else but recover-pitr's PITR_ACCEPT_CUT: the drill fails on any cut chain of WAL files
 * (review finding D6). Root hands the data folder to the image's postgres (CHOWN, then SETUID and
 * SETGID for gosu); recover-pitr also reads and changes a volume it doesn't own, as recover-db does.
 */
const pitrOneoffs = (text: string) =>
  Object.entries(PITR_ONEOFFS).flatMap(([name, want]) => {
    const service = services(text).get(name);
    if (!service) return [`no service ${name}`];
    const env = (key(service, 'environment') ?? []).slice(1).map((line) => line.trim());
    const given = [...PITR_ENV, ...want.env];
    const tmpfs = listOf(service, 'tmpfs');
    const volumes = listOf(service, 'volumes');
    return [
      ...(value(service, 'image') === '${BACKUP_IMAGE:?set BACKUP_IMAGE in images.env}'
        ? []
        : [`${name} does not run the backup image`]),
      ...(value(service, 'profiles') === want.profiles
        ? []
        : [`${name} is not behind the profile ${want.profiles}`]),
      ...(value(service, 'entrypoint') === want.entrypoint
        ? []
        : [`${name} does not run ${want.entrypoint}`]),
      ...(value(service, 'cap_add') === want.cap
        ? []
        : [`${name} adds ${value(service, 'cap_add') ?? 'no capability'}, not ${want.cap}`]),
      ...(tmpfs.join(' ') === want.tmpfs.join(' ')
        ? []
        : [`${name}’s tmpfs is ${tmpfs.join(', ') || 'none'}, not ${want.tmpfs.join(', ')}`]),
      ...(volumes.join(' ') === want.volumes.join(' ')
        ? []
        : [
            `${name} mounts ${volumes.join(', ') || 'nothing'}, not ${want.volumes.join(', ') || 'nothing'}`,
          ]),
      ...(value(service, 'networks') === '[default]'
        ? []
        : [`${name} is not on the default network alone`]),
      ...(key(service, 'depends_on') ? [`${name} waits for another service`] : []),
      ...(JSON.stringify([...env].sort()) === JSON.stringify([...given].sort())
        ? []
        : [
            `${name}’s environment is not the bucket’s, the key’s and the point alone: ${[
              ...env.filter((line) => !given.includes(line)),
              ...given.filter((line) => !env.includes(line)).map((line) => `no ${line}`),
            ].join(', ')}`,
          ]),
    ];
  });

/**
 * The one-offs run one at a time, each with the one-offs it waits for: the most they hold at once
 * is the recovery's pair, recover-db and recover, 2,304 MiB beside the steady 6,560 (VPS-33).
 * pitr-test and recover-pitr run alone, and no one-off or pair may hold more (VPS-43).
 */
const oneoffMemory = (text: string) => {
  const all = services(text);
  const oneoff = (name: string) => Boolean(key(all.get(name) ?? [], 'profiles'));
  return [...all]
    .filter(([name]) => oneoff(name))
    .flatMap(([name, service]) => {
      const waits = (key(service, 'depends_on') ?? [])
        .slice(1)
        .map((line) => /^ {6}([a-z0-9-]+):/.exec(line)?.[1])
        .filter((found): found is string => found !== undefined && oneoff(found));
      const total = [name, ...waits].reduce(
        (sum, found) => sum + mib(value(all.get(found) ?? [], 'mem_limit')),
        0,
      );
      return total <= 2304
        ? []
        : [
            `${[name, ...waits].join(' and ')} ${waits.length ? 'hold' : 'holds'} ${total} MiB at once, over recover’s 2,304`,
          ];
    });
};

describe('deploy/vps/compose.yml', () => {
  it('is project menumesh, with only the top-level keys app-apply allows', () => {
    expect(topLevel(compose)).toEqual([]);
    refuses(topLevel, swap(compose, 'name: menumesh', 'name: jainav'), 'not named menumesh');
    refuses(
      topLevel,
      swap(compose, '\nservices:\n', '\nconfigs: {}\nservices:\n'),
      'top-level key configs',
    );
  });

  it('sets nothing the server refuses: no ports, build, container_name, logging or socket', () => {
    expect(ALLOWED_KEYS).toContain('mem_limit');
    expect(refusedKeys(compose)).toEqual([]);
    for (const [line, problem] of [
      ["    ports: ['127.0.0.1:3000:3000']", 'service web: ports'],
      ['    build: .', 'service web: build'],
      ['    container_name: web', 'service web: container_name'],
      ['    privileged: true', 'service web: privileged'],
      ['    logging: { driver: journald }', 'service web: logging'],
      ['    volumes_from: [db]', 'service web: volumes_from'],
    ]) {
      refuses(
        refusedKeys,
        swapIn(compose, 'web', '    <<: *steady\n', `    <<: *steady\n${line}\n`),
        problem,
      );
    }
    refuses(
      refusedKeys,
      swapIn(
        compose,
        'backup',
        '      - storage-data:/storage:ro\n',
        '      - /var/run/docker.sock:/var/run/docker.sock:ro\n',
      ),
      'the Docker socket',
    );
    refuses(
      refusedKeys,
      swap(compose, '  db-data: {}', '  db-data:\n    external: true'),
      'an external volume',
    );
  });

  it('takes values from the env files only in image, environment and healthcheck', () => {
    expect(interpolation(compose)).toEqual([]);
    refuses(
      interpolation,
      swap(compose, './config/db/jwt.sql:', './config/db/${INIT_SQL}:'),
      'services volumes: - ./config/db/${INIT_SQL}',
    );
    refuses(
      interpolation,
      swapIn(compose, 'web', '    mem_limit: 1536m', '    mem_limit: ${WEB_MEMORY}'),
      'mem_limit',
    );
    refuses(
      interpolation,
      swapIn(compose, 'migrate', '    profiles: [migrate]', '    profiles: [${PROFILE}]'),
      'profiles',
    );
    refuses(
      interpolation,
      swap(compose, '  staging: {}', '  staging:\n    name: ${NET}'),
      'networks',
    );
  });

  it('gives every service the six limits, in the server’s ranges', () => {
    expect(limits(compose)).toEqual([]);
    refuses(
      limits,
      swapIn(compose, 'scheduler', '    pids_limit: 64\n', ''),
      'service scheduler has no pids_limit',
    );
    refuses(
      limits,
      swapIn(compose, 'restore-test', '    oom_score_adj: 600\n', ''),
      'restore-test has no oom_score_adj',
    );
    refuses(
      limits,
      swapIn(compose, 'web', '    memswap_limit: 1792m', '    memswap_limit: 2048m'),
      'service web: memswap_limit',
    );
    refuses(
      limits,
      swapIn(compose, 'db', '    cpus: 1.5', '    cpus: 2'),
      'service db: cpus over 1.5',
    );
    refuses(
      limits,
      swapIn(compose, 'web', '    oom_score_adj: -300', '    oom_score_adj: 0'),
      'service web: oom_score_adj',
    );
  });

  it('runs the webs on their image’s command, with 25 s to drain and the heaps of VPS-6', () => {
    expect(webs(compose)).toEqual([]);
    refuses(
      webs,
      swapIn(
        compose,
        'web',
        '    read_only: true',
        "    command: ['node', 'server.js']\n    read_only: true",
      ),
      'web sets command',
    );
    refuses(
      webs,
      swapIn(
        compose,
        'web-staging',
        '    read_only: true',
        "    entrypoint: ['sh']\n    read_only: true",
      ),
      'web-staging sets entrypoint',
    );
    refuses(
      webs,
      swapIn(compose, 'web', '    stop_grace_period: 25s', '    stop_grace_period: 10s'),
      'web: stop_grace_period',
    );
    refuses(
      webs,
      swap(compose, '--max-old-space-size=500', '--max-old-space-size=700'),
      'web-staging: NODE_OPTIONS',
    );
  });

  it('gives the webs only settings the app reads, each from one place', () => {
    const templates = {
      web: kit('env/web.env.example'),
      'web-staging': kit('env/web-staging.env.example'),
    };
    expect(READ_BY_APP).toContain('SUPABASE_SECRET_KEY');
    expect(READ_BY_APP).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(webSettings(compose, templates)).toEqual([]);
    refuses(
      (text) => webSettings(text, templates),
      swapIn(
        compose,
        'web',
        "      SUPABASE_FORWARD_CLIENT_IP: 'true'\n",
        "      SUPABASE_FORWARD_CLIENT_IP: 'true'\n      SUPABASE_URL: http://api-gw:8000\n",
      ),
      'web: SUPABASE_URL is read by neither the app nor Node',
    );
    refuses(
      (text) => webSettings(compose, { ...templates, 'web-staging': text }),
      `${templates['web-staging']}SUPABASE_DB_URL=\n`,
      'web-staging: SUPABASE_DB_URL is read by neither',
    );
    refuses(
      (text) => webSettings(compose, { ...templates, web: text }),
      `${templates.web}CRON_SECRET=\n`,
      'web: CRON_SECRET is in both its environment and its env file',
    );
  });

  it('hardens every service through its anchor, and restarts only the long-running ones', () => {
    expect(hardening(compose)).toEqual([]);
    refuses(
      hardening,
      swap(compose, '  cap_drop: [ALL]\n', '  cap_drop: [NET_RAW]\n'),
      'x-hardened lost',
    );
    refuses(
      hardening,
      swapIn(compose, 'scheduler', '    <<: *steady', '    <<: *oneoff'),
      'service scheduler does not start',
    );
    refuses(
      hardening,
      swapIn(compose, 'migrate', '    <<: *oneoff', '    <<: *steady'),
      'service migrate does not start',
    );
  });

  it('runs crond under Docker’s init, so a stop doesn’t wait for the kill', () => {
    expect(crondInit(compose)).toEqual([]);
    refuses(
      crondInit,
      swapIn(compose, 'scheduler', '    init: true\n', ''),
      'scheduler runs crond as process 1',
    );
    refuses(
      crondInit,
      swapIn(compose, 'backup', '    init: true\n', ''),
      'backup runs crond as process 1',
    );
    refuses(
      crondInit,
      swapIn(compose, 'web', '    read_only: true', '    init: true\n    read_only: true'),
      'web sets init',
    );
  });

  it('pins third-party images by tag and digest, and takes its own from images.env', () => {
    expect(images(compose)).toEqual([]);
    refuses(
      images,
      swap(compose, 'postgrest/postgrest:v14.18@sha256:', 'postgrest/postgrest:latest@sha256:'),
      'rest:',
    );
    const auth =
      /image: \S+@sha256:\S+/.exec((services(compose).get('auth') ?? []).join('\n'))?.[0] ?? '';
    refuses(
      images,
      swapIn(compose, 'auth', auth, 'image: supabase/gotrue:v2.197.0'),
      'auth: supabase/gotrue:v2.197.0 is not pinned',
    );
    refuses(
      images,
      swapIn(compose, 'backup', '    pull_policy: never\n', ''),
      'backup: pull_policy',
    );
  });

  it('adds up to the contract’s 6,560 MiB of steady limits', () => {
    expect(steadyTotal(compose)).toEqual([]);
    refuses(
      steadyTotal,
      swapIn(compose, 'api-gw', '    mem_limit: 224m', '    mem_limit: 256m'),
      '6592 MiB',
    );
  });

  it('names every ${NAME} it uses in the env templates, and uses every one of theirs', () => {
    expect(envNames(compose)).toEqual([]);
    refuses(
      envNames,
      swapIn(compose, 'db', "      JWT_EXP: '3600'", '      JWT_EXP: ${JWT_EXPIRY:-3600}'),
      'JWT_EXPIRY is in no template',
    );
    refuses(
      envNames,
      swap(compose, '      TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID:-}\n', ''),
      'TELEGRAM_CHAT_ID is not used',
    );
  });

  it('keeps statement text out of the database log', () => {
    expect(quietDatabase(compose)).toEqual([]);
    refuses(
      quietDatabase,
      swap(compose, '      - -c\n      - log_statement=none\n', ''),
      'db does not run with log_statement=none',
    );
    refuses(
      quietDatabase,
      swap(compose, 'log_error_verbosity=terse', 'log_error_verbosity=default'),
      'log_error_verbosity=terse',
    );
    refuses(
      quietDatabase,
      swap(compose, 'auto_explain.log_min_duration=-1', 'auto_explain.log_min_duration=10s'),
      'db does not run with auto_explain.log_min_duration=-1',
    );
  });

  it('archives db’s WAL into the spool every minute, through its own host rules', () => {
    expect(walArchive(compose)).toEqual([]);
    refuses(
      walArchive,
      swap(compose, '      - -c\n      - archive_mode=on\n', ''),
      'db does not run with archive_mode=on',
    );
    refuses(
      walArchive,
      swap(compose, 'archive_timeout=60', 'archive_timeout=300'),
      'db does not run with archive_timeout=60',
    );
    refuses(
      walArchive,
      swap(
        compose,
        '      - hba_file=/etc/postgresql-menumesh/pg_hba.conf',
        '      - hba_file=/tmp/pg_hba.conf',
      ),
      'db does not run with hba_file',
    );
    refuses(
      walArchive,
      swap(compose, "    entrypoint: ['/bin/sh', '/opt/menumesh/wal-spool.sh']\n", ''),
      'db does not start through wal-spool.sh',
    );
    refuses(
      walArchive,
      swap(
        compose,
        '/etc/postgresql-menumesh/pg_hba.conf:ro',
        '/etc/postgresql-menumesh/pg_hba.conf',
      ),
      'db lacks the mount ./config/db/pg_hba.conf',
    );
    refuses(
      walArchive,
      swapIn(compose, 'db', '    command:\n      - postgres\n', '    command:\n'),
      'db’s command does not start with postgres',
    );
  });

  it('shares the WAL spool between db and backup alone', () => {
    expect(walSpoolMounts(compose)).toEqual([]);
    refuses(
      walSpoolMounts,
      swapIn(
        compose,
        'recover',
        '      - storage-data:/storage\n',
        '      - storage-data:/storage\n      - wal-spool:/wal-spool\n',
      ),
      'recover /wal-spool',
    );
    refuses(
      walSpoolMounts,
      swapIn(
        compose,
        'backup',
        '      - wal-spool:/wal-spool\n',
        '      - wal-spool:/wal-spool:ro\n',
      ),
      'backup /wal-spool:ro',
    );
    refuses(walSpoolMounts, swap(compose, '  wal-spool: {}\n', ''), 'no wal-spool volume');
  });

  it('keeps the backup image’s Postgres data folder off an anonymous volume', () => {
    const dockerfile = kit('backup/Dockerfile');
    expect(backupDataFolder(compose, dockerfile)).toEqual([]);
    refuses(
      (text) => backupDataFolder(text, dockerfile),
      swapIn(compose, 'backup', "'/var/lib/postgresql/data:size=1m,mode=0700', ", ''),
      'anonymous volume',
    );
  });

  it('keeps the backup scripts’ own files in a small tmpfs, off the server’s disk', () => {
    expect(backupTmp(compose)).toEqual([]);
    // As before Stop C's review (finding C3): /tmp on the container's layer, the server's disk.
    refuses(
      backupTmp,
      swapIn(compose, 'backup', ", '/tmp:size=16m,mode=1777'", ''),
      'server’s disk',
    );
    refuses(
      backupTmp,
      swapIn(compose, 'backup', "'/tmp:size=16m,mode=1777'", "'/tmp:size=16m,mode=0700'"),
      'mode 1777',
    );
    refuses(
      backupTmp,
      swapIn(compose, 'backup', "'/tmp:size=16m,mode=1777'", "'/tmp:size=256m,mode=1777'"),
      'at most 64m',
    );
  });

  it('gives the signing key to the backup alone, and its public key to the restores', () => {
    expect(signingEnv(compose)).toEqual([]);
    refuses(
      signingEnv,
      swapIn(
        compose,
        'restore-test',
        '      AGE_IDENTITY_FILE: /run/age/identity.txt\n',
        '      AGE_IDENTITY_FILE: /run/age/identity.txt\n      BACKUP_SIGNING_KEY: ${BACKUP_SIGNING_KEY:?}\n',
      ),
      'BACKUP_SIGNING_KEY goes to backup, restore-test',
    );
    refuses(
      signingEnv,
      swapIn(
        compose,
        'recover',
        '      BACKUP_SIGNING_PUBLIC_KEY: ${BACKUP_SIGNING_PUBLIC_KEY:?}\n',
        '',
      ),
      'recover does not require BACKUP_SIGNING_PUBLIC_KEY',
    );
    refuses(
      signingEnv,
      swap(compose, '      HEARTBEAT_WAL_URL: ${HEARTBEAT_WAL_URL:-}\n', ''),
      'backup has no HEARTBEAT_WAL_URL',
    );
    refuses(
      signingEnv,
      swapIn(
        compose,
        'pitr-test',
        '      BACKUP_SIGNING_PUBLIC_KEY: ${BACKUP_SIGNING_PUBLIC_KEY:?}\n',
        '      BACKUP_SIGNING_PUBLIC_KEY: ${BACKUP_SIGNING_PUBLIC_KEY:-}\n',
      ),
      'pitr-test does not require BACKUP_SIGNING_PUBLIC_KEY',
    );
  });

  it('replays to a point only in its two one-offs, each with the bucket alone', () => {
    expect(pitrOneoffs(compose)).toEqual([]);
    refuses(
      pitrOneoffs,
      swapIn(compose, 'pitr-test', '    networks: [default]', '    networks: [default, data]'),
      'pitr-test is not on the default network alone',
    );
    refuses(
      pitrOneoffs,
      swapIn(compose, 'pitr-test', '    profiles: [pitr-test]', '    profiles: [restore-test]'),
      'pitr-test is not behind the profile [pitr-test]',
    );
    refuses(
      pitrOneoffs,
      swapIn(compose, 'pitr-test', '      - /var/lib/postgresql/data:size=1g,mode=0700\n', ''),
      'pitr-test’s tmpfs is /run/pitr:size=1m,mode=0700',
    );
    refuses(
      pitrOneoffs,
      swapIn(
        compose,
        'recover-pitr',
        '    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID]',
        '    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, SYS_ADMIN]',
      ),
      'recover-pitr adds [CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, SYS_ADMIN]',
    );
    refuses(
      pitrOneoffs,
      swapIn(
        compose,
        'recover-pitr',
        '      - db-data:/var/lib/postgresql/data\n',
        '      - db-data:/var/lib/postgresql/data\n      - db-config:/etc/postgresql-custom\n',
      ),
      'recover-pitr mounts db-data:/var/lib/postgresql/data, db-config:/etc/postgresql-custom',
    );
    refuses(
      pitrOneoffs,
      swapIn(
        compose,
        'recover-pitr',
        '      PITR_TARGET: ${PITR_TARGET:-}\n',
        '      PITR_TARGET: ${PITR_TARGET:-}\n      PGPASSWORD: ${POSTGRES_PASSWORD:?}\n',
      ),
      'PGPASSWORD: ${POSTGRES_PASSWORD:?}',
    );
    refuses(
      pitrOneoffs,
      swapIn(
        compose,
        'recover-pitr',
        '    networks: [default]\n',
        '    networks: [default]\n    depends_on:\n      db: { condition: service_healthy }\n',
      ),
      'recover-pitr waits for another service',
    );
    refuses(
      pitrOneoffs,
      swapIn(
        compose,
        'recover-pitr',
        "    entrypoint: ['/usr/local/bin/pitr.sh', '--into']",
        "    entrypoint: ['/usr/local/bin/pitr.sh', '--test']",
      ),
      "recover-pitr does not run ['/usr/local/bin/pitr.sh', '--into']",
    );
    refuses(
      pitrOneoffs,
      swapIn(compose, 'recover-pitr', '      PITR_ACCEPT_CUT: ${PITR_ACCEPT_CUT:-}\n', ''),
      'no PITR_ACCEPT_CUT: ${PITR_ACCEPT_CUT:-}',
    );
    refuses(
      pitrOneoffs,
      swapIn(
        compose,
        'pitr-test',
        '      PITR_TARGET: ${PITR_TARGET:-}\n',
        '      PITR_TARGET: ${PITR_TARGET:-}\n      PITR_ACCEPT_CUT: ${PITR_ACCEPT_CUT:-}\n',
      ),
      'pitr-test’s environment is not the bucket’s, the key’s and the point alone: PITR_ACCEPT_CUT',
    );
  });

  it('holds at most the recovery’s 2,304 MiB in any one-off and the one-offs it waits for', () => {
    expect(oneoffMemory(compose)).toEqual([]);
    refuses(
      oneoffMemory,
      swapIn(
        compose,
        'pitr-test',
        '    mem_limit: 1536m\n    memswap_limit: 1536m',
        '    mem_limit: 2560m\n    memswap_limit: 2560m',
      ),
      'pitr-test holds 2560 MiB',
    );
    refuses(
      oneoffMemory,
      swapIn(
        compose,
        'recover',
        '    mem_limit: 384m\n    memswap_limit: 384m',
        '    mem_limit: 512m\n    memswap_limit: 512m',
      ),
      'recover and recover-db hold 2432 MiB',
    );
  });
});

// --- the Envoy gateway ---

const lds = kit('config/envoy/lds.template.yaml');
const cds = kit('config/envoy/cds.yaml');
const envoyStart = kit('config/envoy/start.sh');
const envoyYaml = kit('config/envoy/envoy.yaml');

/** One route of the listener: the item that holds `line`. */
function route(text: string, line: string): string[] {
  const lines = text.split('\n');
  const at = lines.findIndex((found) => found.trim() === line);
  if (at < 0) return [];
  const item = (index: number) => /^ {22}- /.test(lines[index]);
  let start = at;
  while (start > 0 && !item(start)) start--;
  let end = at + 1;
  while (end < lines.length && !item(end) && !/^ {0,20}\S/.test(lines[end])) end++;
  return lines.slice(start, end).map((found) => found.trim());
}

/** Storage answers may take long: no route timeout, a minute of silence at most (VPS-35). */
const storageRoute = (text: string) => {
  const found = route(text, 'prefix: /storage/v1/');
  return [
    ...(found.includes('timeout: 0s') ? [] : ['the storage route has a timeout']),
    ...(found.includes('idle_timeout: 60s') ? [] : ['the storage route has no 60 s idle timeout']),
  ];
};

/** No Studio, meta, functions, GraphQL or MCP: their clusters and routes are gone. */
const dropped = (listeners: string, clusters: string) => [
  ...[...listeners.matchAll(/^\s+cluster: (functions|meta|studio)$/gm)].map(
    (m) => `a route to ${m[1]}`,
  ),
  ...[...clusters.matchAll(/^ {4}name: (\S+)$/gm)]
    .filter((m) => ['functions', 'meta', 'studio'].includes(m[1]))
    .map((m) => `the ${m[1]} cluster`),
  ...[
    ...listeners.matchAll(/^\s+(?:prefix|path): (\/(?:functions|pg|graphql|api\/mcp|mcp)\S*)$/gm),
  ].map((m) => `a route for ${m[1]}`),
];

/** One access log, for answers of 500 and more only, with no query, header or address. */
const accessLog = (text: string) => {
  const block = text.slice(text.indexOf('access_log:'), text.indexOf('route_config:'));
  const format = /inline_string: "(.*)"/.exec(block)?.[1] ?? '';
  return [
    ...(text.split('access_log:').length === 2 ? [] : ['not exactly one access log']),
    ...(/status_code_filter:\s+comparison:\s+op: GE\s+value:\s+default_value: 500\b/.test(block)
      ? []
      : ['the access log has no filter for 500 and above']),
    ...(format.includes('%PATH(NQ:')
      ? []
      : ['the access log does not log the path without its query']),
    ...[
      'REFERER',
      'USER-AGENT',
      'DOWNSTREAM_',
      'X-FORWARDED-FOR',
      '%REQ(:PATH)%',
      'AUTHORIZATION',
      'APIKEY',
    ]
      .filter((part) => format.toUpperCase().includes(part))
      .map((part) => `the access log holds ${part}`),
  ];
};

/**
 * How soon each service closes an idle keep-alive connection itself, in seconds (measured in the
 * rehearsal: PostgREST 30 to 60, Storage about 60, Realtime 5; Auth keeps them). Envoy keeps idle
 * upstream connections for an hour by default, so a request could go out on one the service was
 * closing and fail with a 503 (UC), which postgrest-js retries only for GET and HEAD.
 */
const SERVICE_IDLE_CLOSE: Record<string, number> = { auth: 30, rest: 30, realtime: 5, storage: 30 };
/** Every cluster closes its idle connections first, and still speaks HTTP/1.1 to its service. */
const idleClose = (clusters: string) =>
  clusters
    .split("\n  - '@type': type.googleapis.com/envoy.config.cluster.v3.Cluster\n")
    .slice(1)
    .flatMap((block) => {
      const name = /^ {4}name: (\S+)$/m.exec(block)?.[1] ?? '?';
      const seconds = Number(/^ {10}idle_timeout: (\d+)s$/m.exec(block)?.[1] ?? NaN);
      const limit = SERVICE_IDLE_CLOSE[name];
      return [
        ...(limit === undefined ? [`the ${name} cluster has no measured idle close`] : []),
        ...(seconds < limit ? [] : [`the ${name} cluster keeps idle connections ${seconds} s`]),
        ...(/^ {8}explicit_http_config:\n {10}http_protocol_options: \{\}$/m.test(block)
          ? []
          : [`the ${name} cluster does not say HTTP/1.1`]),
      ];
    });

/** Anything not routed answers 404 from Envoy itself, as from Caddy. */
const catchAll = (text: string) =>
  /- match:\n\s+prefix: \/\n\s+direct_response:\n\s+status: 404\n/.test(text)
    ? []
    : ['no 404 direct_response for /'];

/**
 * start.sh fills in exactly the template's keys, from a file that only Envoy's user reads (never
 * in a process's arguments), writes the listeners to the tmpfs envoy.yaml reads, and runs Envoy.
 */
const listenerKeys = (start: string, template: string, bootstrap: string) => {
  const filled = [
    ...start.matchAll(/^ {2}printf 's\|\$\{([A-Z_]+)\}\|%s\|g\\n' "\$\{\1\}"$/gm),
  ].map((m) => m[1]);
  const needed = [...new Set([...template.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map((m) => m[1]))];
  return [
    ...(JSON.stringify(filled.sort()) === JSON.stringify(needed.sort())
      ? []
      : [`start.sh fills in ${filled.join(' ')}; the template has ${needed.join(' ')}`]),
    ...(code(start).includes(
      'sed -f /run/envoy/keys.sed /etc/envoy/lds.template.yaml >/run/envoy/lds.yaml',
    )
      ? []
      : ['start.sh does not write the listeners to /run/envoy with sed -f']),
    ...(/^ {6}path: \/run\/envoy\/lds\.yaml$/m.test(bootstrap)
      ? []
      : ['envoy.yaml does not read the listeners from /run/envoy']),
    ...(code(start).includes('exec envoy -c /etc/envoy/envoy.yaml "$@"')
      ? []
      : ['start.sh does not exec envoy with its arguments']),
  ];
};

describe('the Envoy gateway (deploy/vps/config/envoy)', () => {
  it('lets storage answers run long, with a minute of silence at most', () => {
    expect(storageRoute(lds)).toEqual([]);
    refuses(
      storageRoute,
      swap(
        lds,
        'timeout: 0s\n                          idle_timeout: 60s',
        'timeout: 30s\n                          idle_timeout: 60s',
      ),
      'has a timeout',
    );
    refuses(
      storageRoute,
      swap(lds, '                          idle_timeout: 60s\n', ''),
      'no 60 s idle timeout',
    );
  });

  it('closes idle connections to each service before the service does', () => {
    expect(idleClose(cds)).toEqual([]);
    const realtime = cds.indexOf('    name: realtime\n');
    refuses(
      idleClose,
      cds.slice(0, realtime) +
        cds
          .slice(realtime)
          .replace('          idle_timeout: 4s\n', '          idle_timeout: 20s\n'),
      'the realtime cluster keeps idle connections 20 s',
    );
    const rest = cds.indexOf('    name: rest\n');
    refuses(
      idleClose,
      cds.slice(0, rest) +
        cds.slice(rest).replace(/ {4}typed_extension_protocol_options:\n(?: {6}.*\n)+/, ''),
      'the rest cluster keeps idle connections NaN s',
    );
    refuses(
      idleClose,
      swap(cds, '    name: storage\n', '    name: imgproxy\n'),
      'the imgproxy cluster has no measured idle close',
    );
  });

  it('routes nothing to functions, meta, Studio, GraphQL or MCP', () => {
    expect(dropped(lds, cds)).toEqual([]);
    refuses(
      (text) => dropped(text, cds),
      swap(lds, 'cluster: storage\n', 'cluster: studio\n'),
      'a route to studio',
    );
    refuses(
      (text) => dropped(text, cds),
      swap(lds, 'prefix: /storage/v1/\n', 'prefix: /graphql/v1\n'),
      'a route for /graphql/v1',
    );
    refuses(
      (text) => dropped(lds, text),
      swap(cds, '    name: storage\n', '    name: meta\n'),
      'the meta cluster',
    );
  });

  it('logs only answers of 500 and more, without a query, header or address', () => {
    expect(accessLog(lds)).toEqual([]);
    refuses(accessLog, swap(lds, 'default_value: 500', 'default_value: 200'), 'no filter for 500');
    refuses(accessLog, swap(lds, '%PATH(NQ:ORIG_OR_PATH)%', '%REQ(:PATH)%'), 'without its query');
    refuses(
      accessLog,
      swap(lds, '%UPSTREAM_CLUSTER%', '%UPSTREAM_CLUSTER% %REQ(USER-AGENT)%'),
      'USER-AGENT',
    );
    refuses(
      accessLog,
      swap(lds, '%UPSTREAM_CLUSTER%', '%UPSTREAM_CLUSTER% %DOWNSTREAM_REMOTE_ADDRESS%'),
      'DOWNSTREAM_',
    );
  });

  it('answers 404 for anything not routed', () => {
    expect(catchAll(lds)).toEqual([]);
    refuses(
      catchAll,
      swap(
        lds,
        '                          status: 404\n',
        '                          status: 200\n',
      ),
      'no 404',
    );
  });

  it('fills in the template’s six keys off the command line and keeps the listeners on the tmpfs', () => {
    expect(listenerKeys(envoyStart, lds, envoyYaml)).toEqual([]);
    expect([...lds.matchAll(/\$\{SUPABASE_SECRET_KEY\}/g)].length).toBeGreaterThan(0);
    refuses(
      (text) => listenerKeys(text, lds, envoyYaml),
      swap(
        envoyStart,
        `  printf 's|\${SUPABASE_SECRET_KEY}|%s|g\\n' "\${SUPABASE_SECRET_KEY}"\n`,
        '',
      ),
      'start.sh fills in',
    );
    refuses(
      (text) => listenerKeys(envoyStart, text, envoyYaml),
      `${lds}# \${NEW_KEY}\n`,
      'the template has',
    );
    refuses(
      (text) => listenerKeys(text, lds, envoyYaml),
      swap(envoyStart, '>/run/envoy/lds.yaml', '>/etc/envoy/lds.yaml'),
      'does not write the listeners',
    );
    refuses(
      (text) => listenerKeys(envoyStart, lds, text),
      swap(envoyYaml, 'path: /run/envoy/lds.yaml', 'path: /etc/envoy/lds.yaml'),
      'envoy.yaml does not read',
    );
  });
});

// --- the edge ---

const site = kit('edge/menumesh.caddy');

/** The site blocks: each host with its lines (trimmed, comments left out). */
function blocks(text: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of code(text)) {
    const host = /^https:\/\/(\S+) \{$/.exec(line)?.[1];
    if (host) found.set(host, (current = []));
    else if (line === '}') current = undefined;
    else current?.push(line.trim());
  }
  return found;
}
const HOSTS = ['menumesh.in', 'www.menumesh.in', 'api.menumesh.in', 'staging.menumesh.in'];

/** The four hosts, each block opening with the two imports app-apply requires. */
const siteImports = (text: string) => {
  const found = blocks(text);
  return [
    ...(JSON.stringify([...found.keys()]) === JSON.stringify(HOSTS)
      ? []
      : [`hosts ${[...found.keys()].join(' ')}`]),
    ...[...found]
      .filter(
        ([, lines]) => lines[0] !== 'import site_common' || lines[1] !== 'import tls_menumesh',
      )
      .map(([host]) => `${host} does not start with import site_common, import tls_menumesh`),
  ];
};

/** api.menumesh.in: the four Supabase prefixes to the gateway, 404 for the rest (VPS-37). */
const apiPrefixes = (text: string) => {
  const api = blocks(text).get('api.menumesh.in') ?? [];
  const at = api.indexOf('handle {');
  return [
    ...(api.includes('@supabase path /auth/v1/* /rest/v1/* /realtime/v1/* /storage/v1/*')
      ? []
      : ['@supabase is not exactly the four prefixes']),
    ...(api.includes('handle @supabase {') && api.includes('reverse_proxy menumesh-gw:8000 {')
      ? []
      : ['the prefixes do not go to menumesh-gw']),
    ...(at >= 0 && api[at + 1] === 'respond 404' ? [] : ['the rest does not get 404']),
    ...(api.filter((line) => line.startsWith('reverse_proxy')).length === 1
      ? []
      : ['more than one proxy']),
  ];
};

/** Realtime sockets outlive a reload by 5 minutes and live a day at most. */
const streams = (text: string) => {
  const api = blocks(text).get('api.menumesh.in') ?? [];
  return ['stream_close_delay 5m', 'stream_timeout 24h']
    .filter((line) => !api.includes(line))
    .map((line) => `no ${line}`);
};

/** Staging: basic auth on all but health, the install files and the two webhooks (owner, Q3). */
const STAGING_GATE = [
  '@protected {',
  'not {',
  'method GET HEAD',
  'path /api/health /app.webmanifest /sw.js /icon/* /apple-icon /maskable-icon.png /favicon.ico',
  '}',
  'not {',
  'method POST',
  'path /api/webhooks/razorpay /api/webhooks/resend',
  '}',
  '}',
  'basic_auth @protected {',
  '{$MENUMESH_STAGING_AUTH_USER} {$MENUMESH_STAGING_AUTH_HASH}',
  '}',
];
const stagingGate = (text: string) => {
  const staging = blocks(text).get('staging.menumesh.in') ?? [];
  const at = staging.indexOf('@protected {');
  return JSON.stringify(staging.slice(at, at + STAGING_GATE.length)) ===
    JSON.stringify(STAGING_GATE)
    ? []
    : ['staging’s exemptions are not exactly health, the install files and the webhooks'];
};

/** Body limits: 3 MB for the apps, 6 MB for the gateway (a 5 MiB upload and its wrapping). */
const sizes = (text: string) => {
  const found = blocks(text);
  return (
    [
      ['menumesh.in', '3MB'],
      ['api.menumesh.in', '6MB'],
      ['staging.menumesh.in', '3MB'],
    ] as const
  )
    .filter(
      ([host, size]) =>
        !(found.get(host) ?? []).join('\n').includes(`request_body {\nmax_size ${size}\n}`),
    )
    .map(([host, size]) => `${host} does not cap bodies at ${size}`);
};

/** No expression matcher (Caddy 2.11.8 and later), and only the two edge.env names. */
const placeholders = (text: string) => {
  const used = [...new Set([...text.matchAll(/\{\$([A-Z0-9_]+)\}/g)].map((m) => m[1]))].sort();
  const listed = templateNames(kit('edge/edge.env.example')).sort();
  return [
    ...(code(text).some((line) => /\bexpression\b/.test(line)) ? ['an expression matcher'] : []),
    ...(JSON.stringify(used) ===
    JSON.stringify(['MENUMESH_STAGING_AUTH_HASH', 'MENUMESH_STAGING_AUTH_USER'])
      ? []
      : [`placeholders ${used.join(' ')}`]),
    ...(JSON.stringify(used) === JSON.stringify(listed)
      ? []
      : ['edge.env.example sets other names']),
  ];
};

/** The apps serve no WebSockets: an upgrade gets 400 on menumesh.in and staging. */
const upgrades = (text: string) =>
  ['menumesh.in', 'staging.menumesh.in']
    .filter((host) => {
      const lines = blocks(text).get(host) ?? [];
      return (
        !lines.includes('@upgrade header Upgrade *') || !lines.includes('respond @upgrade 400')
      );
    })
    .map((host) => `${host} lets an upgrade through`);

/** The redaction file is the one line that turns a diner's QR token into /t/_ (VPS-37). */
const redaction = (text: string) =>
  JSON.stringify(code(text)) === JSON.stringify(['request>uri regexp ^/t/[A-Za-z0-9]+ /t/_'])
    ? []
    : ['not exactly the one line for the QR tokens'];

/**
 * Staging's basic-auth hash is made off the server, Caddy reading the password from the terminal:
 * never with --plaintext, which leaves it in a shell's history and a process list (review finding
 * S2, VPS-37). edge.env.example and the RUNBOOK give the same command.
 */
const stagingHash = (example: string, runbook: string) => {
  const commands = (text: string) =>
    [...text.matchAll(/^[#\s]*(.*\bhash-password\b.*)$/gm)].map((match) => match[1].trim());
  const all = [...commands(example), ...commands(runbook)];
  return [
    ...(commands(example).length ? [] : ['edge.env.example gives no hash-password command']),
    ...(commands(runbook).length ? [] : ['the RUNBOOK gives no hash-password command']),
    ...all
      .filter((line) => !/^docker run --rm -it caddy:[\w.-]+ caddy hash-password$/.test(line))
      .map((line) => `a hash-password command that does not read from the terminal: ${line}`),
    ...(new Set(all).size > 1 ? ['edge.env.example and the RUNBOOK give different commands'] : []),
  ];
};

describe('the edge files (deploy/vps/edge)', () => {
  it('has the four hosts, each opening with site_common and tls_menumesh', () => {
    expect(siteImports(site)).toEqual([]);
    refuses(
      siteImports,
      swap(
        site,
        'https://www.menumesh.in {\n\timport site_common\n\timport tls_menumesh\n',
        'https://www.menumesh.in {\n\timport site_common\n',
      ),
      'www.menumesh.in does not start',
    );
    refuses(
      siteImports,
      swap(site, 'https://www.menumesh.in {', 'https://shop.menumesh.in {'),
      'hosts',
    );
  });

  it('sends only the four Supabase prefixes to the gateway, and 404 for the rest', () => {
    expect(apiPrefixes(site)).toEqual([]);
    refuses(
      apiPrefixes,
      swap(site, ' /storage/v1/*\n', ' /storage/v1/* /graphql/v1/*\n'),
      'four prefixes',
    );
    refuses(
      apiPrefixes,
      swap(site, '\t\trespond 404\n', '\t\treverse_proxy menumesh-gw:8000\n'),
      'the rest does not get 404',
    );
  });

  it('keeps Realtime sockets through a reload and for a day at most', () => {
    expect(streams(site)).toEqual([]);
    refuses(streams, swap(site, 'stream_timeout 24h', 'stream_timeout 0'), 'no stream_timeout 24h');
  });

  it('puts all of staging behind basic auth but health, the install files and the webhooks', () => {
    expect(stagingGate(site)).toEqual([]);
    refuses(
      stagingGate,
      swap(site, '/maskable-icon.png /favicon.ico\n', '/maskable-icon.png /favicon.ico /t/*\n'),
      'not exactly',
    );
    refuses(
      stagingGate,
      swap(site, '\t\t\tmethod POST\n', '\t\t\tmethod GET POST\n'),
      'not exactly',
    );
  });

  it('caps request bodies at 3 MB for the apps and 6 MB for the gateway', () => {
    expect(sizes(site)).toEqual([]);
    refuses(
      sizes,
      swap(site, 'max_size 6MB', 'max_size 60MB'),
      'api.menumesh.in does not cap bodies at 6MB',
    );
  });

  it('uses no expression matcher and only the two staging basic-auth names', () => {
    expect(placeholders(site)).toEqual([]);
    refuses(
      placeholders,
      swap(
        site,
        '\t@preflight method OPTIONS\n',
        "\t@preflight expression {method} == 'OPTIONS'\n",
      ),
      'an expression matcher',
    );
    refuses(
      placeholders,
      swap(site, 'https://menumesh.in {', 'https://{$MENUMESH_DOMAIN} {'),
      'placeholders',
    );
  });

  it('refuses WebSocket upgrades on the apps', () => {
    expect(upgrades(site)).toEqual([]);
    refuses(
      upgrades,
      swap(site, 'respond @upgrade 400\n\t# Busy', 'respond @upgrade 426\n\t# Busy'),
      'menumesh.in lets',
    );
  });

  it('redacts the diners’ QR tokens with exactly one line', () => {
    const redact = kit('edge/log-redact.caddy');
    expect(redaction(redact)).toEqual([]);
    refuses(redaction, `${redact}request>uri regexp ^/k/[a-z]+ /k/_\n`, 'not exactly the one');
    refuses(redaction, swap(redact, ' /t/_', ' /t/x'), 'not exactly the one');
  });

  it('has staging’s hash made off the server, the password never in a command line', () => {
    const example = kit('edge/edge.env.example');
    const runbook = readFileSync(join('docs', 'RUNBOOK.md'), 'utf8');
    expect(stagingHash(example, runbook)).toEqual([]);
    // As before the review: the password in the command's arguments.
    refuses(
      (text) => stagingHash(text, runbook),
      swap(example, 'caddy hash-password\n', "caddy hash-password --plaintext '<password>'\n"),
      'does not read from the terminal',
    );
    refuses(
      (text) => stagingHash(example, text),
      swap(
        runbook,
        '    docker run --rm -it caddy:2.11.9-alpine caddy hash-password\n',
        '    docker run --rm caddy:2.11.9-alpine caddy hash-password\n',
      ),
      'does not read from the terminal',
    );
    refuses(
      (text) => stagingHash(text, runbook),
      swap(example, 'caddy:2.11.9-alpine', 'caddy:2.11.8-alpine'),
      'different commands',
    );
  });
});

// --- the scheduler ---

const CRON_LINES = [
  '30 21 * * * /bin/sh /opt/menumesh/cron-call daily',
  '0 22 * * * /bin/sh /opt/menumesh/cron-call daily-retry',
  '15 3 * * * /bin/sh /opt/menumesh/cron-call digest',
  '45 3 * * * /bin/sh /opt/menumesh/cron-call digest-retry',
  '* * * * * /bin/sh /opt/menumesh/cron-call jobs',
];
/** The five calls at their UTC times (03:00, 03:30, 08:45, 09:15 IST and every minute), no secret. */
const crontab = (text: string) => [
  ...(JSON.stringify(code(text)) === JSON.stringify(CRON_LINES) ? [] : ['not the five lines']),
  ...(/Bearer|CRON_SECRET|\$/.test(text) ? ['a secret or a variable in the crontab'] : []),
];

const cronCall = kit('config/scheduler/cron-call');
/** The four limits, the bearer and URLs on curl's stdin only, never a header in its arguments. */
const cronCallRules = (text: string) => {
  // Where curl runs: at the start of a command, after a pipe or in $(...); not in a message.
  const curls = code(text).filter((line) => /(?:^|[|;&]|\$\()\s*curl\s/.test(line));
  return [
    ...[
      'daily) route=daily max=1740 ;;',
      'daily-retry) route=daily max=1800 ;;',
      'digest | digest-retry) route=digest max=300 ;;',
      'jobs) route=jobs max=25 ;;',
    ]
      .filter((line) => !code(text).some((found) => found.trim() === line))
      .map((line) => `no ${line}`),
    ...(curls.length >= 2 ? [] : ['fewer than two curl calls']),
    ...curls
      .filter((line) => !line.includes('--config -'))
      .map((line) => `curl without --config -: ${line.trim()}`),
    ...curls
      .filter((line) => /--header|\s-H\s|CRON_SECRET|_URL/.test(line))
      .map((line) => `curl arguments: ${line.trim()}`),
    ...(text.includes('--max-time "$max"') ? [] : ['the call has no --max-time "$max"']),
  ];
};

/**
 * A daily or digest call without a 200 takes the day's marker away, so its retry runs even after a
 * 200 by hand earlier the same UTC day; a 200 still leaves the marker, and a retry still looks for
 * it (review finding C1, VPS-38).
 */
const cronCallRetry = (text: string) => {
  const lines = code(text).map((line) => line.trim());
  const failure = lines.indexOf('case $status in');
  const rearm = lines.indexOf('daily | digest) rm -f "$marker" ;;');
  return [
    ...(failure >= 0 && rearm > failure && lines.at(-1) === 'exit 1'
      ? []
      : ['a failed daily or digest call leaves the marker to its retry']),
    ...(lines.includes('*-retry) if [ -e "$marker" ]; then exit 0; fi ;;')
      ? []
      : ['a retry does not look for the marker']),
    ...(lines.includes('touch "$marker"') ? [] : ['a 200 leaves no marker']),
  ];
};

/** start.sh writes the values only root can read, then runs crond in the foreground, quietly. */
const schedulerStart = (text: string) => [
  ...(code(text).includes('umask 077') ? [] : ['cron.env is not written under umask 077']),
  ...(code(text).includes('exec crond -f -c /etc/crontabs -L /dev/stderr -l 9')
    ? []
    : ['crond does not run as crond -f -c /etc/crontabs -L /dev/stderr -l 9']),
];

describe('the scheduler (deploy/vps/config/scheduler)', () => {
  it('runs the five calls at their times, in both crontabs, with no secret in them', () => {
    for (const file of ['production.crontab', 'staging.crontab']) {
      expect(crontab(kit(`config/scheduler/${file}`)), file).toEqual([]);
    }
    const production = kit('config/scheduler/production.crontab');
    refuses(crontab, swap(production, '30 21 * * *', '30 20 * * *'), 'not the five lines');
    refuses(crontab, swap(production, 'cron-call jobs', 'cron-call jobs $CRON_SECRET'), 'a secret');
  });

  it('gives each call its limit and hands curl the bearer on stdin', () => {
    expect(cronCallRules(cronCall)).toEqual([]);
    refuses(
      cronCallRules,
      swap(cronCall, 'max=1740', 'max=1800'),
      'no daily) route=daily max=1740 ;;',
    );
    refuses(
      cronCallRules,
      swap(cronCall, 'jobs) route=jobs max=25', 'jobs) route=jobs max=60'),
      'no jobs)',
    );
    refuses(
      cronCallRules,
      swap(
        cronCall,
        '  curl --config - --silent',
        '  curl --header "Authorization: Bearer $CRON_SECRET" --config - --silent',
      ),
      'curl arguments',
    );
    refuses(
      cronCallRules,
      swap(
        cronCall,
        'curl --config - --silent --output /dev/null --max-time 10',
        'curl --silent --output /dev/null --max-time 10 "$beat"',
      ),
      'curl without --config -',
    );
  });

  it('runs a retry after a failed call, even after a 200 by hand earlier that day', () => {
    expect(cronCallRetry(cronCall)).toEqual([]);
    // As before the review: the failure path kept the marker.
    refuses(
      cronCallRetry,
      swap(cronCall, 'daily | digest) rm -f "$marker" ;;\n', ''),
      'leaves the marker to its retry',
    );
    refuses(
      cronCallRetry,
      swap(cronCall, '*-retry) if [ -e "$marker" ]; then exit 0; fi ;;', '*-retry) ;;'),
      'does not look for the marker',
    );
  });

  it('writes the values only root can read, then runs crond quietly in the foreground', () => {
    const start = kit('config/scheduler/start.sh');
    expect(schedulerStart(start)).toEqual([]);
    refuses(schedulerStart, swap(start, 'umask 077', 'umask 022'), 'umask 077');
    refuses(schedulerStart, swap(start, '-L /dev/stderr -l 9', '-L /dev/stderr -l 8'), 'crond');
  });
});

// --- the migrate and backup images ---

const instructions = (text: string) => code(text).filter((line) => /^[A-Z]+ /.test(line));

/** Only the migrations and the runner go into the migrate image, which runs as postgres. */
const migrateImage = (dockerfile: string) => {
  const copies = instructions(dockerfile).filter((line) => /^(COPY|ADD) /.test(line));
  return [
    ...(JSON.stringify(copies) ===
    JSON.stringify([
      'COPY supabase/migrations/ /migrations/',
      'COPY --chmod=755 deploy/vps/migrate/migrate.sh /usr/local/bin/menumesh-migrate',
    ])
      ? []
      : [`copies ${copies.join('; ')}`]),
    ...(instructions(dockerfile)
      .filter((line) => line.startsWith('USER '))
      .at(-1) === 'USER postgres'
      ? []
      : ['it does not run as postgres']),
  ];
};
/** The build context is an allowlist of the migrations and the runner's folder, without a seed. */
const migrateContext = (ignore: string) => {
  const rules = code(ignore).map((line) => line.trim());
  return [
    ...(rules[0] === '*' ? [] : ['the ignore file does not start with *']),
    ...(JSON.stringify(rules.filter((rule) => rule.startsWith('!'))) ===
    JSON.stringify(['!supabase/migrations/', '!deploy/vps/migrate/'])
      ? []
      : ['it lets in more than the migrations and the runner']),
    ...(rules.some((rule) => /seed/i.test(rule)) ? ['it names a seed path'] : []),
    ...(['**/.env', '**/.env.*'].every(
      (rule) => rules.indexOf(rule) > rules.lastIndexOf('!deploy/vps/migrate/'),
    )
      ? []
      : ['env files are not kept out last']),
  ];
};

/**
 * A migration's top-level statements: its text without comments, quoted text and dollar-quoted
 * bodies (functions, DO blocks), split at the semicolons. Not taught: BEGIN ATOMIC bodies.
 */
const SQL_SKIPPED =
  /--[^\n]*|\/\*[\s\S]*?\*\/|[eE]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g;
const topStatements = (sql: string) =>
  sql
    .replace(SQL_SKIPPED, (found) => (/^(--|\/\*)/.test(found) ? ' ' : "''"))
    .split(';')
    .map((statement) => statement.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

/**
 * migrate.sh runs each file between its own begin and commit, with its history row (VPS-39). A
 * file that ends that transaction itself would be recorded apart from its own changes, and what
 * Postgres can't run in a transaction block fails there.
 */
const migrationTransactions = (files: Record<string, string>) =>
  Object.entries(files).flatMap(([name, sql]) =>
    topStatements(sql)
      .filter(
        (statement) =>
          /^(begin|commit|end|rollback|abort|savepoint|release|start transaction|prepare transaction)\b/i.test(
            statement,
          ) ||
          /\bconcurrently\b/i.test(statement) ||
          /^(vacuum|alter system|(create|drop) (database|tablespace))\b/i.test(statement),
      )
      .map((statement) => `${name}: ${statement.slice(0, 60)}`),
  );

const backupSh = kit('backup/backup.sh');
/** 02:00 IST nightly; a missing, stale (2 h) or empty (1 KiB) settings archive fails the night. */
const backupRules = (dockerfile: string, script: string) => [
  ...(dockerfile.includes("printf '30 20 * * * /usr/local/bin/backup.sh\\n")
    ? []
    : ['the image’s crontab is not 30 20 * * *']),
  ...(script.includes('elif [ -n "$(find "$archive" -mmin +120)" ]; then')
    ? []
    : ['no 2-hour check of the archive']),
  ...(script.includes('elif [ "$(wc -c <"$archive")" -le 1024 ]; then')
    ? []
    : ['no size check of the archive']),
  ...(script.includes(
    'expected="globals-$night.sql.age:256 storage-$night.tar.age:1024 manifest-$night.txt.age:256"',
  ) &&
  script.includes('expected="$expected $db-$night.dump.age:1024"') &&
  script.includes('expected="$expected config-$night.tar.age:1024"')
    ? []
    : ['the uploads’ size floors changed']),
];

/**
 * The settings archive is checked and copied right after the manifest, as in Stop B, before the
 * base, which may run for 2 hours: checked after it, an archive made at 20:20 could be more than 2
 * hours old by then, and a night whose base took long failed for an archive that was fresh (Stop
 * C's review, finding D4). Its sha256 and size still go to the seal, and a missing or stale one
 * still fails the night at the end (backupRules, baseRules).
 */
const archiveFirst = (script: string) => {
  const manifest = script.indexOf(`printf '%s\\n' "$manifest" | put "manifest-$night.txt.age"`);
  const aged = script.indexOf('elif [ -n "$(find "$archive" -mmin +120)" ]; then');
  const kept = script.indexOf('  sealed "config-$night.tar.age" "$(sha256sum "$archive"');
  const copied = script.indexOf(
    '  rclone copyto --no-check-dest "$archive" "$day/config-$night.tar.age"\n',
  );
  const base = script.indexOf("\nreason='the base backup'\nif base; then\n");
  return manifest >= 0 && aged > manifest && kept > aged && copied > kept && base > copied
    ? []
    : [
        'the settings archive is checked or copied after the base begins, which may run 2 hours, so a fresh archive can be taken for a stale one',
      ];
};

/**
 * The month's copy in monthly/ is a whole night, its uploads checked and sealed, its base made and
 * its settings archive fresh: the 1st's, whatever monthly/ holds, or the next whole night's while
 * monthly/ holds no whole copy of the month (review findings B4, N2 and N3, VPS-40). Since VPS-43 a
 * whole copy is one whose seal, read by its name and no longer than a seal, seal_open takes for its
 * night (seal.sh's lines, signed by a key of BACKUP_SIGNING_PUBLIC_KEY), with a base, a settings
 * archive and a dump of each of tonight's databases, every part it lists in monthly/ at the size it
 * gives; at most 5 seals named as backup.sh names one are tried. So names planted in monthly/ can't
 * stop the 1st's copy nor stand in for a whole one, a night whose settings archive or base failed
 * is never the copy, and a 1st that failed leaves it to the next whole night. The seal goes last,
 * and the copy still comes before the night's failure. Each part is looked up by its exact name:
 * a listing of monthly/ quotes no name, and an object named after a part, a space and more passed
 * for the part, so a copied seal and such names stopped the month's copy (Stop C's review, finding
 * S2); a listing line of more than a size and a name is no candidate seal either.
 */
const monthlyCopy = (script: string) => {
  const uploads = script.indexOf("reason='the check of the uploads'");
  const sealed = script.indexOf(
    'rclone copyto --no-check-dest "$work/seal" "$day/seal-$night.txt"',
  );
  const whole = script.indexOf(
    'if [ -z "$archive_problem" ] && [ -z "$base_problem" ]; then\n  case $stamp in',
  );
  const first = script.indexOf('    ????-??-01T*) whole= ;;');
  const listed = script.indexOf(
    `      rclone lsf --files-only --format sp --separator ' ' --include "seal-$month-*" --include "copy-$month-*" "$remote/monthly/" |`,
  );
  const tried = script.indexOf('>"$work/candidates"');
  const loop = script.indexOf(
    '      whole=\n      while read -r candidate; do\n        if whole_copy "$candidate" </dev/null; then',
  );
  const check = script.indexOf('  if [ -z "$whole" ]; then');
  const parts = script.indexOf(
    '      rclone copyto --no-check-dest "$day/$name" "$remote/monthly/$name"',
  );
  const seal = script.indexOf(
    '    rclone copyto --no-check-dest "$work/seal" "$remote/monthly/seal-$night.txt"',
  );
  const failed = script.indexOf('[ -z "$problems" ] || fail "$problems"');
  const copy = script.slice(
    script.indexOf('whole_copy() {'),
    script.indexOf("reason='the monthly copy'"),
  );
  return [
    ...(script.includes('--include "manifest-$month-*"')
      ? ['any name in monthly/ stops the month’s copy']
      : []),
    ...(whole > uploads && uploads >= 0 && whole > sealed && sealed >= 0
      ? []
      : [
          'a night whose settings archive or base failed, or not sealed yet, can be the month’s copy',
        ]),
    ...(first > whole && first < check ? [] : ['the 1st’s copy waits on what monthly/ holds']),
    ...(listed > first && loop > listed && loop < check
      ? []
      : ['a 1st that failed leaves the month without a copy']),
    ...(script.includes(`        sort -u | awk 'NR <= 5' >"$work/candidates"`) && tried > listed
      ? []
      : ['more than 5 seals in monthly/ are tried']),
    ...(script.includes(
      String.raw`$2 ~ ("^(seal|copy)-" month "-[0-9][0-9]T[0-9][0-9][0-9][0-9]Z-[0-9a-f]{8}[.]txt$") {`,
    ) && script.includes('sealed[substr($2, 6, 25)] = 1')
      ? []
      : ['a whole copy in monthly/ is not looked for by a seal named with a night’s id']),
    ...(script.includes('          NF == 2 && $1 ~ /^[1-9][0-9]*$/ && $2 ~ ("^(seal|copy)-" month')
      ? []
      : ['a listing line of more than a size and a name is taken for a seal']),
    ...(copy.includes(
      'rclone cat --no-traverse --head "$((seal_max + 1))" "$remote/monthly/seal-$1.txt" >"$work/candidate" &&',
    ) && copy.includes('    seal_open "$work/candidate" "$1" &&')
      ? []
      : ['a copy in monthly/ counts as whole without a seal that checks out']),
    ...(copy.includes(
      `    awk '{ print $3 }' "$work/candidate.parts" | held "$remote/monthly" >"$work/candidate.held" &&`,
    ) &&
    copy.includes(`}' "$work/candidate.parts" "$work/candidate.held"`) &&
    !/\brclone lsf\b|"\$work\/monthly"/.test(copy)
      ? []
      : ['a copy counts as whole by a listing of monthly/, not each part looked up by its name']),
    ...(copy.includes('NF == 2 && ($2 in want) && $1 == want[$2] { have[$2] = 1 }') &&
    copy.includes('for (name in want) if (!(name in have)) exit 1')
      ? []
      : ['a copy counts as whole without each part at the size its seal gives']),
    ...(copy.includes(' base-" night ".tar.zst.age config-" night ".tar.age", need, " ")') &&
    copy.includes('need[n + i] = db[i] "-" night ".dump.age"') &&
    copy.includes('if (!(need[i] in want)) exit 1')
      ? []
      : ['a copy counts as whole without its base, settings archive or a dump of each database']),
    ...(parts > check && seal > parts ? [] : ['the seal is not copied after every part']),
    ...(seal < failed && failed >= 0 ? [] : ['the copy is not before the night’s failure']),
  ];
};

/**
 * A month's copy counts as whole only with its record, monthly/copy-<night>.txt: the line
 * "menumesh copy 1 <night> <sha256 of the night's seal>" and its signature, which backup.sh alone
 * signs, and only once its own copy is in monthly/, each part and the seal looked up there by its
 * exact name at the size it went up and the seal compared byte for byte, and which it writes last
 * and confirms by its name at its size. whole_copy builds that line itself, from the candidate's
 * id and the very seal file seal_open checked; looks the record up by its exact name before it
 * reads it (rclone cat of a missing name reads every object under it); reads at most 257 bytes and
 * takes 256; compares the record byte for byte with the line, "signature ", the signature and a
 * newline; and checks the signature with any of BACKUP_SIGNING_PUBLIC_KEY's keys, as a seal's. So
 * objects of the sealed sizes under a night's free names in monthly/, beside its real seal copied
 * there from daily/, are no copy, and the next whole night copies itself (Stop C's re-review, the
 * rest of finding S2). The record's name is among tonight's names looked for before the first
 * upload. The night that copies says "kept in monthly/" in a line of its own as soon as the record
 * is up, before the removal of old copies, which can fail, and a whole night that found a recorded
 * copy names it in its last line (finding B1).
 */
const copyRecord = (script: string) => {
  const at = (text: string) => script.indexOf(text);
  const copy = script.slice(at('whole_copy() {'), at("reason='the monthly copy'"));
  const inCopy = (text: string) => copy.indexOf(text);
  const names = at(
    `for part in $expected "base-$night.tar.zst.age:1024" "config-$night.tar.age:1024" "seal-$night.txt:0" "copy-$night.txt:0"; do echo "\${part%:*}"; done |`,
  );
  const first = at('pg_dumpall --globals-only | put');
  const parts = at('      rclone copyto --no-check-dest "$day/$name" "$remote/monthly/$name"');
  const seal = at(
    '    rclone copyto --no-check-dest "$work/seal" "$remote/monthly/seal-$night.txt"',
  );
  const checked = at(`    reason="the check of the month's copy"`);
  const looked = at('      echo "seal-$night.txt"\n    } | held "$remote/monthly")');
  const sized = at(
    '      [ "$size" = "$sent" ] || fail "monthly/$name is not in the bucket as it went up"',
  );
  const compared = at('    cmp -s "$work/copied" "$work/seal" ||');
  const built = at('    record_message "$night" "$work/seal" >"$work/record.message" ||');
  const signed = at('    signature=$(seal_sign "$work/record.message")');
  const recorded = at(
    '    rclone copyto --no-check-dest "$work/record" "$remote/monthly/copy-$night.txt"',
  );
  const confirmed = at('    [ "$recorded" = "$(($(wc -c <"$work/record")))" ] ||');
  const said = at(`    echo "backup $night: kept in monthly/ as the month's copy"`);
  const removal = at("reason='the removal of old copies'");
  const opened = inCopy('    seal_open "$work/candidate" "$1" &&');
  const message = inCopy('    record_message "$1" "$work/candidate" >"$work/candidate.message" &&');
  const lookedUp = inCopy(
    '    echo "copy-$1.txt" | held "$remote/monthly" >"$work/candidate.recorded" &&',
  );
  const read = inCopy('"$remote/monthly/copy-$1.txt" >"$work/candidate.record" &&');
  const whole = inCopy('    cmp -s "$work/candidate.built" "$work/candidate.record" &&');
  const verified = inCopy('    seal_verify "$work/candidate.message" "$record_signature" &&');
  const partsHeld = inCopy(
    `    awk '{ print $3 }' "$work/candidate.parts" | held "$remote/monthly"`,
  );
  return [
    ...(script.includes(`  printf 'menumesh copy 1 %s %s\\n' "$1" "$record_sum"`) &&
    script.includes(`  record_sum=$(sha256sum "$2" | cut -d ' ' -f 1) || return 1`)
      ? []
      : ['the record’s line is not the night and the sha256 of its seal’s bytes']),
    ...(names >= 0 && names < first
      ? []
      : ['the record’s name is not among tonight’s names looked for before the first upload']),
    ...(seal > parts &&
    checked > seal &&
    looked > checked &&
    sized > looked &&
    compared > sized &&
    built > compared
      ? []
      : [
          'the record is made before the copy is checked in monthly/, each part and the seal by its name and the seal byte for byte',
        ]),
    ...(signed > built && recorded > signed && confirmed > recorded
      ? []
      : ['the record is not signed, written last and confirmed by its name at its size']),
    ...(said > confirmed && said < removal
      ? []
      : [
          'the night that makes the copy doesn’t say "kept in monthly/" as soon as the record is up, before the removal of old copies',
        ]),
    ...(script.includes(`    kept=", the month's copy is $whole"`)
      ? []
      : ['a whole night that found a recorded copy doesn’t name it']),
    ...(message > opened && opened >= 0 && verified > whole && whole > message
      ? []
      : ['a copy counts as whole without its record']),
    ...(lookedUp > message && read > lookedUp
      ? []
      : ['the record is read before it is looked up by its exact name']),
    ...(copy.includes('$1 + 0 <= 256 { found = 1 }') &&
    copy.includes('    rclone cat --no-traverse --head 257 "$remote/monthly/copy-$1.txt"') &&
    copy.includes('    [ "$(($(wc -c <"$work/candidate.record")))" -le 256 ] &&')
      ? []
      : ['a record longer than 256 bytes is read or taken']),
    ...(/\b(?:awk|sed|grep|cut|read)\b[^\n]*"\$work\/candidate\.record"/.test(copy) ||
    copy.split('record_message ').length !== 2 ||
    copy.split('"$remote/monthly/seal-$1.txt"').length !== 2
      ? [
          'the record’s line is taken from the bucket, or built from another seal than the one checked',
        ]
      : []),
    ...(copy.includes('seal_verify_first')
      ? ['the record is checked with the first key alone']
      : []),
    ...(partsHeld > verified
      ? []
      : ['the parts are not looked up by name once the record is checked']),
  ];
};

/**
 * restore.sh, pitr.sh and pnpm vps:verify-night never read a copy's record, nor need one: a year
 * of copies made before the records, and any made by hand, have none, and a restore reads a night
 * by its seal and its parts' names alone (Stop C's re-review, the rest of finding S2).
 */
const recordsUnread = (files: Record<string, string>) =>
  Object.entries(files)
    .filter(([, text]) =>
      text.split('\n').some((line) => !/^\s*(#|\/\/|\/?\*)/.test(line) && line.includes('copy-')),
    )
    .map(([name]) => `${name} reads a copy’s record`);

/** The month's copy's names, looked up in monthly/ by name right before the copy goes up. */
const COPY_LOOKUP = `    there=$({\n      for part in $expected; do echo "\${part%:*}"; done\n      echo "seal-$night.txt"\n      echo "copy-$night.txt"\n    } | held "$remote/monthly" | awk '{ printf "%s%s", sep, $2; sep = " " }')\n`;
/** The record's name, looked up in monthly/ once more right before the record goes up. */
const RECORD_LOOKUP = `    there=$(echo "copy-$night.txt" | held "$remote/monthly" | awk '{ printf "%s%s", sep, $2; sep = " " }')\n`;
const COPY_REFUSED = `      fail "someone else wrote to the bucket: monthly/ holds $there before tonight's copy"\n`;
const RECORD_REFUSED = `      fail "someone else wrote to the bucket: monthly/ holds $there before the record of tonight's copy"\n`;

/**
 * Right before the month's copy goes up, each of its names is looked up in monthly/ by its exact
 * name (held, nothing listed): every part's, the seal's and the record's; and right before the
 * record goes up, the record's once more. Nobody could know them before the night, and the check
 * of tonight's names found none there, so one that is there now was put there while the night ran
 * by someone watching daily/'s listing: the night stops with "someone else wrote to the bucket",
 * which the RUNBOOK's stolen-token steps take for a theft. Before, locks that refuse overwrites
 * refused the copy or the record on such an object, and the night failed with "the monthly copy"
 * or "the record of the month's copy", which never said why (Stop C's re-review, finding R1).
 */
const copyNamesFree = (script: string) => {
  const at = (text: string) => script.indexOf(text);
  const copying = at('  if [ -z "$whole" ]; then\n');
  const looked = at(COPY_LOOKUP);
  const refused = at(`    [ -z "$there" ] ||\n${COPY_REFUSED}`);
  const parts = at('      rclone copyto --no-check-dest "$day/$name" "$remote/monthly/$name"');
  const signed = at('    signature=$(seal_sign "$work/record.message")');
  const recordLooked = at(RECORD_LOOKUP);
  const recordRefused = at(`    [ -z "$there" ] ||\n${RECORD_REFUSED}`);
  const recorded = at(
    '    rclone copyto --no-check-dest "$work/record" "$remote/monthly/copy-$night.txt"',
  );
  const checks = script.slice(copying, at(`    reason="the check of the month's copy"`));
  return [
    ...(copying >= 0 && looked > copying && refused > looked && parts > refused
      ? []
      : [
          'the month’s copy goes up without its names, its record’s among them, looked up in monthly/ by name right before it, and the night stopped as a theft',
        ]),
    ...(signed >= 0 &&
    recordLooked > signed &&
    recordRefused > recordLooked &&
    recorded > recordRefused
      ? []
      : [
          'the record goes up without its name looked up in monthly/ right before it, and the night stopped as a theft',
        ]),
    ...(/\brclone lsf\b/.test(checks)
      ? ['tonight’s names in monthly/ are looked for by a listing, not each by its exact name']
      : []),
  ];
};

/**
 * Of the month's seals in monthly/, only those with a record there are candidates for the month's
 * copy, at most 5, oldest first: one listing of both, each named as backup.sh names one, a seal no
 * longer than a seal and a record than a record, a line of more than a size and a name no
 * object's. A seal without its record counted toward the 5, so five copies cut short before their
 * records, or five seals someone else put there, hid a recorded copy behind them, and every later
 * night of the month copied itself again (Stop C's re-review, design note 3).
 */
const recordedCandidates = (script: string) => {
  const listed = script.indexOf(
    `      rclone lsf --files-only --format sp --separator ' ' --include "seal-$month-*" --include "copy-$month-*" "$remote/monthly/" |\n`,
  );
  const listing = listed < 0 ? '' : script.slice(listed, script.indexOf('>"$work/candidates"'));
  return [
    ...(listing.includes(
      String.raw`          NF == 2 && $1 ~ /^[1-9][0-9]*$/ && $2 ~ ("^(seal|copy)-" month "-[0-9][0-9]T[0-9][0-9][0-9][0-9]Z-[0-9a-f]{8}[.]txt$") {`,
    )
      ? []
      : [
          'the month’s seals and records in monthly/ are not listed together, each by the name backup.sh gives it',
        ]),
    ...(listing.includes(
      '            if ($2 ~ /^seal-/ && $1 + 0 <= max) sealed[substr($2, 6, 25)] = 1\n',
    ) &&
    listing.includes(
      '            if ($2 ~ /^copy-/ && $1 + 0 <= 256) recorded[substr($2, 6, 25)] = 1\n',
    )
      ? []
      : ['a seal longer than a seal, or a record longer than a record, makes a candidate']),
    ...(listing.includes('          END { for (id in sealed) if (id in recorded) print id }')
      ? []
      : ['a seal without its record counts toward the 5 candidates']),
    ...(listing.includes(`        sort -u | awk 'NR <= 5'`)
      ? []
      : ['more than 5 candidates, or not the oldest, are tried']),
  ];
};

/**
 * whole_copy looks a candidate's seal up by its exact name, no longer than a seal, before it reads
 * it, as it does the record: rclone cat of a name the folder doesn't hold reads every object under
 * that name and a slash (Stop C's re-review, design note 7).
 */
const sealLookedUp = (script: string) => {
  const copy = script.slice(
    script.indexOf('whole_copy() {'),
    script.indexOf("reason='the monthly copy'"),
  );
  const lookedUp = copy.indexOf(
    '\n  echo "seal-$1.txt" | held "$remote/monthly" >"$work/candidate.sealed" &&\n',
  );
  const sized = copy.indexOf(
    `    LC_ALL=C awk -v name="seal-$1.txt" -v max="$seal_max" '\n      NF == 2 && $2 == name && $1 ~ /^[1-9][0-9]*$/ && $1 + 0 <= max { found = 1 }\n      END { exit found ? 0 : 1 }' "$work/candidate.sealed" &&\n`,
  );
  const read = copy.indexOf(
    'rclone cat --no-traverse --head "$((seal_max + 1))" "$remote/monthly/seal-$1.txt"',
  );
  return lookedUp >= 0 && sized > lookedUp && read > sized
    ? []
    : [
        'a candidate’s seal is read before it is looked up by its exact name, no longer than a seal',
      ];
};

/**
 * Every rclone copyto writes whatever its destination holds (--no-check-dest). Without it rclone
 * skips a destination of the same size and modification time, so a look-alike a token holder put
 * at monthly/<name> during the 1st's run stayed as the month's copy, with no write for a lock to
 * refuse (final verifier's finding V1).
 */
const copyWrites = (script: string) =>
  script
    .split('\n')
    .filter((line) => /\brclone copyto\b/.test(line) && !line.trimStart().startsWith('#'))
    .filter((line) => !/\brclone copyto --no-check-dest /.test(line))
    .map((line) => `a copy skips an equal destination: ${line.trim()}`);

/**
 * Each night's names end in its id, its stamp and 8 random hex characters from /dev/urandom, so no
 * name of a night to come can be put in the bucket ahead of it, where the bucket's locks would
 * refuse the night's own uploads for 29 days (review finding F1, VPS-40). The manifest's first
 * line, the monthly copy, the journal line and the failure line carry the id, and none of tonight's
 * names may be in either folder before the first upload: nobody could know them, so one that is
 * there means someone else wrote to the bucket. The lookups ask for each name, listing nothing.
 */
const nightIds = (script: string) => {
  const hex = script.indexOf(String.raw`hex=$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')`);
  const id = script.indexOf(
    '  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) night=$stamp-$hex ;;',
  );
  const check = script.indexOf('for folder in daily monthly; do');
  const refused = script.indexOf(
    `fail "someone else wrote to the bucket: $folder/ holds $there before tonight's first upload"`,
  );
  const first = script.indexOf('pg_dumpall --globals-only | put');
  return [
    ...(hex >= 0 && id > hex ? [] : ['a night’s names can be known before it runs']),
    ...(/-\$stamp\./.test(script) ? ['a name ends in the stamp alone'] : []),
    ...(script.includes('manifest="menumesh backup $night"') &&
    script.includes('"backup $night: $summary$kept"') &&
    script.includes('message="[menumesh] backup failed (exit $status) at $night: $reason"')
      ? []
      : ['the manifest’s first line or a journal line doesn’t name the night’s id']),
    ...(check > id && refused > check && refused < first
      ? []
      : ['tonight’s names are not looked for in both folders before the first upload']),
    ...(script.includes(
      `rclone lsf --files-only --no-traverse --format sp --separator ' ' --files-from-raw - "$1/"`,
    )
      ? []
      : ['tonight’s names are looked for by a listing of the folder']),
  ];
};

/**
 * The removal of old copies takes an object's age from the bucket's own time of its upload
 * (--use-server-modtime), never from the modification time its uploader set, which a token holder
 * can set to 2020 on an object the bucket's lock then keeps: every night's removal would try it
 * and fail (review finding F3, VPS-40).
 */
const serverTime = (script: string) => {
  const removals = code(script).filter((line) => line.includes('rclone delete'));
  return [
    ...(removals.length === 3 ? [] : [`${removals.length} removals, not 3`]),
    ...removals
      .filter((line) => !line.includes(' --use-server-modtime '))
      .map((line) => `a removal reads the uploader’s time: ${line.trim()}`),
  ];
};

/**
 * The shipped WAL goes after 15 days, a day past the 14 a point-in-time recovery reaches back, by
 * the bucket's own time of upload, but each cluster's timeline history files, which a recovery to
 * any point reads (VPS-43).
 */
const walRetention = (script: string) =>
  code(script).some(
    (line) =>
      line.trim() ===
      `rclone delete --use-server-modtime --min-age 15d --exclude '/*/history/**' "$remote/wal/"`,
  )
    ? []
    : ['the shipped WAL is not removed after 15 days by its upload, history files kept'];

/**
 * The heartbeat carries the night's journal line: with the server and its journal gone, the
 * monitor's log still names each whole night's id, which a recovery needs and the bucket's token
 * can't reach (VPS-40, RUNBOOK, Disaster recovery).
 */
const beatNight = (backup: string, notify: string) => [
  ...(backup.includes('line="backup $night: $summary$kept"') &&
  backup.includes('notify.sh beat "$line"')
    ? []
    : ['the heartbeat doesn’t carry the night’s line']),
  ...(notify.includes('[ -z "${2-}" ] || printf \'data-raw = %s\\n\' "$(quoted "$2")"')
    ? []
    : ['notify.sh beat sends no text']),
];

/**
 * Only locks that refuse overwrites (prefix-scoped bucket locks, such as R2's) keep what a restore
 * reads: a retention date on each object (S3 Object Lock) keeps the old versions only, and a
 * restore reads the current one (review finding F5). backup.sh's comment and the RUNBOOK's bucket
 * step say so, and the step no longer counts per-object retention beside the locks.
 */
const retentionClaim = (backup: string, runbook: string) => {
  const flat = (text: string) =>
    text
      .split('\n')
      .map((line) => line.replace(/^\s*#?\s*/, ''))
      .join(' ');
  const step = flat(
    runbook.slice(runbook.indexOf('2. **The bucket:**'), runbook.indexOf('3. **Alerts:**')),
  );
  return [
    ...(flat(backup).includes('keeps the old versions only, and a restore reads the current one')
      ? []
      : ['backup.sh counts per-object retention as keeping what a restore reads']),
    ...(step.includes('keeps the old versions only, and a restore reads the current one')
      ? []
      : ['the RUNBOOK’s bucket step doesn’t say what per-object retention keeps']),
    ...(/or a retention date on each object, keep/.test(step)
      ? ['the RUNBOOK’s bucket step counts per-object retention beside the locks']
      : []),
  ];
};

const barePostgres = kit('config/db/bare-postgres.sh');
const restoreSh = kit('backup/restore.sh');
/**
 * CREATE EXTENSION pg_cron works only in the database cron.database_name names, so the bare
 * clusters keep pg_cron's launcher in postgres, as db does, and launch no restored job; restore.sh
 * then drops initdb's postgres from under the launcher with FORCE (VPS-40).
 */
const restoreCron = (bare: string, restore: string) => [
  ...(bare.includes('  -c cron.database_name=postgres \\\n')
    ? []
    : ['pg_cron’s launcher is not in postgres']),
  ...(bare.includes('  -c cron.launch_active_jobs=off \\\n')
    ? []
    : ['a restored pg_cron job could run in the bare cluster']),
  ...(restore.includes('drop database if exists \\"$db\\" with (force)"')
    ? []
    : ['the restore drops a database without FORCE']),
];

/**
 * Postgres's lock file can't see a server in another container, so recover-db would start a second
 * server on db's files if db still ran. bare-postgres.sh starts an existing cluster only when
 * pg_controldata says it was shut down cleanly, and changes nothing in it before that (VPS-40).
 */
const cleanClustersOnly = (bare: string) => {
  const branch = bare.indexOf('if [ -s "$data/PG_VERSION" ]; then');
  const read = bare.indexOf('state=$(pg_controldata "$data"');
  const check = bare.indexOf('if [ "$state" != \'shut down\' ]; then');
  const owner = bare.indexOf('chown postgres:postgres "$data"');
  return [
    ...(branch >= 0 && read > branch && check > read
      ? []
      : ['an existing cluster starts without the check that it was shut down cleanly']),
    ...(owner > check ? [] : ['the data directory changes before that check']),
  ];
};

/**
 * The bare clusters run with the image's custom directory, supautils' settings and extension
 * scripts in it, as db does: restore-db mounts nothing over it (an empty tmpfs there made the
 * monthly test restore extensions unlike a recovery), recover-db mounts db-config, and
 * bare-postgres.sh refuses a directory without supautils.conf before it makes a cluster (VPS-40).
 */
const bareSettings = (composeText: string, bare: string) => {
  const all = services(composeText);
  const over = (name: string) =>
    [...(key(all.get(name) ?? [], 'volumes') ?? []), ...(key(all.get(name) ?? [], 'tmpfs') ?? [])]
      .filter((line) => line.includes('/etc/postgresql-custom'))
      .map((line) => line.trim());
  const check = bare.indexOf('if [ ! -s "$custom/supautils.conf" ]; then');
  const made = bare.indexOf('initdb --username=supabase_admin');
  return [
    ...(over('restore-db').length ? ['restore-db hides the image’s /etc/postgresql-custom'] : []),
    ...(over('recover-db').join() === '- db-config:/etc/postgresql-custom'
      ? []
      : ['recover-db runs without db-config']),
    ...(check >= 0 && check < made ? [] : ['a bare cluster starts without supautils.conf']),
    ...(/: >"\$custom\//.test(bare) ? ['bare-postgres.sh makes empty settings files'] : []),
  ];
};

/**
 * Whoever can write to the bucket and knows the public key can plant a night, so restore.sh runs
 * nothing from one as code (review finding S1, VPS-40). The roles go to psql in its restricted
 * mode, under a random key, with the file's own \restrict and \unrestrict lines left out, so a \!
 * stops the restore; the manifest's database names must be plain before they reach SQL; nothing is
 * globbed; a night stamped later than now is never taken unasked; and a recovery refuses Storage
 * links and special files.
 */
const restoreTrust = (script: string) => {
  const key = script.indexOf(String.raw`key=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')`);
  const restrict = script.indexOf(String.raw`printf '%srestrict %s\n' "\\" "$key"`);
  const roles = script.indexOf('fetch "globals-$night.sql.age" |');
  const piped = script.indexOf('} | sql -d template1 >/dev/null; then');
  const checked = script.indexOf('for part in $reads; do get "$part"; done');
  return [
    ...(key >= 0 ? [] : ['no random key for the restricted mode']),
    ...(restrict > key && key >= 0 && restrict < roles && roles < piped
      ? []
      : ['the roles reach psql without \\restrict first']),
    ...(script.split('fetch "globals-$night.sql.age"').length === 2 &&
    script.includes('reads="globals-$night.sql.age storage-$night.tar.age"') &&
    checked >= 0 &&
    checked < roles
      ? []
      : ['the roles file is read more than once, or not checked']),
    ...(script.includes(String.raw`sed -e '/^\\restrict /d' -e '/^\\unrestrict /d'`)
      ? []
      : ['the file’s own \\restrict or \\unrestrict lines reach psql']),
    ...(code(script).includes('set -f') ? [] : ['names from a night can be globbed']),
    ...(script.includes(String.raw`$1 == "database" && NF == 2 && $2 ~ /^[a-z_][a-z0-9_]*$/`) &&
    script.includes('/[^ -~]/ {') &&
    script.includes('[ -z "$problem" ] || die')
      ? []
      : ['the manifest is not checked line by line']),
    ...(script.includes('      substr($0, 1, 16) > now {\n') &&
    script.includes('      substr($0, 1, 16) > lock && $0 > newest { newest = $0 }\n')
      ? []
      : ['a night stamped later than now can be taken unasked']),
    ...(script.includes('find /storage ! -type f ! -type d')
      ? []
      : ['a recovery keeps Storage links and special files']),
  ];
};

/**
 * restore.sh finds each database's lines of the manifest by its name as text (Stop C's re-review,
 * the scan after pitr design note 1): BusyBox's awk reads a name such as nan, inf or infinity as a
 * number, which it finds equal to no other, not even itself, so that database's counts would be
 * compared with nothing.
 */
const restoreMatched = (script: string) =>
  script.includes(
    `wanted=$(printf '%s\\n' "$manifest" | awk -v db="$db" '($1 == "table" || $1 == "migration") && $2 "" == db ""')`,
  )
    ? []
    : [
        'a database’s lines of the manifest are found by its name as awk reads it, so that nan, inf and infinity find none',
      ];

/**
 * A night is read from one folder, chosen by its age alone, from its stamp and the clock, never by
 * what the bucket holds: anyone holding the bucket's token can add objects under new names, so a
 * choice made from them can be steered (review findings RV1 and RV2, VPS-40). Younger than 29 days,
 * daily/ only, whose lock keeps the backup's own parts that long; from 29 to 365 days, monthly/
 * only, which keeps each month's copy under its lock; older, neither. The one listing is of that
 * folder, after the choice: monthly/ is never listed or read for a young night, nothing falls back
 * to the other folder, no manifest is compared across them, and a night missing from its folder is
 * refused with the rule that applied. Unasked, the newest night of daily/ younger than 29 days.
 * Every part comes from the night's folder, and the messages name it.
 */
const restoreFolder = (script: string) => {
  const unasked = script.indexOf('if [ -z "$night" ]; then');
  const daily = script.indexOf(
    `  night=$(rclone lsf --files-only --include 'seal-*.txt' "$bucket/daily/" |`,
  );
  const checked = script.indexOf('case $night in');
  const choice = script.indexOf(
    [
      'if under "$daily_lock"; then',
      '  folder=daily',
      'elif under "$monthly_lock"; then',
      '  folder=monthly',
      'else',
      '  die "the night of $night is 365 days old or more, so no folder is read for it:',
    ].join('\n'),
  );
  const listing = script.indexOf('\nnames=$(echo "seal-$night.txt" | held)\n');
  const young = script.indexOf(
    [
      'if ! listed "$names" "seal-$night.txt"; then',
      '  [ "$folder" = monthly ] ||',
      '    die "the night of $night is younger than 29 days, so only daily/ is read for it: daily/ keeps every night of the last 29 days under its lock; this one has no seal there',
    ].join('\n'),
  );
  const old = script.indexOf(
    `  die "the night of $night is 29 days old or more, so only monthly/ is read for it: only the month's copy is kept past 29 days; the backup's journal line says 'kept in monthly/' for that night, and this one has no seal there`,
  );
  const set = (name: string) =>
    code(script).filter((line) => line.trimStart().startsWith(`${name}=`)).length;
  // Every folder the script names in the bucket: the night's own, and daily/ for the unasked night.
  const named = [...script.matchAll(/"\$bucket\/([^"]*)"/g)]
    .map((match) => match[1])
    .filter((path) => !path.startsWith('$folder/'));
  return [
    ...(script.includes('daily_lock=$(date -u -d "@$((seconds - 29 * 86400))" +%Y-%m-%dT%H%MZ)') &&
    script.includes('monthly_lock=$(date -u -d "@$((seconds - 365 * 86400))" +%Y-%m-%dT%H%MZ)')
      ? []
      : ['no lines 29 and 365 days back, as the folders’ locks keep a night']),
    ...(script.includes(
      `under() { [ "$(awk -v stamp="$stamp" -v line="$1" 'BEGIN { print (stamp > line) }')" = 1 ]; }`,
    )
      ? []
      : ['a night as old as a lock still counts as under it']),
    ...(choice > checked && checked >= 0
      ? []
      : ['the folder is not chosen by the night’s age alone']),
    ...(listing > choice && choice >= 0 && set('names') === 1 && set('folder') === 2
      ? []
      : ['a folder is looked in before the age chose it, or the night falls back to the other']),
    ...(named.join() === 'daily/' && daily > unasked && unasked >= 0 && daily < checked
      ? []
      : ['a folder is read by its name, not as the night’s age chose it']),
    ...(script.includes('      substr($0, 1, 16) > lock && $0 > newest { newest = $0 }\n')
      ? []
      : ['unasked, a night 29 days old or more can be taken']),
    ...(young > listing && old > young
      ? []
      : ['a night missing from its folder is refused without the rule that applied']),
    ...(script.split('fetch "manifest-$night.txt.age"').length === 2
      ? []
      : ['the night’s manifest is read twice, as to compare it across folders']),
    ...(script.includes('"$bucket/$folder/$1" >"$parts/$1"') &&
    script.includes('"$bucket/$folder/seal-$night.txt" >"$parts/seal"')
      ? []
      : ['the parts are not read from the night’s folder']),
    ...(script.includes('is not in daily/') ? ['a message names daily/ for any night'] : []),
  ];
};

/**
 * RESTORE_STAMP is a night's id as the backup's journal line prints it, its stamp and 8 hex
 * characters, checked whole before anything reads the bucket; the night's age comes from its stamp
 * part. Unasked, only seals named as backup.sh names one count (review finding F1, VPS-43).
 */
const restoreIds = (script: string) => {
  const unasked = script.indexOf('if [ -z "$night" ]; then');
  const shape = script.indexOf(
    '  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9]Z-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;',
  );
  const stamp = script.indexOf('\nstamp=${night%-*}\n');
  const choice = script.indexOf('if under "$daily_lock"; then');
  return [
    ...(script.split('${RESTORE_STAMP-}').length === 2 && shape > unasked && unasked >= 0
      ? []
      : ['RESTORE_STAMP is not checked whole as a night’s id']),
    ...(stamp > shape && stamp < choice ? [] : ['the night’s age is not taken from its stamp']),
    ...(script.includes(
      String.raw`sed -n 's/^seal-\([0-9]\{4\}-[0-9][0-9]-[0-9][0-9]T[0-9]\{4\}Z-[0-9a-f]\{8\}\)\.txt$/\1/p'`,
    )
      ? []
      : ['unasked, a seal not named as backup.sh names one counts']),
    ...(script.includes('if ($0 != "menumesh backup " night) {')
      ? []
      : ['the manifest’s first line is not checked against the night’s id']),
  ];
};

/**
 * A restore looks for each part by its exact name and reads it by that name (rclone's
 * --no-traverse: one request each), and never holds a folder's listing: a token holder can fill a
 * folder with names, and a listing held in the shell got every restore killed in its 384m (review
 * finding F2). The seal and each part are read so (VPS-43). Unasked, the restore test's one
 * listing goes through a pipe that keeps only the newest seal's id; rclone still lists the folder,
 * which naming the night avoids.
 */
const restoreLookups = (script: string) => {
  const calls = code(script).filter((line) => /\brclone /.test(line));
  const unasked = script.indexOf(
    `  night=$(rclone lsf --files-only --include 'seal-*.txt' "$bucket/daily/" |`,
  );
  const pipe = script.slice(unasked, script.indexOf("\n      }')\n", unasked));
  return [
    ...(script.includes(
      'held() {\n  rclone lsf --files-only --no-traverse --files-from-raw - "$bucket/$folder/"\n}',
    )
      ? []
      : ['a part is looked for in a listing of its folder']),
    ...(script.includes(
      'rclone cat --no-traverse --head "$((${want#* } + 1))" "$bucket/$folder/$1" >"$parts/$1"',
    ) &&
    script.includes(
      'rclone cat --no-traverse --head "$((seal_max + 1))" "$bucket/$folder/seal-$night.txt" >"$parts/seal"',
    )
      ? []
      : ['a part is read after a listing of its folder']),
    ...(/^\s*\w+=\$\(rclone (lsf|ls|lsjson)\b[^|]*$/m.test(script)
      ? ['a folder’s listing is held in the shell']
      : []),
    ...(unasked >= 0 && !/\bsort\b/.test(pipe) && pipe.includes('$0 > newest { newest = $0 }')
      ? []
      : ['unasked, more than the newest seal’s id is kept']),
    ...(calls.length === 4
      ? []
      : [`${calls.length} rclone commands, not the 4 of lookups and reads`]),
  ];
};

/**
 * A recovery restores only the night RESTORE_STAMP names, which the RUNBOOK takes from the
 * backup's own records: the newest name in the bucket is one anyone holding its token can add, and
 * a planted night recovered would land its roles, a superuser among them, in production (review
 * finding F4). compose.yml's recover service says it is needed.
 */
const recoveryNamed = (script: string, composeText: string) => {
  const check = script.indexOf(
    '[ -n "$night" ] || [ "$mode" = --test ] ||\n  die "a recovery needs RESTORE_STAMP',
  );
  const recover =
    /\n {2}recover:\n([\s\S]*?)\n(?: {2}[a-z0-9-]+:\n|\S)/.exec(composeText)?.[1] ?? '';
  return [
    ...(check >= 0 && check < script.indexOf('if [ -z "$night" ]; then')
      ? []
      : ['a recovery can take the newest name in the bucket']),
    ...(/the newest night/.test(recover) ||
    !/restore\.sh --into refuses to run without it/.test(recover)
      ? ['compose.yml’s recover service doesn’t say the night must be named']
      : []),
  ];
};

/**
 * Everything restore.sh prints, psql's, pg_restore's, tar's, age's and rclone's lines too, goes
 * through one filter that keeps tab and newline and drops every other control character, so a
 * night's text can't move the cursor or rewrite a line (review finding N4). The script stays the
 * container's process 1 and writes into a FIFO the filter reads, so its exit status and how a
 * Ctrl-C or a signal stops it are as before (run again through a pipeline, a signal to the
 * container would have let the whole restore go on); it waits for the filter on exit. The line a
 * test ends with names the night, after anything a night's text could add.
 */
const restoreFilter = (script: string) => {
  const filter = script.indexOf(
    String.raw`LC_ALL=C tr -d '\000-\010\013-\037\177-\377' <"$fifo" &`,
  );
  const redirect = script.indexOf('exec >"$fifo" 2>&1');
  const finish = script.indexOf('  exec >&- 2>&-\n  wait "$filter" || true\n  exit "$status"\n}');
  return [
    ...(script.includes('mkfifo -m 600 "$fifo"') && filter >= 0
      ? []
      : ['no filter that drops control characters but tab and newline']),
    ...(redirect > filter && redirect < script.indexOf('mode=${1-}')
      ? []
      : ['the run’s output and errors don’t all go through the filter']),
    ...(finish > redirect && script.includes('trap finish EXIT')
      ? []
      : ['the script can end before the filter passed everything on']),
    ...(script.includes('"$0"') ? ['the script runs itself again, under another process 1'] : []),
    ...(script.includes('echo "restore test passed: the night of $night, from $folder/"')
      ? []
      : ['the test’s last line doesn’t name the night']),
  ];
};

/**
 * The roles step's failure says only that it failed, and which object of which folder it read:
 * rclone, age or psql says why above it, and only psql's "backslash commands are restricted" means
 * a planted psql command (review findings N5 and RV1, RUNBOOK).
 */
const rolesFailure = (script: string) => [
  ...(script.includes(
    'die "the roles of $night (globals-$night.sql.age in $folder/) did not restore (see above)"',
  )
    ? []
    : ['no plain message for a roles step that failed']),
  ...(/psql says why|holds SQL and no psql command/.test(script)
    ? ['the roles’ failure blames psql or a planted command whatever failed']
    : []),
];

/**
 * A part that can't be read, decrypted or restored ends the run with a line naming the object and
 * its folder, under what rclone, age, psql, pg_restore or tar said, and with the exit status the
 * failed command gave, as before (review finding RV1: a manifest planted where a restore read it
 * ended the run with age's lines alone).
 */
const partFailures = (script: string) => {
  const fetches = [...script.matchAll(/fetch "([^"]+)"/g)];
  return [
    ...(script.includes('stop() {\n  status=$?\n  echo "restore: $*" >&2\n  exit "$status"\n}')
      ? []
      : ['a failed part’s line changes the run’s exit status']),
    ...(fetches.length === 6 ? [] : [`${fetches.length} parts fetched, not 6`]),
    ...fetches.flatMap((match, n) =>
      script
        .slice(match.index, fetches[n + 1]?.index ?? script.length)
        .includes(`(${match[1]} in $folder/)`)
        ? []
        : [`a failure of ${match[1]} doesn’t name it and its folder`],
    ),
  ];
};

/**
 * Storage writes only files and folders, so the archive's members are checked, in both modes,
 * before anything is restored: a link refused after the database restore left a recovery's
 * volumes half written (review finding N6). A recovery that stops after it began to write says to
 * make all three volumes new.
 */
const storageFirst = (script: string) => {
  const listing = script.indexOf(
    'listing=$(fetch "storage-$night.tar.age" | tar --list --verbose --numeric-owner --file=- |',
  );
  const refused = script.indexOf(
    '[ "$others" -eq 0 ] ||\n  die "the Storage archive of $night holds',
  );
  const writing = script.indexOf('[ "$mode" != --into ] || writing=yes');
  const roles = script.indexOf("echo 'restore: roles'");
  return [
    ...(listing >= 0 && refused > listing && refused < roles
      ? []
      : ['the Storage archive is checked only after the databases']),
    ...(script.includes(
      '    /^-/ { files++; bytes += $3; next }\n    /^d/ { next }\n    { others++ }',
    )
      ? []
      : ['the Storage archive may hold more than files and folders']),
    ...(script.includes(`storage=$(printf '%s\\n' "$listing" | awk '$1 == "storage"')`)
      ? []
      : ['the test counts the Storage files from another read of the archive']),
    ...(writing > refused &&
    writing < roles &&
    script.includes('make db-data, db-config and storage-data new')
      ? []
      : ['a recovery that stops after it began to write doesn’t say to make the volumes new']),
  ];
};

/**
 * A restore reads a night only as its seal gives it (VPS-43). The seal is read by its exact name,
 * no further than a byte past seal_max, and taken by seal_open (seal.sh's lines and the signature
 * against BACKUP_SIGNING_PUBLIC_KEY) before any part is read; a bad one stops the run saying the
 * night is not signed by the backup's key. Each part comes through get(), which takes only a part
 * the seal lists, reads it by name no further than a byte past its size into the container's own
 * files, and holds it to the seal's size and sha256; fetch decrypts only those downloads. Every
 * part is checked before anything is restored; a test of a night whose seal lists no settings
 * archive stops before it reads one; the downloads go as the run ends.
 */
const sealFirst = (script: string) => {
  const seal = script.indexOf(
    'rclone cat --no-traverse --head "$((seal_max + 1))" "$bucket/$folder/seal-$night.txt" >"$parts/seal" ||',
  );
  const opened = script.indexOf('seal_open "$parts/seal" "$night" ||');
  const config = script.indexOf(
    '[ "$mode" != --test ] || [ -n "$(seal_part "config-$night.tar.age")" ] ||',
  );
  const firstRead = script.indexOf('\nget "manifest-$night.txt.age"\n');
  const reads = script.indexOf('for part in $reads; do get "$part"; done');
  const writing = script.indexOf('[ "$mode" != --into ] || writing=yes');
  const roles = script.indexOf("echo 'restore: roles'");
  const start = script.indexOf('get() {');
  const get = script.slice(start, script.indexOf('\n}\n', start));
  return [
    ...(seal >= 0 && opened > seal && firstRead > opened
      ? []
      : ['a part is read before the night’s seal checked out']),
    ...(script.includes(
      `die "the night of $night is not signed by the backup's key: its seal (seal-$night.txt in $folder/) $seal_problem, so someone else wrote to the bucket, and nothing of the night was read"`,
    )
      ? []
      : ['a bad seal doesn’t stop the run saying the night is not the backup’s']),
    ...(get.includes('want=$(seal_part "$1")') && get.includes('[ -n "$want" ] || die')
      ? []
      : ['a part the seal doesn’t list can be read']),
    ...(get.includes(`[ "$got" -eq "\${want#* }" ] ||`) &&
    get.includes(`[ "$(sha256sum "$parts/$1" | cut -d ' ' -f 1)" = "\${want% *}" ] ||`)
      ? []
      : ['a part is not held to the size and sha256 its seal gives']),
    ...(script.includes(
      'fetch() {\n  age --decrypt --identity "$AGE_IDENTITY_FILE" <"$parts/$1"\n}',
    )
      ? []
      : ['a part is decrypted from anything but its checked download']),
    ...(reads > firstRead && writing > reads && roles > writing
      ? []
      : ['a part is checked only once something was restored']),
    ...(config > opened && config < firstRead
      ? []
      : ['a test reads a night whose seal lists no settings archive']),
    ...(script.includes('  [ -z "$parts" ] || rm -rf "$parts"\n  exec >&- 2>&-')
      ? []
      : ['the downloads stay when the run ends']),
  ];
};

/**
 * The nightly base backup (VPS-43): pg_basebackup's tar of the whole cluster to stdout, with the
 * WAL it needs to be consistent alone (-X fetch), under a 2-hour bound, through zstd -3 and put.
 * A base that fails stops none of the other parts (it runs as an if's test, after the manifest),
 * the night fails at the end, and its seal says "base none"; its name and the seal's are looked
 * for before the first upload with the night's others.
 */
const baseRules = (script: string) => {
  const manifest = script.indexOf(`printf '%s\\n' "$manifest" | put "manifest-$night.txt.age"`);
  const run = script.indexOf(
    '\nif base; then\n  expected="$expected base-$night.tar.zst.age:1024"\n',
  );
  return [
    ...(script.includes(
      'timeout 7200 pg_basebackup --pgdata=- --format=tar --wal-method=fetch --checkpoint=spread \\\n',
    ) && script.includes('    zstd -3 -q -c | put "base-$night.tar.zst.age"; then')
      ? []
      : ['the base is not pg_basebackup’s tar with its WAL, bounded, through zstd and put']),
    ...(run > manifest && manifest >= 0 ? [] : ['a base that fails can stop the other parts']),
    ...(script.includes("base_line='base none'") &&
    script.includes(
      '  base_line="base $(date -u -d "@$((ended + 1))" +%Y-%m-%dT%H:%M:%SZ) $walfile $cluster"',
    )
      ? []
      : ['the seal’s base line is not its end, start walfile and cluster, or "base none"']),
    ...(script.includes(
      '[ -z "$base_problem" ] || problems="${problems:+$problems; }$base_problem"',
    ) && script.includes('[ -z "$problems" ] || fail "$problems"')
      ? []
      : ['a base that failed doesn’t fail the night']),
    ...(script.includes(
      '"base-$night.tar.zst.age:1024" "config-$night.tar.age:1024" "seal-$night.txt:0"',
    )
      ? []
      : ['the base’s or the seal’s name is not looked for before the first upload']),
  ];
};

/**
 * The base's WAL is held until the base ends (VPS-43): pg_basebackup -X fetch reads the WAL last,
 * and db removes a file at its first checkpoint after archiving it, so a temporary physical slot
 * keeps it. A psql session of its own makes the slot, reading a FIFO this shell holds on fd 9 and
 * started before the shell opens it (else the session would hold its own input and never end);
 * the slot is seen in pg_replication_slots before pg_basebackup starts; and base() closes fd 9,
 * which ends the session and the slot with it, whatever take_base did.
 */
const baseSlot = (script: string) => {
  const start = script.indexOf('hold_wal() {');
  const hold = script.slice(start, script.indexOf('\n}\n', start));
  const session = hold.indexOf('<"$work/slot.fifo"');
  const opened = hold.indexOf('  exec 9<>"$work/slot.fifo"\n');
  const held = script.indexOf('  if ! hold_wal; then\n');
  const taken = script.indexOf('  if ! { timeout 7200 pg_basebackup');
  return [
    ...(start >= 0 &&
    hold.includes(
      `printf "select pg_create_physical_replication_slot('%s', true, true);\\n" "$slot" >&9`,
    ) &&
    hold.includes('  slot=menumesh_base_$hex\n')
      ? []
      : ['the base’s WAL is not kept by a temporary slot of the night']),
    ...(session >= 0 && opened > session
      ? []
      : ['the slot’s session holds its own input open, so it never ends']),
    ...(hold.includes("where slot_name = '$slot' and temporary and restart_lsn is not null")
      ? []
      : ['the slot is not seen in db before the base']),
    ...(held >= 0 && taken > held ? [] : ['the base starts before its WAL is held']),
    ...(script.includes('base() {\n  taken=0\n  take_base || taken=1\n  release_wal\n') &&
    script.includes('release_wal() {\n  exec 9>&-\n')
      ? []
      : ['the slot outlives the base']),
  ];
};

/**
 * Each night's seal (VPS-43): the signing pair checked with a signed probe before anything goes
 * up; each part's sha256 and size taken as it streams, from FIFOs tee feeds, which this shell holds
 * open while the readers start and the readers never hold; each part held in the bucket to the size
 * that went up; then, after that check, the seal of the night's id, its base line and each part,
 * signed, taken by seal_open as a restore takes it, and uploaded by its name.
 */
const sealWrite = (script: string) => {
  const probe = script.indexOf('seal_self_check ||');
  const firstPut = script.indexOf('pg_dumpall --globals-only | put');
  const uploads = script.indexOf("reason='the check of the uploads'");
  const body = script.indexOf(`printf 'menumesh seal 1 %s\\n%s\\n' "$night" "$base_line"`);
  const signed = script.indexOf('signature=$(seal_sign "$work/seal.body")');
  const opened = script.indexOf('seal_open "$work/seal" "$night" ||');
  const sent = script.indexOf('rclone copyto --no-check-dest "$work/seal" "$day/seal-$night.txt"');
  return [
    ...(probe >= 0 && probe < firstPut
      ? []
      : ['the signing pair is not checked before the first upload']),
    ...(script.includes('  exec 7<>"$work/sum.fifo" 8<>"$work/size.fifo"\n') &&
    script.includes('  sha256sum <"$work/sum.fifo" >"$work/sum" 7>&- 8>&- &\n') &&
    script.includes('  wc -c <"$work/size.fifo" >"$work/size" 7>&- 8>&- &\n') &&
    script.includes('tee "$work/sum.fifo" "$work/size.fifo" |') &&
    script.includes('  exec 7>&- 8>&-\n')
      ? []
      : ['a part’s sha256 and size are not taken as it streams']),
    ...(script.includes('[ "$size" -eq "$sent" ] || fail')
      ? []
      : ['a part in the bucket is not held to the size that went up']),
    ...(body > uploads && signed > body && opened > signed && sent > opened
      ? []
      : ['the seal is not written, signed and checked after the check of the uploads']),
    ...(script.includes(`    printf 'part %s %s %s\\n' "$sum" "$sent" "$name"`) &&
    script.includes(`  printf 'signature %s\\n' "$signature"`)
      ? []
      : ['the seal does not list each part and end in its signature']),
  ];
};

/**
 * seal.sh's seal_open (VPS-43), which the restores and the month's copy trust: no more than
 * seal_max bytes, which is the harness's SEAL_MAX; only printable ASCII and newlines, and a last
 * newline; the night's own header and no part twice; and the signature of every byte before its
 * line, checked against each key of BACKUP_SIGNING_PUBLIC_KEY.
 */
const sealGrammar = (lib: string) => [
  ...(lib.includes(`\nseal_max=${SEAL_MAX}\n`) ? [] : ['seal_max is not the harness’s SEAL_MAX']),
  ...(lib.includes('  if [ "$seal_size" -gt "$seal_max" ]; then\n')
    ? []
    : ['a seal of any size is read']),
  ...(lib.includes(`[ "$(LC_ALL=C tr -d '\\n -~' <"$1" | wc -c)" -ne 0 ]`) &&
  lib.includes(`[ "$(tail -c 1 "$1" | od -An -tx1 | tr -d ' \\n')" != 0a ]`)
    ? []
    : ['a seal may hold bytes past printable ASCII, or lack its last newline']),
  ...(lib.includes('if (line[1] != "menumesh seal 1 " night) {') &&
  lib.includes('if (seen[f[4]]++) { print "problem lists a part twice"; exit }')
    ? []
    : ['a seal of another night, or with a part twice, is taken']),
  ...(lib.includes(
    `  if sed '$d' "$1" >"$seal_open_dir/body" &&\n    seal_verify "$seal_open_dir/body"`,
  )
    ? []
    : ['the signature is not checked over every line before it, against each key']),
];

const walShipSh = kit('backup/wal-ship.sh');
const sealSh = kit('backup/seal.sh');
const walSpoolSh = kit('config/db/wal-spool.sh');

/** What backup.sh, wal-ship.sh and the restores say of a list, or a private key, that is no key. */
const LIST_SHAPE =
  'BACKUP_SIGNING_PUBLIC_KEY is not one Ed25519 public key or several, as pnpm vps:secrets writes it (base64 SPKI DER, separated by single spaces)';
const KEY_SHAPE =
  'BACKUP_SIGNING_KEY is not an Ed25519 private key, as pnpm vps:secrets writes it (base64 PKCS #8 DER)';

/**
 * The signing pair's check (SIGNING_PAIR_CHECK, Stop C's re-review, finding V2) holds the list to
 * its shape, then the private key, each refused in a line of its own that names it as the
 * restores do, before the self-check's two lines: a list that is no list of keys checks no probe,
 * and was blamed on the private key (finding U4).
 */
const pairCheckShape = (check: string) => {
  const shape =
    /^\. \/usr\/local\/share\/menumesh\/seal\.sh; seal_public_keys_ok \|\| \{ echo "([^"]+)" >&2; exit 1; \}; seal_private_key_ok \|\| \{ echo "([^"]+)" >&2; exit 1; \}; if seal_self_check; then echo "signing pair: [^"]+"; else echo "signing pair: [^"]+" >&2; exit 1; fi$/.exec(
      check,
    );
  return [
    ...(shape?.[1].startsWith(`signing pair: ${LIST_SHAPE}: `)
      ? []
      : ['a list that is no list of keys is not named, before the private key and the self-check']),
    ...(shape?.[2].startsWith(`signing pair: ${KEY_SHAPE}: `)
      ? []
      : ['a private key that is no key is not named, before the self-check']),
  ];
};

/**
 * backup.sh and wal-ship.sh hold the signing values to their shapes before their self-checks,
 * the list first, each refused in a line of its own that names it as the restores do, before
 * anything goes up: a list that is no list of keys checks no probe, and was blamed on the private
 * key (Stop C's re-review, finding U4).
 */
const signingShapes = (backup: string, walShip: string) => {
  const ordered = (
    script: string,
    name: string,
    list: string,
    key: string,
    self: string,
    upload: string,
  ) => {
    const [l, k, s, u] = [list, key, self, upload].map((text) => script.indexOf(text));
    return [
      ...(l >= 0 && s > l && u > s
        ? []
        : [
            `${name} doesn’t name BACKUP_SIGNING_PUBLIC_KEY when it is no list of keys, before its self-check`,
          ]),
      ...(k > l && s > k
        ? []
        : [
            `${name} doesn’t name BACKUP_SIGNING_KEY when it is no key, after the list and before its self-check`,
          ]),
    ];
  };
  return [
    ...ordered(
      backup,
      'backup.sh',
      `seal_public_keys_ok ||\n  fail "${LIST_SHAPE}, so no night could be sealed: nothing was uploaded"\n`,
      `seal_private_key_ok ||\n  fail "${KEY_SHAPE}, so no night could be sealed: nothing was uploaded"\n`,
      'seal_self_check ||\n  fail "BACKUP_SIGNING_KEY does not sign',
      'pg_dumpall --globals-only | put',
    ),
    ...ordered(
      walShip,
      'wal-ship.sh',
      `  if ! seal_public_keys_ok; then\n    halted "${LIST_SHAPE}: nothing was uploaded"\n`,
      `  elif ! seal_private_key_ok; then\n    halted "${KEY_SHAPE}: nothing was uploaded"\n`,
      '  elif ! seal_self_check 2>"$work/tool"; then\n    halted "BACKUP_SIGNING_KEY does not sign',
      'rclone copyto --checksum',
    ),
  ];
};

/**
 * The image runs wal-ship.sh every minute as db's postgres (uid 100, gid 101), who owns the spool,
 * through gosu, which drops root's two capabilities with it; openssl signs; the signing helpers
 * are a file the scripts source, not a command (VPS-43).
 */
const walShipImage = (dockerfile: string) => [
  ...(dockerfile.includes(
    "printf '30 20 * * * /usr/local/bin/backup.sh\\n* * * * * gosu 100:101 /usr/local/bin/wal-ship.sh\\n' >/etc/crontabs/root",
  )
    ? []
    : ['the crontab does not run wal-ship.sh every minute as 100:101']),
  ...(dockerfile.includes('RUN apk add --no-cache age curl openssl rclone tar')
    ? []
    : ['the image has no openssl']),
  ...(dockerfile.includes(
    'COPY --chmod=755 backup.sh restore.sh notify.sh wal-ship.sh pitr.sh wal-fetch.sh /usr/local/bin/',
  )
    ? []
    : ['wal-ship.sh, pitr.sh or wal-fetch.sh is not a command of the image']),
  ...(dockerfile.includes('COPY --chmod=644 counts.sql seal.sh /usr/local/share/menumesh/')
    ? []
    : ['seal.sh is not where the scripts source it']),
];

/**
 * wal-ship.sh (VPS-43): one run at a time; only the names basic_archive writes, never globbed; a
 * raw file goes only once its encrypted copy is synced and renamed into the outbox; each name
 * signs the cluster, the WAL file and the ciphertext's sha256, under the cluster db names and each
 * segment's header confirms; one upload by its exact name, which writes nothing when the same bytes
 * are there, and nothing else in the bucket; the alert after 10 minutes, or at once for what no
 * wait mends (another cluster, a signing key that is not the public key's pair), at most hourly;
 * the heartbeat every 5 minutes, to HEARTBEAT_WAL_URL.
 */
const walShipper = (script: string) => {
  const outboxed = script.indexOf('mv -f "$tmp" "$dest" && fsync "$out"');
  const removed = script.indexOf('    rm -f "$src"\n  done');
  const rclone = code(script).filter((line) => /(?:^|[\s;|&(!])rclone\s+[a-z]/.test(line));
  return [
    ...(script.includes('flock -n 9 || exit 0') ? [] : ['two runs can ship at once']),
    ...(/^set -f$/m.test(script) ? [] : ['names from the spool can be globbed']),
    ...(script.includes(
      String.raw`WAL='([0-9A-F]{24}(\.partial|\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)'`,
    )
      ? []
      : ['the WAL names are not basic_archive’s']),
    ...(outboxed >= 0 && removed > outboxed
      ? []
      : ['a raw WAL file goes before its outbox copy is safe']),
    ...(script.includes(
      `printf 'menumesh wal 1 %s %s %s\\n' "$id" "$walfile" "$sum" >"$work/message"`,
    )
      ? []
      : ['the signed message is not "menumesh wal 1 <cluster> <walfile> <sha256>"']),
    ...(script.includes('"backups:$BACKUP_BUCKET/wal/$id/$folder/$walfile.$signature.zst.age"')
      ? []
      : ['the object is not wal/<cluster>/<folder>/<walfile>.<signature>.zst.age']),
    ...(rclone.length === 1 && rclone[0].includes('rclone copyto --checksum --no-traverse ')
      ? []
      : ['the shipper does more in the bucket than one copyto --checksum by name']),
    ...(script.includes('from pg_control_system() c, pg_stat_archiver a')
      ? []
      : ['the cluster does not come from pg_control_system()']),
    ...(script.includes('sysid=$(od -An -tu8 -j24 -N8 "$src"')
      ? []
      : ['a segment’s header is not checked against the cluster']),
    ...(script.includes('[ $((now - since)) -le 600 ]') &&
    script.includes('[ $((now - last)) -ge 3600 ]')
      ? []
      : ['the alert is not after 10 minutes, at most hourly']),
    ...(script.includes(
      'if [ -n "$behind" ] || [ -n "$stuck" ] || [ -n "$idle" ] || [ -n "$urgent" ]; then',
    ) &&
    [
      `halted "db's system identifier is now $current`,
      'halted "the WAL file $name names the cluster',
      `halted "BACKUP_SIGNING_KEY does not sign`,
    ].every((line) => script.includes(line))
      ? []
      : ['another cluster or a wrong signing key does not alert at once']),
    ...(script.includes('[ $((now - last)) -ge 290 ]') &&
    script.includes('HEARTBEAT_URL=${HEARTBEAT_WAL_URL-} notify.sh beat')
      ? []
      : ['the heartbeat is not every 5 minutes to HEARTBEAT_WAL_URL']),
  ];
};

/**
 * wal-ship.sh's record (alert-sent, alerting, archiver-failing, beat, last-sent) is written through
 * note(), which keeps a value in /tmp/wal-ship, the service's tmpfs, when the spool's disk takes no
 * more, and read through noted(), the later of both places: so a full disk neither stops the run
 * under set -e before its alert nor lets the alert go out every minute (Stop C's review, finding
 * C3). No other write into the record, but the cluster's identifier (kept, or nothing ships), the
 * lock and note()'s own; no removal there but unnote()'s; and no ':' with a redirection, whose
 * failure ends BusyBox ash even within braces.
 */
const RECORD_WRITES = [
  `{ printf '%s\\n' "$2" >"$book/$1"; } 2>/dev/null && return 0`,
  `{ mkdir -p "$spare" && printf '%s\\n' "$2" >"$spare/$1"; } 2>/dev/null || true`,
  `elif { printf '%s\\n' "$current" >"$state/system-identifier.new" &&`,
  'exec 9>>"$book/lock"',
];
const shipperRecord = (script: string) => {
  const lines = code(script).map((line) => line.trim());
  return [
    ...lines
      .filter((line) => />"\$(book|spare|state)\//.test(line) && !RECORD_WRITES.includes(line))
      .map((line) => `a write into the record can stop the run before its alert: ${line}`),
    ...lines
      .filter((line) => /(^|[;&|{(]\s*):\s*>/.test(line))
      .map((line) => `':' with a redirection, whose failure ends ash: ${line}`),
    ...lines
      .filter(
        (line) =>
          /\brm -f\b.*"\$(book|spare)\//.test(line) &&
          line !== 'unnote() { rm -f "$book/$1" "$spare/$1" 2>/dev/null || true; }',
      )
      .map((line) => `a removal from the record can stop the run before its alert: ${line}`),
    ...(['alert-sent', 'beat', 'archiver-failing'].every(
      (name) => script.includes(`=$(noted ${name})`) && !script.includes(`$(kept "$book/${name}")`),
    ) && script.includes(`  printf '%s\\n%s\\n' "$(kept "$book/$1")" "$(kept "$spare/$1")" |`)
      ? []
      : ['the record is not read from both the spool and /tmp']),
  ];
};

/**
 * seal.sh (VPS-43): the private key reaches openssl as PEM text on file descriptor 3, from a
 * here-document (a pipe in BusyBox ash), never in an argument or a file, and leaves the
 * environment of every program the sourcing script runs; a signature counts only in its one
 * spelling; no tr set starts with "-", which tr would take for an option.
 */
const SEAL_KEY_USES = [
  'if [ -n "${BACKUP_SIGNING_KEY+set}" ]; then',
  'seal_key=$BACKUP_SIGNING_KEY',
  'case ${BACKUP_SIGNING_KEY-} in',
  'MC4CAQAwBQYDK2VwBCIEI*) [ "${#BACKUP_SIGNING_KEY}" -eq 64 ] ;;',
  '$BACKUP_SIGNING_KEY',
];
const sealRules = (lib: string) => {
  const uses = code(lib)
    .map((line) => line.trim())
    .filter((line) => /\$\{?#?BACKUP_SIGNING_KEY\b/.test(line));
  const sets = [...lib.matchAll(/\btr (?:-d )?'([^']*)'(?: '([^']*)')?/g)].flatMap((match) =>
    match.slice(1).filter((set) => set !== undefined),
  );
  return [
    ...(lib.includes(
      'openssl pkeyutl -sign -rawin -inkey /dev/fd/3 -in "$1" -out "$seal_sign_dir/signature" 3<<EOF; then\n-----BEGIN PRIVATE KEY-----\n$BACKUP_SIGNING_KEY\n-----END PRIVATE KEY-----\nEOF\n',
    )
      ? []
      : ['the private key does not reach openssl on file descriptor 3']),
    ...uses
      .filter((line) => !SEAL_KEY_USES.includes(line))
      .map((line) => `the private key is used in: ${line}`),
    ...(lib.includes('  unset BACKUP_SIGNING_KEY\n  BACKUP_SIGNING_KEY=$seal_key\n') &&
    !/\bexport\b/.test(code(lib).join('\n'))
      ? []
      : ['the private key stays in the environment of the programs the script runs']),
    ...(lib.includes('openssl pkeyutl -verify -rawin -pubin -inkey /dev/fd/3 -in "$2"')
      ? []
      : ['a public key does not reach openssl on file descriptor 3']),
    ...(lib.includes('[ "$(seal_b64url <"$seal_check_dir/signature")" = "$1" ]')
      ? []
      : ['a signature counts in more than its one spelling']),
    ...(sets.length >= 4 && sets.every((set) => !set.startsWith('-'))
      ? []
      : [`a tr set starts with "-": ${sets.join(' ')}`]),
  ];
};

/**
 * wal-spool.sh, db's entrypoint (VPS-43): as root, it stops when the volume is not mounted, makes
 * /wal-spool postgres's and 0700 (Docker makes a volume root's and 0755), and ends in the image's
 * own entrypoint with db's command, which fixes the data directory's owner and drops to postgres
 * as before.
 */
const walSpoolWrapper = (script: string) => {
  const lines = code(script).map((line) => line.trim());
  return [
    ...(lines.includes('spool=/wal-spool') && lines.includes('if [ ! -d "$spool" ]; then')
      ? []
      : ['a missing wal-spool mount is not refused']),
    ...(lines.includes('chown postgres:postgres "$spool"') && lines.includes('chmod 0700 "$spool"')
      ? []
      : ['the spool is not postgres’s and 0700']),
    ...(lines.at(-1) === 'exec docker-entrypoint.sh "$@"'
      ? []
      : ['it does not end in the image’s entrypoint with db’s command']),
  ];
};

const pitrSh = kit('backup/pitr.sh');
const walFetchSh = kit('backup/wal-fetch.sh');

/**
 * Each script's settings, its `for name in ...` list, are in the environment of every service that
 * runs it (VPS-40, VPS-43): restore.sh's in restore-test and recover, pitr.sh's in pitr-test and
 * recover-pitr, backup.sh's and wal-ship.sh's in backup.
 */
const SCRIPT_SERVICES: [string, string, string[]][] = [
  ['restore.sh', restoreSh, ['restore-test', 'recover']],
  ['pitr.sh', pitrSh, ['pitr-test', 'recover-pitr']],
  ['backup.sh', backupSh, ['backup']],
  ['wal-ship.sh', walShipSh, ['backup']],
];
const scriptEnv = (text: string, scripts = SCRIPT_SERVICES) =>
  scripts.flatMap(([file, script, runners]) => {
    const names = /^for name in ([A-Z0-9_ ]+); do$/m.exec(script)?.[1].split(' ') ?? [];
    if (!names.length) return [`${file} names no setting it needs`];
    return runners.flatMap((runner) => {
      const given = (key(services(text).get(runner) ?? [], 'environment') ?? []).map(
        (line) => /^ {6}([A-Z0-9_]+):/.exec(line)?.[1],
      );
      return names
        .filter((name) => !given.includes(name))
        .map((name) => `${runner} does not set ${name}, which ${file} needs`);
    });
  });

/**
 * pitr.sh's check of the base's timeline (Stop C's re-review, finding M1): the last WAL file of the
 * base's own timeline among those it brought along, from its first on, and the next timeline in
 * the replay's history held to begin past it.
 */
const BASE_CHECK = [
  `base_last=$(LC_ALL=C awk -v tli="$tli" -v first="$first" '`,
  '  BEGIN { last = first }',
  '  substr($0, 1, 8) == tli && substr($0, 9, 16) "" > last "" { last = substr($0, 9, 16) }',
  `  END { print last }' "$work/base-wal")`,
  `problem=$(LC_ALL=C awk -v tli="$tli" -v first="$first" -v last="$base_last" '`,
  '  $1 "" == tli "" { on = NR; next }',
  '  on && NR == on + 1 && $2 "" <= last "" { left = $2 }',
  '  END {',
  '    if (!on) print "is not one of them"',
  '    else if (left != "" && left "" < first "") print "was left for a later one at " left ", before the base began"',
  '    else if (left != "") print "was left for a later one at " left ", before the base ended"',
  `  }' "$work/lineage")`,
].join('\n');
/** The check as it was before finding M1: the next timeline's begin held to the base's first WAL file alone. */
const TODAYS_BASE_CHECK = [
  `problem=$(LC_ALL=C awk -v tli="$tli" -v first="$first" '`,
  '  $1 == tli { on = NR; next }',
  '  on && NR == on + 1 && $2 "" < first "" { left = $2 }',
  `  END { if (!on) print "is not one of them"; else if (left != "") print "was left for a later one at " left ", before the base began" }' "$work/lineage")`,
].join('\n');
/**
 * The base's timeline found in the lineage as text (Stop C's re-review, pitr design note 1): awk
 * reads a field such as 000000E1 as a number, 0 in its exponent notation, as it reads 000000E2.
 */
const TIMELINE_MATCHED = '  $1 "" == tli "" { on = NR; next }\n';
/** The refusal of the base, which nothing written to db-data may precede. */
const BASE_REFUSED =
  '  die "the base backup of $night is of the timeline $tli, from $start, which $problem:';
/**
 * What a recovery to a point that a cut chain stops short of is told to do instead (Stop C's
 * re-reviews, finding T1): latest, which starts from the newest night, whose base can lie past the
 * cut, and where it meets the cut goes on to it only with PITR_ACCEPT_CUT; the drill, which never
 * reads PITR_ACCEPT_CUT, is not told of it.
 */
const CUT_ADVICE =
  'instead="or to latest; if that recovery is cut at $gap too, it ends there only with PITR_ACCEPT_CUT=$gap"';
const CUT_INSTEAD = [
  '      short="the chain of WAL files is cut at $gap"',
  '      [ "$mode" = --test ] ||',
  `        ${CUT_ADVICE}`,
  '',
].join('\n');
/** The advice as it was before finding T1: true only when latest starts from the point's night. */
const TODAYS_CUT_INSTEAD = [
  '      short="the chain of WAL files is cut at $gap"',
  '      instead="or to latest with PITR_ACCEPT_CUT=$gap, which ends at the cut (without it, a recovery to latest is refused while the chain is cut there)"',
  '',
].join('\n');

/**
 * pitr.sh (VPS-43): everything it prints through the filter restore.sh has; a recovery only to a
 * point it is given, and no point more than 14 days back; the night's base read only once its seal
 * checks out, and held to the seal's size and sha256; the WAL's upload time the bucket's own, never
 * the time its uploader set; a WAL file kept only when the signature in its name is the backup's,
 * over the cluster, the WAL file and the sha256 of those bytes; the replay with none of the
 * script's environment, nothing preloaded, no event trigger and no hot standby, promoted at its end,
 * fed by wal-fetch.sh; a recovery's new timeline kept for db to archive, the drill's never; the
 * copy of the age key gone before anything reads the cluster, in sessions that write nothing.
 * None of the live cluster's own settings reach the replay: the base's postgresql.auto.conf, what
 * ALTER SYSTEM set there, waits aside while it runs and goes back for db after a recovery, and the
 * command line names the port and turns off every command a setting could run (review finding
 * S1). Each position of the chain takes the WAL file of the timeline the replay reads there, from
 * the newest timeline whose history file is here, never another timeline's at the same position,
 * and a replay to latest must end at the chain's last WAL file from the bucket (review finding
 * C2). A recovery to latest with a cut chain is refused before anything is written to db-data,
 * unless PITR_ACCEPT_CUT names the WAL file it is cut at (review finding D6). A base whose timeline
 * the replay leaves for the next before the last WAL file the base brought along is refused before
 * anything is written: Postgres could read on along the abandoned timeline from those files
 * (Stop C’s re-review, finding M1). A recovery to a point that a cut chain stops short of is told
 * that a recovery to latest, should it be cut there too, ends there only with PITR_ACCEPT_CUT; the
 * drill, which never reads it, is not told of it (finding T1). The base's timeline is found in the
 * lineage as text, as positions are compared, never as the number awk would read.
 */
const REPLAY_FLAGS = [
  '-c shared_preload_libraries= ',
  '-c session_preload_libraries= ',
  '-c local_preload_libraries= ',
  '-c event_triggers=off ',
  '-c hot_standby=off ',
  '-c listen_addresses= ',
  '-c port=5432 ',
  '-c ssl=off ',
  '-c "restore_command=/usr/local/bin/wal-fetch.sh $wal $key %f %p" ',
  '-c recovery_end_command= ',
  '-c archive_cleanup_command= ',
  '-c recovery_target_action=promote',
];
const pitrRules = (script: string) => {
  const sealed = script.indexOf('if ! seal_open "$work/seal" "$candidate"; then');
  const base = script.indexOf('get "base-$night.tar.zst.age"');
  const forgotten = script.indexOf('\nforget_key\n');
  const counted = script.indexOf('dbs=$(ro -d postgres');
  const unpacked = script.indexOf('gosu postgres tar --extract --file=- --directory="$data"');
  const aside = script.indexOf('  gosu postgres mv -f "$auto" "$auto.pitr" ||');
  const emptied = script.indexOf('gosu postgres touch "$auto" ||');
  const replaying = script.indexOf('echo "pitr: replaying"');
  const stopped = script.indexOf("quit || die 'the recovered cluster did not stop cleanly");
  const putBack = script.indexOf('    gosu postgres mv -f "$auto.pitr" "$auto" ||');
  const done = script.indexOf('echo "point-in-time recovery to $said_point done');
  const orphaned = script.indexOf('[ -z "$orphans" ] ||');
  const cutRefused = script.indexOf('die "a recovery to latest would end at the cut at $gap');
  const writes = script.indexOf('[ "$mode" != --into ] || writing=yes');
  const shortOfEnd = script.indexOf('  if [ "$restored" != "$from_bucket" ]; then');
  const baseRefused = script.indexOf(BASE_REFUSED);
  // The end-of-WAL refusal's branch for a cut: what follows its short reason.
  const cutBranch =
    /\n {6}short="the chain of WAL files is cut at \$gap"\n([\s\S]*?)\n {4}elif /.exec(
      script,
    )?.[1] ?? '';
  return [
    ...(script.includes(String.raw`LC_ALL=C tr -d '\000-\010\013-\037\177-\377' <"$fifo" &`) &&
    script.indexOf('exec >"$fifo" 2>&1') < script.indexOf('mode=${1-}') &&
    script.includes('  exec >&- 2>&-\n  wait "$filter" || true\n  exit "$status"\n}') &&
    script.includes('trap finish EXIT')
      ? []
      : ['what the run prints does not all go through the filter']),
    ...(script.includes('  [ "$mode" = --test ] ||\n    die "a recovery needs PITR_TARGET')
      ? []
      : ['a recovery runs without PITR_TARGET']),
    ...(script.includes('  [ "$point" -ge $((seconds - 14 * 86400)) ] ||')
      ? []
      : ['a point more than 14 days back is taken']),
    ...(sealed >= 0 && base > sealed && script.includes('  want=$(seal_part "$1")\n')
      ? []
      : ['the base is read before a seal checks out']),
    ...(script.includes('  [ "$(sha256sum "$work/$1" | cut -d \' \' -f 1)" = "${want% *}" ] ||') &&
    script.includes('  [ "$got" -eq "${want#* }" ] ||')
      ? []
      : ['a part is not held to its seal']),
    ...(script.includes(
      'rclone lsjson --files-only --no-mimetype --use-server-modtime "$bucket/wal/$cluster/$1/"',
    )
      ? []
      : ['a WAL file’s upload time is not the bucket’s own']),
    ...(script.includes(
      String.raw`printf 'menumesh wal 1 %s %s %s\n' "$cluster" "$2" "$(sha256sum "$work/object" | cut -d ' ' -f 1)"`,
    ) && script.includes('    if seal_verify "$work/message" "$3"; then')
      ? []
      : ['a WAL file is kept without the backup’s signature of its bytes']),
    ...(script.includes(
      'env -i PATH=/usr/local/bin:/usr/bin:/bin LC_ALL=C gosu postgres postgres "$@" </dev/null',
    )
      ? []
      : ['the replay gets the script’s environment']),
    ...REPLAY_FLAGS.filter((flag) => !script.includes(`  ${flag}`)).map(
      (flag) => `the replay runs without ${flag.trim()}`,
    ),
    ...(script.includes('set -- "$@" -c archive_mode=on -c archive_command= -c archive_library=') &&
    script.includes('set -- "$@" -c archive_mode=off -c fsync=off')
      ? []
      : ['a recovery’s new timeline is not kept for db to archive, or the drill keeps its own']),
    ...(forgotten >= 0 && counted > forgotten
      ? []
      : ['the copy of the age key is there while the cluster is read']),
    ...(script.includes("PGOPTIONS='-c default_transaction_read_only=on")
      ? []
      : ['the replayed cluster is read in sessions that can write']),
    ...(script.includes('[ -z "$orphans" ] ||\n  die "the backup\'s WAL of the timelines') &&
    orphaned < replaying
      ? []
      : ['a later timeline’s WAL is replayed without its history file']),
    ...(code(script).includes('set -f') ? [] : ['names from the bucket can be globbed']),
    ...(script.includes('auto=$data/postgresql.auto.conf\n') &&
    unpacked >= 0 &&
    aside > unpacked &&
    emptied > aside &&
    replaying > emptied
      ? []
      : [
          'the replay reads the base’s own postgresql.auto.conf, what ALTER SYSTEM set on the live cluster',
        ]),
    ...(stopped >= 0 && putBack > stopped && done > putBack
      ? []
      : ['a recovery does not put the base’s postgresql.auto.conf back once the cluster stopped']),
    ...(script.includes(
      String.raw`while next=$(printf '%08X' $((0x$newest + 1))) && grep -qx "$next" "$work/histories"; do`,
    ) &&
    script.includes(
      '      if (tl "" > newest "") { print position, time, past, size, walfile, part[2] >later; next }',
    ) &&
    script.includes(
      '      if (tl "" == reads "") print position, time, past, size, walfile, part[2]',
    )
      ? []
      : ['a position takes a WAL file of another timeline than the one the replay reads there']),
    ...(script.includes('    if grep -qx "$want$at" "$work/base-wal"; then') &&
    script.includes('  gap=$want$at\n')
      ? []
      : [
          'a WAL file the base brought fills a position of another timeline, or a gap is named on another',
        ]),
    ...(script.includes(
      '  while read -r _ _ _ _ walfile signature; do\n    if take "$folder" "$walfile" "$signature" "$cap" </dev/null; then\n      cut=$walfile\n',
    )
      ? []
      : ['the look past a gap gives up before it has tried every object named there']),
    ...(shortOfEnd > replaying && shortOfEnd < counted && shortOfEnd < done
      ? []
      : ['a replay to latest that stopped short of the chain’s last WAL file passes']),
    ...(script.includes('  accept=${PITR_ACCEPT_CUT-}\n') &&
    script.includes('    [ "$accept" = "$gap" ] ||\n') &&
    orphaned >= 0 &&
    cutRefused > orphaned &&
    writes > cutRefused &&
    unpacked > writes
      ? []
      : [
          'a recovery to latest goes past a cut chain of WAL files, or writes to db-data before it is refused',
        ]),
    ...(script.includes(
      `  [ -z "$cut" ] || die "the chain of WAL files is cut at $gap, with the backup's WAL after it: the drill fails"`,
    )
      ? []
      : ['the drill passes with the chain of WAL files cut']),
    ...(script.includes(`${BASE_CHECK}\n[ -z "$problem" ] ||\n${BASE_REFUSED}`) &&
    baseRefused >= 0 &&
    writes > baseRefused &&
    unpacked > baseRefused
      ? []
      : [
          'a base is taken whose timeline the replay leaves before the base ended, inside the WAL it brought along, or it is refused after db-data is written',
        ]),
    ...(script.includes(TIMELINE_MATCHED)
      ? []
      : [
          'the base’s timeline is found in the lineage as awk reads it, a number, so that 000000E1 and 000000E2, both 0 in its exponent notation, are one timeline',
        ]),
    ...(cutBranch.includes(CUT_ADVICE) &&
    script.includes('($short): recover to an earlier point, $instead"')
      ? []
      : [
          'a recovery to a point that a cut chain stops short of is not told that latest, which may start past the cut, ends there only if it meets it, and then only with PITR_ACCEPT_CUT',
        ]),
    ...(!cutBranch.includes('PITR_ACCEPT_CUT') ||
    cutBranch.startsWith('      [ "$mode" = --test ] ||\n')
      ? []
      : ['the drill names PITR_ACCEPT_CUT, which it never reads']),
  ];
};

/**
 * wal-fetch.sh, the replay's restore_command (VPS-43): only a WAL file's or a history file's name;
 * one the folder lacks ends the WAL (exit 1); one it has is decrypted and decompressed whole beside
 * the destination before it goes there, so the replay holds one WAL file decrypted at a time, and
 * one that fails to stops the replay (exit 126, fatal to Postgres) instead of passing for the end.
 */
const walFetch = (script: string) => [
  ...(script.includes(String.raw`grep -qE '^([0-9A-F]{24}|[0-9A-F]{8}\.history)$' || exit 1`)
    ? []
    : ['wal-fetch.sh takes a name that is no WAL file’s']),
  ...(script.includes('[ -f "$folder/$name.zst.age" ] || exit 1')
    ? []
    : ['a WAL file the folder lacks does not end the WAL']),
  ...(script.includes(
    'age --decrypt --identity "$key" <"$folder/$name.zst.age" | zstd -dcq >"$partial" &&\n  mv -f "$partial" "$destination"',
  )
    ? []
    : ['a WAL file is not whole before it is in place']),
  ...(script.endsWith('\nexit 126\n') ? [] : ['a WAL file that fails to decrypt ends the WAL']),
];

describe('the migrate and backup images', () => {
  const dockerfile = kit('migrate/Dockerfile');
  const ignore = kit('migrate/Dockerfile.dockerignore');

  it('copies only supabase/migrations and the runner into the migrate image', () => {
    expect(migrateImage(dockerfile)).toEqual([]);
    refuses(
      migrateImage,
      swap(dockerfile, 'COPY supabase/migrations/ /migrations/', 'COPY supabase/ /supabase/'),
      'copies',
    );
    refuses(migrateImage, swap(dockerfile, '\nUSER postgres\n', '\n'), 'does not run as postgres');
  });

  it('builds the migrate image from an allowlist that has no seed path', () => {
    expect(migrateContext(ignore)).toEqual([]);
    refuses(
      migrateContext,
      swap(ignore, '!supabase/migrations/\n', '!supabase/migrations/\n!supabase/seed.sql\n'),
      'a seed path',
    );
    refuses(
      migrateContext,
      swap(ignore, '!supabase/migrations/\n', '!supabase/\n'),
      'more than the migrations',
    );
  });

  it('keeps every migration to the one transaction the runner gives it', () => {
    const files = Object.fromEntries(
      readdirSync('supabase/migrations')
        .filter((name) => name.endsWith('.sql'))
        .map((name) => [name, readFileSync(join('supabase/migrations', name), 'utf8')]),
    );
    expect(Object.keys(files).length).toBeGreaterThan(70);
    expect(migrationTransactions(files)).toEqual([]);
    // A function body, a DO block, a CASE and a quoted semicolon are not statements of their own.
    expect(
      migrationTransactions({
        'ok.sql': [
          'create function f() returns int language plpgsql as $fn$ begin return 1; end $fn$;',
          "do $$ begin perform 1; end $$; select case when true then ';' else 'commit;' end;",
          '-- commit;',
        ].join('\n'),
      }),
    ).toEqual([]);
    const wrapped = (statement: string) =>
      migrationTransactions({ 'bad.sql': `create table t (a int);\n${statement}\nselect 1;` });
    expect(wrapped('commit;')).toEqual(['bad.sql: commit']);
    expect(wrapped('BEGIN;')).toEqual(['bad.sql: BEGIN']);
    expect(wrapped('create index concurrently t_a on t (a);')).toHaveLength(1);
    expect(wrapped('vacuum t;')).toHaveLength(1);
  });

  it('backs up at 02:00 IST and fails a night without a fresh settings archive', () => {
    const backupImage = kit('backup/Dockerfile');
    expect(backupRules(backupImage, backupSh)).toEqual([]);
    refuses(
      (text) => backupRules(text, backupSh),
      swap(backupImage, "'30 20 * * *", "'0 2 * * *"),
      'not 30 20',
    );
    refuses(
      (text) => backupRules(backupImage, text),
      swap(backupSh, '-mmin +120', '-mmin +1440'),
      'no 2-hour check',
    );
    refuses(
      (text) => backupRules(backupImage, text),
      swap(backupSh, '-le 1024 ]; then', '-le 0 ]; then'),
      'no size check',
    );
  });

  it('checks and copies the settings archive before the base, which may run 2 hours', () => {
    expect(archiveFirst(backupSh)).toEqual([]);
    // As before Stop C's review (finding D4): the archive checked and copied after the base.
    const archive = backupSh.slice(
      backupSh.indexOf("# The host's settings archive"),
      backupSh.indexOf('# The base backup (VPS-43)'),
    );
    refuses(
      archiveFirst,
      swap(
        swap(backupSh, archive, ''),
        '\n# Every part of tonight is in the bucket',
        `\n${archive}# Every part of tonight is in the bucket`,
      ),
      'checked or copied after the base begins',
    );
  });

  it('ships the WAL every minute as db’s postgres, with openssl and the signing helpers', () => {
    const backupImage = kit('backup/Dockerfile');
    expect(walShipImage(backupImage)).toEqual([]);
    refuses(
      walShipImage,
      swap(
        backupImage,
        '* * * * * gosu 100:101 /usr/local/bin/wal-ship.sh',
        '* * * * * /usr/local/bin/wal-ship.sh',
      ),
      'every minute as 100:101',
    );
    refuses(
      walShipImage,
      swap(backupImage, 'age curl openssl rclone tar', 'age curl rclone tar'),
      'no openssl',
    );
    refuses(
      walShipImage,
      swap(
        backupImage,
        'counts.sql seal.sh /usr/local/share/menumesh/',
        'counts.sql /usr/local/share/menumesh/',
      ),
      'seal.sh is not where',
    );
  });

  it('ships each WAL file encrypted, signed and named by its cluster, and alerts when one waits', () => {
    expect(walShipper(walShipSh)).toEqual([]);
    refuses(walShipper, swap(walShipSh, 'flock -n 9 || exit 0', 'flock 9'), 'two runs');
    refuses(walShipper, swap(walShipSh, '\nset -f\n', '\n'), 'globbed');
    refuses(
      walShipper,
      swap(walShipSh, '    rm -f "$src"\n  done', '  done'),
      'a raw WAL file goes before',
    );
    refuses(
      walShipper,
      swap(walShipSh, `'menumesh wal 1 %s %s %s\\n' "$id"`, `'menumesh wal 1 %s %s\\n' "$id"`),
      'the signed message',
    );
    refuses(
      walShipper,
      swap(walShipSh, 'wal/$id/$folder/$walfile.$signature', 'wal/$folder/$walfile.$signature'),
      'the object is not',
    );
    refuses(
      walShipper,
      swap(walShipSh, 'rclone copyto --checksum --no-traverse', 'rclone copyto --no-check-dest'),
      'one copyto --checksum by name',
    );
    refuses(
      walShipper,
      swap(
        walShipSh,
        '    rm -f "$out/$file"\n',
        '    rm -f "$out/$file"\n    rclone delete "backups:$BACKUP_BUCKET/wal/"\n',
      ),
      'one copyto --checksum by name',
    );
    refuses(
      walShipper,
      swap(walShipSh, 'sysid=$(od -An -tu8 -j24 -N8 "$src"', 'sysid=$id; : $(od -An'),
      'header is not checked',
    );
    refuses(
      walShipper,
      swap(walShipSh, '[ $((now - last)) -ge 3600 ]', '[ $((now - last)) -ge 60 ]'),
      'at most hourly',
    );
    refuses(
      walShipper,
      swap(
        walShipSh,
        'halted "the WAL file $name names the cluster',
        'stopped "the WAL file $name names the cluster',
      ),
      'alert at once',
    );
    refuses(walShipper, swap(walShipSh, ' || [ -n "$urgent" ]; then', '; then'), 'alert at once');
    refuses(
      walShipper,
      swap(walShipSh, 'HEARTBEAT_URL=${HEARTBEAT_WAL_URL-} notify.sh beat', 'notify.sh beat'),
      'HEARTBEAT_WAL_URL',
    );
  });

  it('alerts from a disk too full for the shipper’s record, at most hourly', () => {
    expect(shipperRecord(walShipSh)).toEqual([]);
    // As before Stop C's review (finding C3): the first write of a full disk ended the run.
    refuses(
      shipperRecord,
      swap(
        walShipSh,
        '    note archiver-failing "$now"\n',
        `    printf '%s\\n' "$now" >"$book/archiver-failing"\n`,
      ),
      'can stop the run before its alert',
    );
    refuses(
      shipperRecord,
      swap(walShipSh, '    note alerting "$now"\n', '    : >"$book/alerting"\n'),
      "':' with a redirection",
    );
    refuses(
      shipperRecord,
      swap(walShipSh, '  unnote alerting\n', '  rm -f "$book/alerting" "$spare/alerting"\n'),
      'a removal from the record',
    );
    refuses(
      shipperRecord,
      swap(walShipSh, 'last=$(noted alert-sent)', 'last=$(kept "$book/alert-sent")'),
      'not read from both',
    );
    refuses(
      shipperRecord,
      swap(
        walShipSh,
        '"$(kept "$book/$1")" "$(kept "$spare/$1")" |',
        '"$(kept "$book/$1")" \'\' |',
      ),
      'not read from both',
    );
  });

  it('hands the signing key to openssl on a file descriptor, and takes one spelling of a signature', () => {
    expect(sealRules(sealSh)).toEqual([]);
    refuses(
      sealRules,
      swap(
        sealSh,
        '-sign -rawin -inkey /dev/fd/3 -in "$1"',
        '-sign -rawin -inkey "$BACKUP_SIGNING_KEY" -in "$1"',
      ),
      'on file descriptor 3',
    );
    refuses(
      sealRules,
      swap(
        sealSh,
        '  seal_sign_dir=$(mktemp',
        `  printf '%s' "$BACKUP_SIGNING_KEY" >/tmp/key\n  seal_sign_dir=$(mktemp`,
      ),
      'the private key is used in: printf',
    );
    refuses(
      sealRules,
      swap(sealSh, '  unset BACKUP_SIGNING_KEY\n', '  export BACKUP_SIGNING_KEY\n'),
      'stays in the environment',
    );
    refuses(
      sealRules,
      swap(
        sealSh,
        '    [ "$(seal_b64url <"$seal_check_dir/signature")" = "$1" ]; then',
        '    :; then',
      ),
      'more than its one spelling',
    );
    refuses(sealRules, swap(sealSh, "tr '/+' '_-'", "tr '+/' '-_'"), 'a tr set starts with "-"');
  });

  it('gives db’s postgres the WAL spool, then runs the image’s entrypoint with db’s command', () => {
    expect(walSpoolWrapper(walSpoolSh)).toEqual([]);
    refuses(
      walSpoolWrapper,
      swap(walSpoolSh, 'chmod 0700 "$spool"', 'chmod 0755 "$spool"'),
      'postgres’s and 0700',
    );
    refuses(
      walSpoolWrapper,
      swap(walSpoolSh, 'exec docker-entrypoint.sh "$@"', 'exec docker-entrypoint.sh postgres'),
      'the image’s entrypoint',
    );
    refuses(
      walSpoolWrapper,
      swap(walSpoolSh, 'if [ ! -d "$spool" ]; then', 'if false; then'),
      'missing wal-spool mount',
    );
  });

  it('keeps a whole 1st in monthly/, or the next whole night when no whole copy is there', () => {
    expect(monthlyCopy(backupSh)).toEqual([]);
    // As after review finding B4: any manifest-<month>-* name stopped the copy (N2).
    refuses(
      monthlyCopy,
      swap(
        backupSh,
        '  if [ -z "$whole" ]; then',
        '  if [ -z "$(rclone lsf --files-only --include "manifest-$month-*" "$remote/monthly/")" ]; then',
      ),
      'any name in monthly/',
    );
    // As after B4 too: a night whose settings archive failed could be the copy (N3); and, since
    // the base, one whose base failed.
    refuses(
      monthlyCopy,
      swap(
        backupSh,
        'if [ -z "$archive_problem" ] && [ -z "$base_problem" ]; then\n  case $stamp in',
        'if true; then\n  case $stamp in',
      ),
      'settings archive or base failed',
    );
    refuses(
      monthlyCopy,
      swap(
        backupSh,
        'if [ -z "$archive_problem" ] && [ -z "$base_problem" ]; then\n  case $stamp in',
        'if [ -z "$archive_problem" ]; then\n  case $stamp in',
      ),
      'settings archive or base failed',
    );
    // As before B4: the 1st only.
    refuses(
      monthlyCopy,
      swap(
        backupSh,
        '      whole=\n      while read -r candidate; do',
        '      whole=never\n      while false; do',
      ),
      'without a copy',
    );
    refuses(
      monthlyCopy,
      swap(backupSh, `sort -u | awk 'NR <= 5' >"$work/candidates"`, 'sort -u >"$work/candidates"'),
      'more than 5 seals',
    );
    // As before the seals (VPS-43): a copy counted as whole by its names and sizes alone, which
    // anyone holding the bucket's token can plant.
    refuses(
      monthlyCopy,
      swap(backupSh, '    seal_open "$work/candidate" "$1" &&\n', '    : &&\n'),
      'without a seal that checks out',
    );
    refuses(
      monthlyCopy,
      swap(
        backupSh,
        '($2 in want) && $1 == want[$2] { have[$2] = 1 }',
        '($2 in want) { have[$2] = 1 }',
      ),
      'at the size its seal gives',
    );
    // As before Stop C's review (finding S2): the parts' sizes read from a listing of monthly/,
    // whose lines an object named after a part, a space and more imitates.
    refuses(
      monthlyCopy,
      swap(
        swap(
          backupSh,
          `    awk '{ print $3 }' "$work/candidate.parts" | held "$remote/monthly" >"$work/candidate.held" &&\n`,
          '',
        ),
        `}' "$work/candidate.parts" "$work/candidate.held"`,
        `}' "$work/candidate.parts" "$work/monthly"`,
      ),
      'by a listing of monthly/',
    );
    refuses(
      monthlyCopy,
      swap(
        backupSh,
        '          NF == 2 && $1 ~ /^[1-9][0-9]*$/ && $2 ~',
        '          $1 ~ /^[1-9][0-9]*$/ && $2 ~',
      ),
      'more than a size and a name is taken for a seal',
    );
    refuses(
      monthlyCopy,
      swap(
        backupSh,
        ' base-" night ".tar.zst.age config-" night ".tar.age", need, " ")',
        '", need, " ")',
      ),
      'without its base, settings archive',
    );
    refuses(
      monthlyCopy,
      swap(
        backupSh,
        '    rclone copyto --no-check-dest "$work/seal" "$remote/monthly/seal-$night.txt"\n',
        '',
      ),
      'not copied after every part',
    );
    // As before review finding F1: a whole copy looked for under the stamp alone.
    refuses(
      monthlyCopy,
      swap(backupSh, 'Z-[0-9a-f]{8}[.]txt$") {\n', 'Z[.]txt$") {\n'),
      'by a seal named with a night’s id',
    );
  });

  it('counts toward the 5 candidates only seals with a record, so five without one hide no recorded copy (Stop C’s re-review, design note 3)', () => {
    expect(recordedCandidates(backupSh)).toEqual([]);
    // Today's listing, as before the re-review: the month's seals alone, each a candidate whether
    // it has a record or not.
    const listing = backupSh.slice(
      backupSh.indexOf(
        `      rclone lsf --files-only --format sp --separator ' ' --include "seal-$month-*" --include "copy-$month-*"`,
      ),
      backupSh.indexOf(`        sort -u | awk 'NR <= 5' >"$work/candidates"`),
    );
    const todays = swap(
      backupSh,
      listing,
      [
        `      rclone lsf --files-only --format sp --separator ' ' --include "seal-$month-*" "$remote/monthly/" |`,
        `        LC_ALL=C awk -v month="$month" -v max="$seal_max" '`,
        String.raw`          NF == 2 && $1 + 0 <= max && $2 ~ ("^seal-" month "-[0-9][0-9]T[0-9][0-9][0-9][0-9]Z-[0-9a-f]{8}[.]txt$") { print substr($2, 6, 25) }' |`,
        '',
      ].join('\n'),
    );
    for (const problem of [
      'are not listed together',
      'a seal longer than a seal, or a record longer than a record',
      'a seal without its record counts toward the 5 candidates',
    ]) {
      refuses(recordedCandidates, todays, problem);
    }
    // Either name taken alone, a record of any size, or no cap.
    refuses(
      recordedCandidates,
      swap(
        backupSh,
        '          END { for (id in sealed) if (id in recorded) print id }',
        '          END { for (id in sealed) print id }',
      ),
      'a seal without its record counts toward the 5 candidates',
    );
    refuses(
      recordedCandidates,
      swap(backupSh, '$2 ~ /^copy-/ && $1 + 0 <= 256)', '$2 ~ /^copy-/)'),
      'a record longer than a record, makes a candidate',
    );
    refuses(
      recordedCandidates,
      swap(backupSh, ` --include "copy-$month-*" "$remote/monthly/" |`, ` "$remote/monthly/" |`),
      'are not listed together',
    );
    refuses(
      recordedCandidates,
      swap(backupSh, `sort -u | awk 'NR <= 5' >"$work/candidates"`, 'sort -u >"$work/candidates"'),
      'more than 5 candidates',
    );
  });

  it('looks a candidate’s seal up by its exact name before it reads it, as its record (Stop C’s re-review, design note 7)', () => {
    expect(sealLookedUp(backupSh)).toEqual([]);
    // Today's whole_copy, as before the re-review: the seal read first.
    const lookup = backupSh.slice(
      backupSh.indexOf(
        '  echo "seal-$1.txt" | held "$remote/monthly" >"$work/candidate.sealed" &&\n',
      ),
      backupSh.indexOf(
        '    rclone cat --no-traverse --head "$((seal_max + 1))" "$remote/monthly/seal-$1.txt" >"$work/candidate" &&\n',
      ),
    );
    const todays = swap(
      swap(backupSh, lookup, ''),
      '    rclone cat --no-traverse --head "$((seal_max + 1))" "$remote/monthly/seal-$1.txt" >"$work/candidate" &&\n',
      '  rclone cat --no-traverse --head "$((seal_max + 1))" "$remote/monthly/seal-$1.txt" >"$work/candidate" &&\n',
    );
    refuses(sealLookedUp, todays, 'a candidate’s seal is read before it is looked up');
    // Looked up with no size cap, or after the read.
    refuses(
      sealLookedUp,
      swap(backupSh, '$1 ~ /^[1-9][0-9]*$/ && $1 + 0 <= max { found = 1 }', '{ found = 1 }'),
      'a candidate’s seal is read before it is looked up',
    );
    refuses(
      sealLookedUp,
      swap(
        backupSh,
        `${lookup}    rclone cat --no-traverse --head "$((seal_max + 1))" "$remote/monthly/seal-$1.txt" >"$work/candidate" &&\n`,
        `  rclone cat --no-traverse --head "$((seal_max + 1))" "$remote/monthly/seal-$1.txt" >"$work/candidate" &&\n${lookup.replace('  echo', '    echo')}`,
      ),
      'a candidate’s seal is read before it is looked up',
    );
  });

  it('stops the night as a theft when a name of the month’s copy or its record is in monthly/ right before it goes up (Stop C’s re-review, finding R1)', () => {
    expect(copyNamesFree(backupSh)).toEqual([]);
    // Today's copy, as before the re-review: neither name looked up, so under locks that refuse
    // overwrites an object put there failed the copy with "the monthly copy", or the record with
    // "the record of the month's copy".
    const copyCheck = `    # None of the copy's names may be in monthly/ yet, its record's among them (above).\n${COPY_LOOKUP}    [ -z "$there" ] ||\n${COPY_REFUSED}`;
    const recordCheck = `    # The record's name, looked up once more right before the record goes up (above).\n${RECORD_LOOKUP}    [ -z "$there" ] ||\n${RECORD_REFUSED}`;
    const todays = swap(swap(backupSh, copyCheck, ''), recordCheck, '');
    refuses(copyNamesFree, todays, 'the month’s copy goes up without its names');
    refuses(copyNamesFree, todays, 'the record goes up without its name looked up');
    // Each look after its upload, which then can only fail on what it finds.
    refuses(
      copyNamesFree,
      swap(
        swap(backupSh, copyCheck, ''),
        `    rclone copyto --no-check-dest "$work/seal" "$remote/monthly/seal-$night.txt"\n`,
        `    rclone copyto --no-check-dest "$work/seal" "$remote/monthly/seal-$night.txt"\n${copyCheck}`,
      ),
      'the month’s copy goes up without its names',
    );
    refuses(
      copyNamesFree,
      swap(
        swap(backupSh, recordCheck, ''),
        '    rclone copyto --no-check-dest "$work/record" "$remote/monthly/copy-$night.txt"\n',
        `    rclone copyto --no-check-dest "$work/record" "$remote/monthly/copy-$night.txt"\n${recordCheck}`,
      ),
      'the record goes up without its name looked up',
    );
    // The record's name left out of the first look, or a failure that doesn't say theft.
    refuses(
      copyNamesFree,
      swap(
        backupSh,
        `      echo "seal-$night.txt"\n      echo "copy-$night.txt"\n    } | held`,
        `      echo "seal-$night.txt"\n    } | held`,
      ),
      'the month’s copy goes up without its names',
    );
    refuses(
      copyNamesFree,
      swap(backupSh, COPY_REFUSED, `      fail "monthly/ holds $there before tonight's copy"\n`),
      'the month’s copy goes up without its names',
    );
    refuses(
      copyNamesFree,
      swap(
        backupSh,
        RECORD_REFUSED,
        `      fail "monthly/ holds $there before the record of tonight's copy"\n`,
      ),
      'the record goes up without its name looked up',
    );
    // A listing of monthly/ for the names.
    refuses(
      copyNamesFree,
      swap(
        backupSh,
        `    # None of the copy's names may be in monthly/ yet, its record's among them (above).\n`,
        `    # None of the copy's names may be in monthly/ yet, its record's among them (above).\n    rclone lsf --files-only --include "*-$night.*" "$remote/monthly/" >"$work/listed"\n`,
      ),
      'looked for by a listing',
    );
  });

  it('counts a month’s copy as whole only with its signed record, which the copy’s night writes last', () => {
    expect(copyRecord(backupSh)).toEqual([]);
    // Today's whole_copy, as before Stop C's re-review (the rest of finding S2): a real seal copied
    // from daily/ beside objects of its sizes under its parts' names was a whole copy.
    const recordCheck = backupSh.slice(
      backupSh.indexOf('    record_message "$1" "$work/candidate" >"$work/candidate.message" &&\n'),
      backupSh.indexOf(`    printf '%s\\n' "$seal_parts" >"$work/candidate.parts" &&\n`),
    );
    const todaysWholeCopy = swap(backupSh, recordCheck, '');
    refuses(copyRecord, todaysWholeCopy, 'a copy counts as whole without its record');
    // Today's copy: the parts and the seal, nothing checked there, no record, and the month's copy
    // said only in the night's last line, after the removal of old copies (finding B1).
    const recordWrite = backupSh.slice(
      backupSh.indexOf('    # The copy as monthly/ holds it, before its record vouches for it:'),
      backupSh.indexOf(`    kept=", kept in monthly/ as the month's copy"\n`),
    );
    const todaysCopy = swap(
      swap(backupSh, recordWrite, ''),
      `  else\n    kept=", the month's copy is $whole"\n`,
      '',
    );
    for (const problem of [
      'the record is made before the copy is checked in monthly/',
      'the record is not signed, written last and confirmed',
      'doesn’t say "kept in monthly/" as soon as the record is up',
      'a whole night that found a recorded copy doesn’t name it',
    ]) {
      refuses(copyRecord, todaysCopy, problem);
    }
    // Today's check of tonight's names, which left the record's name out.
    refuses(
      copyRecord,
      swap(backupSh, ' "seal-$night.txt:0" "copy-$night.txt:0"; do', ' "seal-$night.txt:0"; do'),
      'the record’s name is not among tonight’s names',
    );
    // The record before the copy's check in monthly/, and the kept line after the removal.
    const check = backupSh.slice(
      backupSh.indexOf('    # The copy as monthly/ holds it, before its record vouches for it:'),
      backupSh.indexOf('    # Its record, last, and confirmed by its name at its size.'),
    );
    const record = backupSh.slice(
      backupSh.indexOf('    # Its record, last, and confirmed by its name at its size.'),
      backupSh.indexOf(`    echo "backup $night: kept in monthly/ as the month's copy"\n`),
    );
    refuses(
      copyRecord,
      swap(backupSh, `${check}${record}`, `${record}${check}`),
      'the record is made before the copy is checked',
    );
    const keptLine = `    echo "backup $night: kept in monthly/ as the month's copy"\n`;
    refuses(
      copyRecord,
      swap(
        swap(backupSh, keptLine, ''),
        "reason='the removal of old copies'\n",
        `reason='the removal of old copies'\n${keptLine.trimStart()}`,
      ),
      'doesn’t say "kept in monthly/" as soon as the record is up, before the removal',
    );
    // whole_copy reading the record before it looks it up, or a longer one, parsing its text,
    // building its line from another fetch of the seal, or checking it with the first key alone.
    const lookup =
      '    echo "copy-$1.txt" | held "$remote/monthly" >"$work/candidate.recorded" &&\n';
    const cat =
      '    rclone cat --no-traverse --head 257 "$remote/monthly/copy-$1.txt" >"$work/candidate.record" &&\n';
    refuses(
      copyRecord,
      swap(
        swap(backupSh, lookup, cat),
        `${cat.trimEnd()}\n    [ "$((`,
        `${lookup.trimEnd()}\n    [ "$((`,
      ),
      'the record is read before it is looked up by its exact name',
    );
    refuses(
      copyRecord,
      swap(
        backupSh,
        '--head 257 "$remote/monthly/copy-$1.txt"',
        '--head 1048577 "$remote/monthly/copy-$1.txt"',
      ),
      'a record longer than 256 bytes',
    );
    refuses(
      copyRecord,
      swap(backupSh, '$1 + 0 <= 256 { found = 1 }', '{ found = 1 }'),
      'a record longer than 256 bytes',
    );
    refuses(
      copyRecord,
      swap(
        backupSh,
        '    cmp -s "$work/candidate.built" "$work/candidate.record" &&\n',
        '    grep -q "^menumesh copy 1 $1 " "$work/candidate.record" &&\n',
      ),
      'the record’s line is taken from the bucket',
    );
    refuses(
      copyRecord,
      swap(
        backupSh,
        '    record_message "$1" "$work/candidate" >"$work/candidate.message" &&\n',
        '    rclone cat --no-traverse --head "$((seal_max + 1))" "$remote/monthly/seal-$1.txt" >"$work/again" &&\n    record_message "$1" "$work/again" >"$work/candidate.message" &&\n',
      ),
      'built from another seal than the one checked',
    );
    refuses(
      copyRecord,
      swap(
        backupSh,
        '    seal_verify "$work/candidate.message" "$record_signature" &&',
        '    seal_verify_first "$work/candidate.message" "$record_signature" &&',
      ),
      'the record is checked with the first key alone',
    );
  });

  it('reads no copy’s record in a restore, a point-in-time recovery or pnpm vps:verify-night', () => {
    const files = {
      'restore.sh': restoreSh,
      'pitr.sh': pitrSh,
      'vps-verify-night.mts': readFileSync(join('scripts', 'vps-verify-night.mts'), 'utf8'),
    };
    expect(recordsUnread(files)).toEqual([]);
    refuses(
      (text) => recordsUnread({ ...files, 'restore.sh': text }),
      swap(
        restoreSh,
        'names=$(echo "seal-$night.txt" | held)',
        `names=$(printf '%s\\n' "seal-$night.txt" "copy-$night.txt" | held)`,
      ),
      'restore.sh reads a copy’s record',
    );
    refuses(
      (text) => recordsUnread({ ...files, 'pitr.sh': text }),
      swap(
        pitrSh,
        '"$bucket/daily/seal-$candidate.txt" >"$work/seal" ||',
        '"$bucket/monthly/copy-$candidate.txt" >"$work/seal" ||',
      ),
      'pitr.sh reads a copy’s record',
    );
    refuses(
      (text) => recordsUnread({ ...files, 'vps-verify-night.mts': text }),
      swap(
        files['vps-verify-night.mts'],
        'const sealName = `seal-${night}.txt`;',
        'const sealName = `seal-${night}.txt`;\n  const recordName = `copy-${night}.txt`;',
      ),
      'vps-verify-night.mts reads a copy’s record',
    );
  });

  it('writes every copy whatever the destination holds', () => {
    expect(copyWrites(backupSh)).toEqual([]);
    refuses(
      copyWrites,
      swap(
        backupSh,
        'rclone copyto --no-check-dest "$day/$name" "$remote/monthly/$name"',
        'rclone copyto "$day/$name" "$remote/monthly/$name"',
      ),
      'skips an equal destination',
    );
    refuses(
      copyWrites,
      swap(backupSh, 'rclone copyto --no-check-dest "$archive"', 'rclone copyto "$archive"'),
      'skips an equal destination',
    );
  });

  it('names each night by its stamp and a random part, and stops if tonight’s names are there', () => {
    expect(nightIds(backupSh)).toEqual([]);
    // As before review finding F1: names anyone could write ahead of the night.
    refuses(
      nightIds,
      swap(backupSh, ') night=$stamp-$hex ;;', ') night=$stamp ;;'),
      'can be known before it runs',
    );
    refuses(
      nightIds,
      swap(backupSh, String.raw`hex=$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')`, 'hex=0badc0de'),
      'can be known before it runs',
    );
    refuses(
      nightIds,
      swap(backupSh, 'put "globals-$night.sql.age"', 'put "globals-$stamp.sql.age"'),
      'ends in the stamp alone',
    );
    refuses(
      nightIds,
      swap(backupSh, 'manifest="menumesh backup $night"', 'manifest="menumesh backup $stamp"'),
      'doesn’t name the night’s id',
    );
    refuses(
      nightIds,
      swap(backupSh, 'for folder in daily monthly; do', 'for folder in daily; do'),
      'not looked for in both folders',
    );
    // The check after the first upload: a planted name would stop the night halfway.
    refuses(
      nightIds,
      swap(
        swap(
          backupSh,
          'reason=\'the roles\'\npg_dumpall --globals-only | put "globals-$night.sql.age"\n',
          '',
        ),
        '# None of tonight',
        'reason=\'the roles\'\npg_dumpall --globals-only | put "globals-$night.sql.age"\n# None of tonight',
      ),
      'not looked for in both folders',
    );
    refuses(
      nightIds,
      swap(
        backupSh,
        'rclone lsf --files-only --no-traverse --format sp',
        'rclone lsf --files-only --format sp',
      ),
      'by a listing of the folder',
    );
  });

  it('removes old copies by the bucket’s own time of upload', () => {
    expect(serverTime(backupSh)).toEqual([]);
    // As before review finding F3: the uploader's modification time.
    refuses(
      serverTime,
      swap(
        backupSh,
        'rclone delete --use-server-modtime --min-age 366d',
        'rclone delete --min-age 366d',
      ),
      'reads the uploader’s time',
    );
    refuses(
      serverTime,
      swap(
        backupSh,
        'rclone delete --use-server-modtime --min-age 30d',
        'rclone delete --min-age 30d',
      ),
      'reads the uploader’s time',
    );
    refuses(
      serverTime,
      swap(
        backupSh,
        'rclone delete --use-server-modtime --min-age 15d',
        'rclone delete --min-age 15d',
      ),
      'reads the uploader’s time',
    );
  });

  it('removes the shipped WAL after 15 days, each cluster’s history files kept', () => {
    expect(walRetention(backupSh)).toEqual([]);
    refuses(walRetention, swap(backupSh, '--min-age 15d', '--min-age 14d'), 'after 15 days');
    refuses(
      walRetention,
      swap(backupSh, ' --exclude \'/*/history/**\' "$remote/wal/"', ' "$remote/wal/"'),
      'history files kept',
    );
  });

  it('backs up the whole cluster each night, and a base that fails stops nothing else', () => {
    expect(baseRules(backupSh)).toEqual([]);
    refuses(baseRules, swap(backupSh, '--wal-method=fetch', '--wal-method=none'), 'with its WAL');
    refuses(baseRules, swap(backupSh, 'timeout 7200 pg_basebackup', 'pg_basebackup'), 'bounded');
    refuses(
      baseRules,
      swap(
        backupSh,
        '\nif base; then\n  expected="$expected base-$night.tar.zst.age:1024"\n',
        '\nbase\nif true; then\n  expected="$expected base-$night.tar.zst.age:1024"\n',
      ),
      'can stop the other parts',
    );
    refuses(
      baseRules,
      swap(
        backupSh,
        '[ -z "$problems" ] || fail "$problems"',
        '[ -z "$archive_problem" ] || fail "$archive_problem"',
      ),
      'doesn’t fail the night',
    );
    refuses(
      baseRules,
      swap(
        backupSh,
        ' "base-$night.tar.zst.age:1024" "config-$night.tar.age:1024"',
        ' "config-$night.tar.age:1024"',
      ),
      'looked for before the first upload',
    );
  });

  it('keeps the base’s WAL in a temporary slot of its own until the base ends', () => {
    expect(baseSlot(backupSh)).toEqual([]);
    refuses(baseSlot, swap(backupSh, "'%s', true, true);", "'%s', true, false);"), 'temporary');
    // The shell's fd 9 opened first: the session would inherit it.
    refuses(
      baseSlot,
      swap(
        swap(backupSh, '  exec 9<>"$work/slot.fifo"\n', '  :\n'),
        '  PGCONNECT_TIMEOUT=10 psql -X -q',
        '  exec 9<>"$work/slot.fifo"\n  PGCONNECT_TIMEOUT=10 psql -X -q',
      ),
      'never ends',
    );
    refuses(
      baseSlot,
      swap(backupSh, ' and temporary and restart_lsn is not null', ''),
      'seen in db',
    );
    refuses(baseSlot, swap(backupSh, '  if ! hold_wal; then\n', '  if false; then\n'), 'held');
    refuses(
      baseSlot,
      swap(backupSh, '  take_base || taken=1\n  release_wal\n', '  take_base || taken=1\n'),
      'outlives the base',
    );
  });

  it('seals each night last, signed, with each part as it went up', () => {
    expect(sealWrite(backupSh)).toEqual([]);
    refuses(
      sealWrite,
      swap(backupSh, 'seal_self_check ||\n', ': ||\n'),
      'checked before the first upload',
    );
    // The readers holding a FIFO open for writing would never see its end.
    refuses(
      sealWrite,
      swap(
        backupSh,
        '  sha256sum <"$work/sum.fifo" >"$work/sum" 7>&- 8>&- &\n',
        '  sha256sum <"$work/sum.fifo" >"$work/sum" &\n',
      ),
      'taken as it streams',
    );
    refuses(
      sealWrite,
      swap(backupSh, '[ "$size" -eq "$sent" ] || fail', ': || fail'),
      'held to the size that went up',
    );
    refuses(
      sealWrite,
      swap(backupSh, 'seal_open "$work/seal" "$night" ||', ': ||'),
      'signed and checked after',
    );
  });

  it('pings the heartbeat with the night’s line', () => {
    const notify = kit('backup/notify.sh');
    expect(beatNight(backupSh, notify)).toEqual([]);
    refuses(
      (text) => beatNight(text, notify),
      swap(backupSh, 'notify.sh beat "$line"', 'notify.sh beat'),
      'doesn’t carry the night’s line',
    );
    refuses(
      (text) => beatNight(backupSh, text),
      swap(notify, '      [ -z "${2-}" ] || printf \'data-raw = %s\\n\' "$(quoted "$2")"\n', ''),
      'sends no text',
    );
  });

  it('says only locks that refuse overwrites keep what a restore reads', () => {
    const runbook = readFileSync(join('docs', 'RUNBOOK.md'), 'utf8');
    expect(retentionClaim(backupSh, runbook)).toEqual([]);
    // As before review finding F5.
    refuses(
      (text) => retentionClaim(backupSh, text),
      swap(
        runbook,
        'keeps the old\n   versions only, and a restore reads the current one',
        'keeps them too',
      ),
      'doesn’t say what per-object retention keeps',
    );
    refuses(
      (text) => retentionClaim(backupSh, text),
      swap(
        runbook,
        '3. **Alerts:**',
        'Only those locks, or a retention date on each object, keep a stolen token from replacing what a restore reads.\n\n3. **Alerts:**',
      ),
      'counts per-object retention beside the locks',
    );
    refuses(
      (text) => retentionClaim(text, runbook),
      swap(
        backupSh,
        'keeps the\n# old versions only, and a restore reads the current one.',
        'keeps them\n# too.',
      ),
      'backup.sh counts per-object retention',
    );
  });

  it('restores pg_cron into the database its launcher reads, with no job run', () => {
    expect(restoreCron(barePostgres, restoreSh)).toEqual([]);
    refuses(
      (text) => restoreCron(text, restoreSh),
      swap(barePostgres, 'cron.database_name=postgres', 'cron.database_name=template1'),
      'not in postgres',
    );
    refuses(
      (text) => restoreCron(text, restoreSh),
      swap(barePostgres, '  -c cron.launch_active_jobs=off \\\n', ''),
      'could run',
    );
    refuses(
      (text) => restoreCron(barePostgres, text),
      swap(restoreSh, '\\"$db\\" with (force)"', '\\"$db\\""'),
      'without FORCE',
    );
  });

  it('starts an existing cluster in a bare one only once it was shut down cleanly', () => {
    expect(cleanClustersOnly(barePostgres)).toEqual([]);
    refuses(
      cleanClustersOnly,
      swap(barePostgres, 'if [ "$state" != \'shut down\' ]; then', 'if false; then'),
      'without the check',
    );
    refuses(
      cleanClustersOnly,
      swap(
        barePostgres,
        'chown postgres:postgres /var/run/postgresql\n',
        'chown postgres:postgres "$data" /var/run/postgresql\n',
      ),
      'changes before',
    );
  });

  it('restores into bare clusters that have the image’s supautils settings, as db has', () => {
    expect(bareSettings(compose, barePostgres)).toEqual([]);
    refuses(
      (text) => bareSettings(text, barePostgres),
      swapIn(
        compose,
        'restore-db',
        '      - /var/lib/postgresql/data:size=1g\n',
        '      - /var/lib/postgresql/data:size=1g\n      - /etc/postgresql-custom:size=16m\n',
      ),
      'hides',
    );
    refuses(
      (text) => bareSettings(text, barePostgres),
      swapIn(compose, 'recover-db', '      - db-config:/etc/postgresql-custom\n', ''),
      'without db-config',
    );
    refuses(
      (text) => bareSettings(compose, text),
      swap(barePostgres, 'if [ ! -s "$custom/supautils.conf" ]; then', 'if false; then'),
      'without supautils.conf',
    );
    refuses(
      (text) => bareSettings(compose, text),
      swap(barePostgres, '\nmkdir -p "$data"', '\n: >"$custom/supautils.conf"\nmkdir -p "$data"'),
      'empty settings files',
    );
  });

  it('runs nothing from a night as code: the roles in psql’s restricted mode, a checked manifest', () => {
    expect(restoreTrust(restoreSh)).toEqual([]);
    // As before the review: the roles straight into psql.
    refuses(
      restoreTrust,
      swap(restoreSh, String.raw`  printf '%srestrict %s\n' "\\" "$key"` + '\n', ''),
      'without \\restrict first',
    );
    refuses(
      restoreTrust,
      swap(
        restoreSh,
        String.raw`key=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')`,
        'key=menumesh',
      ),
      'no random key',
    );
    refuses(
      restoreTrust,
      swap(restoreSh, String.raw` -e '/^\\unrestrict /d'`, ''),
      'own \\restrict or \\unrestrict',
    );
    refuses(restoreTrust, swap(restoreSh, '\nset -f\n', '\n'), 'globbed');
    refuses(
      restoreTrust,
      swap(restoreSh, '$2 ~ /^[a-z_][a-z0-9_]*$/ && length($2) < 64', 'length($2) < 64'),
      'line by line',
    );
    refuses(
      restoreTrust,
      swap(restoreSh, '      substr($0, 1, 16) > now {\n', '      substr($0, 1, 16) > "9999" {\n'),
      'later than now',
    );
    refuses(
      restoreTrust,
      swap(restoreSh, 'find /storage ! -type f ! -type d', 'find /storage -type l'),
      'links and special files',
    );
  });

  it('finds each database’s lines of the manifest by its name as text (Stop C’s re-review)', () => {
    expect(restoreMatched(restoreSh)).toEqual([]);
    // Today's line: the name compared as awk reads it.
    refuses(
      restoreMatched,
      swap(restoreSh, '&& $2 "" == db ""', '&& $2 == db'),
      'nan, inf and infinity find none',
    );
  });

  it('reads a night from one folder, by its age alone: daily/ under 29 days, monthly/ to 365', () => {
    expect(restoreFolder(restoreSh)).toEqual([]);
    // As after review finding N1: a young night held by both folders had its manifests compared,
    // so one planted in monthly/ stopped it (RV1).
    refuses(
      restoreFolder,
      swap(
        restoreSh,
        '# Only the lines backup.sh writes, in printable ASCII:',
        [
          'monthly=$(rclone lsf --files-only "$bucket/monthly/")',
          'if [ "$folder" = daily ] && listed "$monthly" "manifest-$stamp.txt.age"; then',
          '  copy=$(rclone cat "$bucket/monthly/manifest-$stamp.txt.age" | age --decrypt --identity "$AGE_IDENTITY_FILE")',
          '  [ "$copy" = "$manifest" ] || die "the manifests of $stamp in daily/ and monthly/ differ"',
          'fi',
          '# Only the lines backup.sh writes, in printable ASCII:',
        ].join('\n'),
      ),
      'read by its name',
    );
    refuses(
      restoreFolder,
      swap(
        restoreSh,
        '# Only the lines backup.sh writes, in printable ASCII:',
        [
          'folder=monthly',
          'copy=$(fetch "manifest-$night.txt.age")',
          'folder=daily',
          '# Only the lines backup.sh writes, in printable ASCII:',
        ].join('\n'),
      ),
      'read twice',
    );
    // As after N1: a night up to 31 days old read from daily/, past its lock's 29 (RV2).
    refuses(
      restoreFolder,
      swap(restoreSh, '$((seconds - 29 * 86400))', '$((seconds - 31 * 86400))'),
      'no lines 29 and 365 days back',
    );
    refuses(
      restoreFolder,
      swap(restoreSh, 'print (stamp > line)', 'print (stamp >= line)'),
      'as old as a lock',
    );
    // As after review finding B1: a young night missing from daily/ read from monthly/.
    refuses(
      restoreFolder,
      swap(
        restoreSh,
        'if ! listed "$names" "seal-$night.txt"; then\n',
        [
          'if [ "$folder" = daily ] && ! listed "$names" "seal-$night.txt"; then',
          '  folder=monthly',
          '  names=$(echo "seal-$night.txt" | held)',
          'fi',
          'if ! listed "$names" "seal-$night.txt"; then',
          '',
        ].join('\n'),
      ),
      'falls back to the other',
    );
    // The folder chosen from what daily/ holds, as before N1; and monthly/ for a young night.
    refuses(
      restoreFolder,
      swap(
        restoreSh,
        'if under "$daily_lock"; then\n  folder=daily\nelif under "$monthly_lock"; then',
        'if listed "$(rclone lsf --files-only "$bucket/daily/")" "manifest-$night.txt.age"; then\n  folder=daily\nelif true; then',
      ),
      'not chosen by the night’s age alone',
    );
    refuses(
      restoreFolder,
      swap(restoreSh, '  folder=daily\nelif', '  folder=monthly\nelif'),
      'not chosen by the night’s age alone',
    );
    // A month's copy past monthly/'s lock read as any other.
    refuses(
      restoreFolder,
      swap(restoreSh, 'elif under "$monthly_lock"; then', 'elif true; then'),
      'not chosen by the night’s age alone',
    );
    refuses(
      restoreFolder,
      swap(restoreSh, 'substr($0, 1, 16) > lock && $0', 'substr($0, 1, 16) >= lock && $0'),
      'unasked, a night 29 days old',
    );
    refuses(
      restoreFolder,
      swap(restoreSh, '"$bucket/$folder/$1" >"$parts/$1"', '"$bucket/daily/$1" >"$parts/$1"'),
      'night’s folder',
    );
    refuses(
      restoreFolder,
      swap(restoreSh, '"$1 is not in $folder/"', '"$1 is not in daily/"'),
      'names daily/',
    );
  });

  it('takes RESTORE_STAMP as a whole night id, and the night’s age from its stamp', () => {
    expect(restoreIds(restoreSh)).toEqual([]);
    // As before review finding F1: a stamp alone named a night.
    refuses(
      restoreIds,
      swap(
        restoreSh,
        '  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9]Z-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;',
        '  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9]Z*) ;;',
      ),
      'not checked whole',
    );
    refuses(
      restoreIds,
      swap(restoreSh, '\nstamp=${night%-*}\n', '\nstamp=$night\n'),
      'age is not taken',
    );
    refuses(
      restoreIds,
      swap(
        restoreSh,
        String.raw`T[0-9]\{4\}Z-[0-9a-f]\{8\}\)\.txt`,
        String.raw`T[0-9]\{4\}Z.*\)\.txt`,
      ),
      'not named as backup.sh names one',
    );
    refuses(
      restoreIds,
      swap(restoreSh, 'if ($0 != "menumesh backup " night) {', 'if ($0 !~ "^menumesh backup ") {'),
      'first line is not checked',
    );
  });

  it('looks for and reads each part by its name, and holds no folder’s listing', () => {
    expect(restoreLookups(restoreSh)).toEqual([]);
    // As before review finding F2: the folder's whole listing in the shell, and read through.
    refuses(
      restoreLookups,
      swap(
        restoreSh,
        'names=$(echo "seal-$night.txt" | held)',
        'names=$(rclone lsf --files-only "$bucket/$folder/")',
      ),
      'listing is held in the shell',
    );
    refuses(
      restoreLookups,
      swap(
        restoreSh,
        'rclone cat --no-traverse --head "$((${want#* } + 1))"',
        'rclone cat --head "$((${want#* } + 1))"',
      ),
      'read after a listing',
    );
    refuses(
      restoreLookups,
      swap(
        restoreSh,
        'rclone cat --no-traverse --head "$((seal_max + 1))"',
        'rclone cat --head "$((seal_max + 1))"',
      ),
      'read after a listing',
    );
    refuses(
      restoreLookups,
      swap(
        restoreSh,
        'rclone lsf --files-only --no-traverse --files-from-raw - "$bucket/$folder/"',
        'rclone lsf --files-only --files-from-raw - "$bucket/$folder/"',
      ),
      'looked for in a listing',
    );
    refuses(
      restoreLookups,
      swap(
        restoreSh,
        `  night=$(rclone lsf --files-only --include 'seal-*.txt' "$bucket/daily/" |`,
        `  daily=$(rclone lsf --files-only "$bucket/daily/")\n  night=$(printf '%s\\n' "$daily" |`,
      ),
      'listing is held in the shell',
    );
    refuses(
      restoreLookups,
      swap(
        restoreSh,
        '      substr($0, 1, 16) > lock && $0 > newest { newest = $0 }\n',
        '      substr($0, 1, 16) > lock\n',
      ),
      'more than the newest seal’s id is kept',
    );
  });

  it('recovers only a night RESTORE_STAMP names', () => {
    expect(recoveryNamed(restoreSh, compose)).toEqual([]);
    // As before review finding F4: an unnamed recovery took the newest name in daily/.
    refuses(
      (text) => recoveryNamed(text, compose),
      swap(
        restoreSh,
        '[ -n "$night" ] || [ "$mode" = --test ] ||\n  die "a recovery needs',
        '[ -n "$night" ] || true ||\n  die "a needs',
      ),
      'can take the newest name',
    );
    refuses(
      (text) => recoveryNamed(restoreSh, text),
      swapIn(
        compose,
        'recover',
        '      # The night to recover, as the backup',
        '      # Empty: the newest night. The night to recover, as the backup',
      ),
      'must be named',
    );
  });

  it('filters everything a restore prints, as process 1, and ends a test with the night', () => {
    expect(restoreFilter(restoreSh)).toEqual([]);
    // As before review finding N4: only restore.sh's own lines were filtered.
    refuses(restoreFilter, swap(restoreSh, 'exec >"$fifo" 2>&1\n', ''), 'don’t all go through');
    refuses(
      restoreFilter,
      swap(
        restoreSh,
        String.raw`tr -d '\000-\010\013-\037\177-\377' <"$fifo"`,
        String.raw`tr -d '\000-\010\177-\377' <"$fifo"`,
      ),
      'no filter',
    );
    refuses(restoreFilter, swap(restoreSh, '  wait "$filter" || true\n', ''), 'can end before');
    // The first version of the fix: the run again through a pipeline, under a new process 1.
    refuses(
      restoreFilter,
      swap(
        restoreSh,
        'exec >"$fifo" 2>&1\n',
        '[ -n "$RESTORE_FILTERED" ] || { RESTORE_FILTERED=1 /bin/sh "$0" "$@" 2>&1 | tr -d x; exit; }\n' +
          'exec >"$fifo" 2>&1\n',
      ),
      'runs itself again',
    );
    refuses(
      restoreFilter,
      swap(
        restoreSh,
        'echo "restore test passed: the night of $night, from $folder/"',
        "echo 'restore test passed'",
      ),
      'doesn’t name the night',
    );
  });

  it('says only that the roles failed, whatever failed', () => {
    expect(rolesFailure(restoreSh)).toEqual([]);
    // As before review finding N5.
    refuses(
      rolesFailure,
      swap(
        restoreSh,
        'die "the roles of $night (globals-$night.sql.age in $folder/) did not restore (see above)"',
        `die "the roles of $night did not restore (psql says why above): a backup's roles file holds SQL and no psql command"`,
      ),
      'blames psql',
    );
  });

  it('names the object and its folder when a part fails, with the exit status as before', () => {
    expect(partFailures(restoreSh)).toEqual([]);
    // As before review finding RV1: a manifest age couldn't read ended the run with age's lines.
    refuses(
      partFailures,
      swap(
        restoreSh,
        'manifest=$(fetch "manifest-$night.txt.age") ||\n  stop "the manifest of $night (manifest-$night.txt.age in $folder/) could not be read (see above)"\n',
        'manifest=$(fetch "manifest-$night.txt.age")\n',
      ),
      'manifest-$night.txt.age doesn’t name it',
    );
    refuses(
      partFailures,
      swap(
        restoreSh,
        ' ||\n    stop "the database $db of $night ($db-$night.dump.age in $folder/) did not restore (see above)"',
        '',
      ),
      '$db-$night.dump.age doesn’t name it',
    );
    refuses(
      partFailures,
      swap(
        restoreSh,
        '  echo "restore: $*" >&2\n  exit "$status"\n}',
        '  echo "restore: $*" >&2\n  exit 1\n}',
      ),
      'changes the run’s exit status',
    );
  });

  it('checks the Storage archive’s members in both modes before anything is restored', () => {
    expect(storageFirst(restoreSh)).toEqual([]);
    // As before review finding N6: the members were checked only once a recovery extracted them.
    refuses(
      storageFirst,
      swap(
        restoreSh,
        'listing=$(fetch "storage-$night.tar.age" | tar --list --verbose --numeric-owner --file=- |',
        'listing=$(printf "" |',
      ),
      'only after the databases',
    );
    refuses(
      storageFirst,
      swap(restoreSh, '    /^d/ { next }\n', '    /^[dl]/ { next }\n'),
      'more than files and folders',
    );
    refuses(
      storageFirst,
      swap(restoreSh, '[ "$mode" != --into ] || writing=yes\n', ''),
      'make the volumes new',
    );
  });

  it('reads a night only as its seal gives it, each part checked before anything is restored', () => {
    expect(sealFirst(restoreSh)).toEqual([]);
    // As before the seals (VPS-43): a night read whoever wrote it.
    refuses(
      sealFirst,
      swap(restoreSh, 'seal_open "$parts/seal" "$night" ||', 'true ||'),
      'before the night’s seal checked out',
    );
    refuses(
      sealFirst,
      swap(restoreSh, '  [ -n "$want" ] || die', '  [ -n "$want" ] || true'),
      'the seal doesn’t list can be read',
    );
    refuses(
      sealFirst,
      swap(
        restoreSh,
        `  [ "$(sha256sum "$parts/$1" | cut -d ' ' -f 1)" = "\${want% *}" ] ||`,
        '  true ||',
      ),
      'size and sha256 its seal gives',
    );
    // As before too: each part streamed from the bucket into age.
    refuses(
      sealFirst,
      swap(
        restoreSh,
        '  age --decrypt --identity "$AGE_IDENTITY_FILE" <"$parts/$1"',
        '  rclone cat --no-traverse "$bucket/$folder/$1" | age --decrypt --identity "$AGE_IDENTITY_FILE"',
      ),
      'anything but its checked download',
    );
    // Each part checked only as it is needed: a later one found changed after the databases.
    refuses(
      sealFirst,
      swap(
        swap(restoreSh, 'for part in $reads; do get "$part"; done\n', ''),
        "echo 'restore: roles'\n",
        'echo \'restore: roles\'\nfor part in $reads; do get "$part"; done\n',
      ),
      'checked only once something was restored',
    );
    refuses(
      sealFirst,
      swap(restoreSh, '  [ -z "$parts" ] || rm -rf "$parts"\n', ''),
      'the downloads stay',
    );
  });

  it('takes a seal only in the lines a backup writes, signed over every byte before its line', () => {
    expect(sealGrammar(sealSh)).toEqual([]);
    refuses(sealGrammar, swap(sealSh, '\nseal_max=16384\n', '\nseal_max=65536\n'), 'SEAL_MAX');
    refuses(
      sealGrammar,
      swap(sealSh, `tr -d '\\n -~' <"$1"`, `tr -d '\\n -~\\t' <"$1"`),
      'past printable ASCII',
    );
    refuses(
      sealGrammar,
      swap(sealSh, '        if (seen[f[4]]++) { print "problem lists a part twice"; exit }\n', ''),
      'with a part twice',
    );
    refuses(
      sealGrammar,
      swap(
        sealSh,
        '    seal_verify "$seal_open_dir/body"',
        '    seal_verify_first "$seal_open_dir/body"',
      ),
      'against each key',
    );
  });

  it('sets in each service every setting the script it runs needs', () => {
    expect(scriptEnv(compose)).toEqual([]);
    refuses(
      scriptEnv,
      swapIn(compose, 'recover-pitr', '      AGE_IDENTITY_FILE: /run/age/identity.txt\n', ''),
      'recover-pitr does not set AGE_IDENTITY_FILE, which pitr.sh needs',
    );
    refuses(
      scriptEnv,
      swapIn(compose, 'restore-test', '      PGUSER: supabase_admin\n', ''),
      'restore-test does not set PGUSER, which restore.sh needs',
    );
    refuses(
      (text) => scriptEnv(compose, [['pitr.sh', text, ['pitr-test', 'recover-pitr']]]),
      swap(pitrSh, 'for name in BACKUP_BUCKET ', 'for name in PGHOST BACKUP_BUCKET '),
      'pitr-test does not set PGHOST, which pitr.sh needs',
    );
  });

  it('replays a night’s base and the backup’s signed WAL, each read as its seal or name gives it', () => {
    expect(pitrRules(pitrSh)).toEqual([]);
    refuses(
      pitrRules,
      swap(
        pitrSh,
        ' --no-mimetype --use-server-modtime "$bucket/wal/',
        ' --no-mimetype "$bucket/wal/',
      ),
      'upload time is not the bucket’s own',
    );
    refuses(
      pitrRules,
      swap(
        pitrSh,
        '    if seal_verify "$work/message" "$3"; then',
        '    if [ -s "$work/message" ]; then',
      ),
      'without the backup’s signature',
    );
    refuses(
      pitrRules,
      swap(
        pitrSh,
        'env -i PATH=/usr/local/bin:/usr/bin:/bin LC_ALL=C gosu postgres postgres "$@"',
        'gosu postgres postgres "$@"',
      ),
      'the script’s environment',
    );
    refuses(pitrRules, swap(pitrSh, '  -c hot_standby=off \\\n', ''), 'without -c hot_standby=off');
    refuses(
      pitrRules,
      swap(pitrSh, '  -c shared_preload_libraries= \\\n', ''),
      'without -c shared_preload_libraries=',
    );
    refuses(
      pitrRules,
      swap(
        pitrSh,
        '[ "$point" -ge $((seconds - 14 * 86400)) ] ||',
        '[ "$point" -ge $((seconds - 29 * 86400)) ] ||',
      ),
      'more than 14 days back',
    );
    refuses(pitrRules, swap(pitrSh, '\nforget_key\n', '\n'), 'the copy of the age key');
    refuses(
      pitrRules,
      swap(pitrSh, 'set -- "$@" -c archive_mode=off -c fsync=off', 'set -- "$@" -c fsync=off'),
      'the drill keeps its own',
    );
    refuses(
      pitrRules,
      swap(
        pitrSh,
        '  [ "$mode" = --test ] ||\n    die "a recovery needs',
        '  true ||\n    die "a recovery needs',
      ),
      'without PITR_TARGET',
    );
    refuses(pitrRules, swap(pitrSh, '[ -z "$orphans" ] ||', 'true ||'), 'without its history file');
  });

  it('keeps the live cluster’s own settings out of the replay (review finding S1)', () => {
    for (const flag of [
      '  -c port=5432 \\\n',
      '  -c ssl=off \\\n',
      '  -c recovery_end_command= \\\n',
      '  -c archive_cleanup_command= \\\n',
    ]) {
      refuses(
        pitrRules,
        swap(pitrSh, flag, ''),
        `the replay runs without ${flag.trim().slice(0, -2)}`,
      );
    }
    refuses(
      pitrRules,
      swap(
        pitrSh,
        '  gosu postgres mv -f "$auto" "$auto.pitr" ||',
        '  gosu postgres cp -f "$auto" "$auto.pitr" ||',
      ),
      'the replay reads the base’s own postgresql.auto.conf',
    );
    refuses(
      pitrRules,
      swap(pitrSh, 'gosu postgres touch "$auto" ||', 'gosu postgres test -e "$auto" ||'),
      'the replay reads the base’s own postgresql.auto.conf',
    );
    refuses(
      pitrRules,
      swap(
        pitrSh,
        '    gosu postgres mv -f "$auto.pitr" "$auto" ||',
        '    gosu postgres rm -f "$auto.pitr" ||',
      ),
      'a recovery does not put the base’s postgresql.auto.conf back',
    );
  });

  it('takes at each position the WAL file of the timeline the replay reads there (review finding C2)', () => {
    refuses(
      pitrRules,
      swap(
        pitrSh,
        '      if (tl "" == reads "") print position, time, past, size, walfile, part[2]',
        '      print position, time, past, size, walfile, part[2]',
      ),
      'a position takes a WAL file of another timeline',
    );
    refuses(
      pitrRules,
      swap(
        pitrSh,
        String.raw`while next=$(printf '%08X' $((0x$newest + 1))) && grep -qx "$next" "$work/histories"; do`,
        String.raw`while next=$(printf '%08X' $((0x$newest + 1))) && false; do`,
      ),
      'a position takes a WAL file of another timeline',
    );
    refuses(
      pitrRules,
      swap(
        pitrSh,
        '    if grep -qx "$want$at" "$work/base-wal"; then',
        '    if grep -q "$at\\$" "$work/base-wal"; then',
      ),
      'a WAL file the base brought fills a position of another timeline',
    );
    refuses(
      pitrRules,
      swap(pitrSh, '  gap=$want$at\n', '  gap=$tli$at\n'),
      'a gap is named on another',
    );
    refuses(
      pitrRules,
      swap(
        pitrSh,
        '  while read -r _ _ _ _ walfile signature; do\n    if take "$folder" "$walfile" "$signature" "$cap" </dev/null; then\n      cut=$walfile\n',
        '  while read -r _ _ _ _ walfile signature && [ "$looked" -lt 8 ]; do\n    if take "$folder" "$walfile" "$signature" "$cap" </dev/null; then\n      cut=$walfile\n',
      ),
      'gives up before it has tried every object',
    );
    refuses(
      pitrRules,
      swap(
        pitrSh,
        '  if [ "$restored" != "$from_bucket" ]; then',
        '  if [ "$restored" != "$restored" ]; then',
      ),
      'stopped short of the chain’s last WAL file passes',
    );
  });

  it('refuses a recovery to latest that a cut chain would end early, unless told (review finding D6)', () => {
    refuses(
      pitrRules,
      swap(pitrSh, '    [ "$accept" = "$gap" ] ||\n', '    [ -n "$accept" ] ||\n'),
      'a recovery to latest goes past a cut chain',
    );
    refuses(
      pitrRules,
      swap(
        pitrSh,
        'die "a recovery to latest would end at the cut at $gap',
        'echo "a recovery to latest would end at the cut at $gap',
      ),
      'a recovery to latest goes past a cut chain',
    );
    // The base unpacked into db-data before the chain is known, as before the fix.
    const early = swap(
      pitrSh,
      '\n# --- the WAL ---\n',
      '\n[ "$mode" != --into ] || writing=yes\nbase_tar | gosu postgres tar --extract --file=- --directory="$data" --no-same-owner\n# --- the WAL ---\n',
    );
    refuses(pitrRules, early, 'writes to db-data before it is refused');
    refuses(
      pitrRules,
      swap(
        pitrSh,
        `  [ -z "$cut" ] || die "the chain of WAL files is cut at $gap, with the backup's WAL after it: the drill fails"`,
        `  [ -z "$cut" ] || echo "the chain of WAL files is cut at $gap, with the backup's WAL after it: the drill fails"`,
      ),
      'the drill passes with the chain of WAL files cut',
    );
  });

  it('refuses a base whose timeline the replay leaves before the base ended (Stop C’s re-review, finding M1)', () => {
    const problem = 'the replay leaves before the base ended, inside the WAL it brought along';
    // Today's check: the next timeline's begin held to the base's first WAL file alone, so a fork
    // inside the base's own WAL passes.
    refuses(pitrRules, swap(pitrSh, BASE_CHECK, TODAYS_BASE_CHECK), problem);
    // Held to the base's first WAL file, or a fork in its last passing.
    refuses(pitrRules, swap(pitrSh, '-v last="$base_last"', '-v last="$first"'), problem);
    refuses(
      pitrRules,
      swap(
        pitrSh,
        '  on && NR == on + 1 && $2 "" <= last "" { left = $2 }',
        '  on && NR == on + 1 && $2 "" < last "" { left = $2 }',
      ),
      problem,
    );
    // The refusal once db-data is being written.
    const refusal =
      /\n\[ -z "\$problem" \] \|\|\n {2}die "the base backup of \$night is of the timeline [^\n]*\n/.exec(
        pitrSh,
      )?.[0] ?? '';
    expect(refusal).toContain('so it can\'t start from this base, and nothing was replayed"');
    const late = swap(
      swap(pitrSh, refusal, '\n'),
      '[ "$mode" != --into ] || writing=yes\n',
      `[ "$mode" != --into ] || writing=yes${refusal}`,
    );
    refuses(pitrRules, late, 'or it is refused after db-data is written');
  });

  it('finds the base’s timeline in the lineage as text (Stop C’s re-review, pitr design note 1)', () => {
    // Today's line: awk compares two fields that read as numbers as numbers, so a base of timeline
    // 000000E1 takes 000000E2's line, and the check reads the begin of the timeline after that.
    refuses(
      pitrRules,
      swap(pitrSh, TIMELINE_MATCHED, '  $1 == tli { on = NR; next }\n'),
      'found in the lineage as awk reads it, a number',
    );
  });

  it('tells a recovery to a point that a cut chain stops short of what latest does at the cut, and not the drill (Stop C’s re-reviews, finding T1)', () => {
    expect(pitrSh).toContain(CUT_INSTEAD);
    const problem = 'ends there only if it meets it, and then only with PITR_ACCEPT_CUT';
    // Today's line: a recovery to latest said to end at the cut, though one from a newer night
    // never meets it, and the drill told so too.
    const today = swap(pitrSh, CUT_INSTEAD, TODAYS_CUT_INSTEAD);
    refuses(pitrRules, today, problem);
    refuses(pitrRules, today, 'the drill names PITR_ACCEPT_CUT');
    // The advice as it should be, but the drill told it too.
    refuses(
      pitrRules,
      swap(
        pitrSh,
        '      [ "$mode" = --test ] ||\n        instead="or to latest; if',
        '      instead="or to latest; if',
      ),
      'the drill names PITR_ACCEPT_CUT',
    );
    // As before the re-review: no word of PITR_ACCEPT_CUT.
    refuses(
      pitrRules,
      swap(
        pitrSh,
        '($short): recover to an earlier point, $instead"',
        '($short): recover to an earlier point, or to latest"',
      ),
      problem,
    );
  });

  it('hands the replay one WAL file at a time, and a file that fails to decrypt stops it', () => {
    expect(walFetch(walFetchSh)).toEqual([]);
    refuses(walFetch, swap(walFetchSh, '\nexit 126\n', '\nexit 1\n'), 'ends the WAL');
    refuses(
      walFetch,
      swap(
        walFetchSh,
        '[ -f "$folder/$name.zst.age" ] || exit 1',
        '[ -f "$folder/$name.zst.age" ] || exit 2',
      ),
      'does not end the WAL',
    );
    refuses(
      walFetch,
      swap(walFetchSh, 'zstd -dcq >"$partial" &&', 'zstd -dcq >"$destination" &&'),
      'not whole before it is in place',
    );
  });
});

// --- the seals, as the harness and vps:verify-night read them (scripts/vps-seal.mts) ---

describe('the nights’ seals (VPS-43)', () => {
  const night = '2026-11-01T2030Z-0123abcd';
  const pair = generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const sum = (text: string) => createHash('sha256').update(text).digest('hex');
  const parts: SealPart[] = [
    { sha256: sum('globals'), bytes: 7491, name: `globals-${night}.sql.age` },
    { sha256: sum('storage'), bytes: 10440, name: `storage-${night}.tar.age` },
    { sha256: sum('manifest'), bytes: 4265, name: `manifest-${night}.txt.age` },
    { sha256: sum('postgres'), bytes: 1651328, name: `postgres-${night}.dump.age` },
    { sha256: sum('base'), bytes: 3637298, name: `base-${night}.tar.zst.age` },
    { sha256: sum('config'), bytes: 10440, name: `config-${night}.tar.age` },
  ];
  const base = {
    end: '2026-11-01T20:33:07Z',
    walfile: '0000000100000000000000B9',
    cluster: '7708084103783477285',
  };
  const good = sealText(night, base, parts, privateKey);
  const signed = (body: string) => `${body}signature ${signedWith(privateKey, body)}\n`;
  const bodyOf = (text: string) => text.slice(0, text.lastIndexOf('signature '));

  it('writes a seal in the lines backup.sh writes, which it reads back and whose signature checks out', () => {
    expect(good.split('\n').slice(0, 3)).toEqual([
      `menumesh seal 1 ${night}`,
      `base ${base.end} ${base.walfile} ${base.cluster}`,
      `part ${parts[0].sha256} ${parts[0].bytes} ${parts[0].name}`,
    ]);
    expect(good).toMatch(/\nsignature [A-Za-z0-9_-]{86}\n$/);
    const seal = sealOf(good, night);
    if (typeof seal === 'string') throw new Error(seal);
    expect(seal.base).toEqual(base);
    expect(seal.parts).toEqual(parts);
    expect(seal.body).toBe(bodyOf(good));
    expect(signedBy(publicKey, seal.body, seal.signature)).toBe(true);
    expect(sealVerdict(good, night, publicKey)).toBe('ok');
    // backup.sh's own lines are these.
    expect(backupSh).toContain(`printf 'menumesh seal 1 %s\\n%s\\n' "$night" "$base_line"`);
    expect(backupSh).toContain(`    printf 'part %s %s %s\\n' "$sum" "$sent" "$name"`);
    const noBase = parts.filter(({ name }) => !name.startsWith('base-'));
    const without = sealOf(sealText(night, undefined, noBase, privateKey), night);
    expect(typeof without === 'string' ? without : without.base).toBeUndefined();
  });

  it('refuses each text seal_open refuses, in its words', () => {
    const other = generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    const noBase = parts.filter(({ name }) => !name.startsWith('base-'));
    const cases: [string, string][] = [
      [
        sealText(night, base, parts, other),
        "is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys",
      ],
      [good.replace(' 7491 ', ' 7492 '), "is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys"],
      [
        sealText('2026-11-02T2030Z-0123abcd', base, parts, privateKey),
        `does not begin with the line "menumesh seal 1 ${night}"`,
      ],
      [sealText(night, base, [...parts, parts[0]], privateKey), 'lists a part twice'],
      [sealText(night, base, noBase, privateKey), 'has a base line that its parts do not match'],
      [
        sealText(night, undefined, parts, privateKey),
        'has a base line that its parts do not match',
      ],
      [
        sealText(
          night,
          base,
          [...parts, { ...parts[3], name: `template0-${night}.dump.age` }],
          privateKey,
        ),
        'has a line 9 that is not a part as a backup lists one',
      ],
      [
        signed(bodyOf(good).replace('part ', 'part  ')),
        'has a line 3 that is not a part as a backup lists one',
      ],
      [
        signed(bodyOf(good).replace(parts[0].sha256, parts[0].sha256.toUpperCase())),
        'has a line 3 that is not a part as a backup lists one',
      ],
      [
        signed(bodyOf(good).replace(base.walfile, base.walfile.toLowerCase())),
        'has no base line as a backup writes one',
      ],
      [
        signed(bodyOf(good).replace('\n', '\r\n')),
        'holds a byte that is not printable ASCII, or does not end in a newline',
      ],
      [
        `${good.slice(0, 20)}\0${good.slice(21)}`,
        'holds a byte that is not printable ASCII, or does not end in a newline',
      ],
      [good.slice(0, -1), 'holds a byte that is not printable ASCII, or does not end in a newline'],
      ['', 'is empty'],
      [
        `${good}${'#'.repeat(SEAL_MAX + 1 - good.length)}`,
        `is longer than a seal's ${SEAL_MAX} bytes`,
      ],
      [`${good.slice(0, -1)}==\n`, 'does not end in a signature line'],
      [bodyOf(good), 'does not end in a signature line'],
      [`menumesh seal 1 ${night}\nbase none\nsignature x\n`, 'has fewer lines than a seal'],
    ];
    for (const [text, problem] of cases) expect(sealVerdict(text, night, publicKey)).toBe(problem);
    // A seal as long as seal_max is still one.
    const padded = sealOf(`${good}`, night);
    expect(typeof padded).toBe('object');
  });

  it('names only the parts a night has', () => {
    for (const name of [
      `globals-${night}.sql.age`,
      `storage-${night}.tar.age`,
      `manifest-${night}.txt.age`,
      `config-${night}.tar.age`,
      `base-${night}.tar.zst.age`,
      `postgres-${night}.dump.age`,
      `_app_2-${night}.dump.age`,
    ]) {
      expect(sealPartName(name, night)).toBe(true);
    }
    for (const name of [
      `seal-${night}.txt`,
      `copy-${night}.txt`,
      `base-${night}.tar.age`,
      `template1-${night}.dump.age`,
      `Postgres-${night}.dump.age`,
      `-${night}.dump.age`,
      `${'a'.repeat(64)}-${night}.dump.age`,
      'globals-2026-11-02T2030Z-0123abcd.sql.age',
      `globals-${night}.sql.age.extra`,
    ]) {
      expect(sealPartName(name, night)).toBe(false);
    }
  });

  // The record of a month's copy (Stop C's re-review, the rest of finding S2), for the seal above.
  const record = recordText(night, good, privateKey);
  const otherNight = '2026-11-02T2030Z-4567cdef';
  const otherSeal = sealText(otherNight, base, parts, privateKey);

  it('writes a copy’s record in the lines backup.sh writes, the night and its seal’s sha256, signed', () => {
    const lines = record.split('\n');
    expect(lines.slice(0, 1)).toEqual([`menumesh copy 1 ${night} ${sum(good)}`]);
    expect(lines[1]).toMatch(/^signature [A-Za-z0-9_-]{86}$/);
    expect(lines).toHaveLength(3);
    expect(record.length).toBeLessThanOrEqual(RECORD_MAX);
    expect(recordMessage(night, good)).toBe(`${lines[0]}\n`);
    expect(recordVerdict(record, night, good, publicKey)).toBe('ok');
    const read = recordOf(record, night, good);
    if (typeof read === 'string') throw new Error(read);
    expect(read.message).toBe(`${lines[0]}\n`);
    expect(signedBy(publicKey, read.message, read.signature)).toBe(true);
    // backup.sh's own line and limits are these, and no other signed line begins as it does.
    expect(backupSh).toContain(`  printf 'menumesh copy 1 %s %s\\n' "$1" "$record_sum"`);
    expect(backupSh).toContain(`--head ${RECORD_MAX + 1} "$remote/monthly/copy-$1.txt"`);
    expect(backupSh).toContain(`$1 + 0 <= ${RECORD_MAX} { found = 1 }`);
    expect(walShipSh).toContain(`'menumesh wal 1 %s %s %s\\n'`);
    expect(sealSh).toContain(`printf 'menumesh seal probe %s\\n'`);
  });

  it('takes no record but the one of that night’s very seal, signed by a listed key', () => {
    const other = generateKeyPairSync('ed25519');
    const otherPrivate = other.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    const otherPublic = other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const message = record.slice(0, record.indexOf('signature '));
    const signature = record.slice(record.indexOf('signature ') + 10, -1);
    const notIts = "is not the record of that night's seal";
    const cases: [string, string][] = [
      ['planted, not a record\n', notIts],
      // Another night's record, renamed to this night's.
      [recordText(otherNight, otherSeal, privateKey), notIts],
      // This night's, signed by the backup's key, but over another seal.
      [recordText(night, otherSeal, privateKey), notIts],
      [recordText(night, good.replace(' 7491 ', ' 7492 '), privateKey), notIts],
      // This night's and its seal's, signed by another key.
      [
        recordText(night, good, otherPrivate),
        "is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys",
      ],
      [
        `${message}signature ${signature.slice(0, 85)}${signature[85] === 'A' ? 'B' : 'A'}\n`,
        "is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys",
      ],
      // Each other spelling of it.
      [record.replaceAll('\n', '\r\n'), notIts],
      [`${record}\n`, notIts],
      [record.slice(0, -1), notIts],
      [`${record.slice(0, -1)}==\n`, notIts],
      [`${message}signature  ${signature.slice(1)}\n`, notIts],
      [`${message}signature ${signature.slice(0, 40)}\n${signature.slice(41)}\n`, notIts],
      [record.replace('menumesh copy 1', 'menumesh copy 2'), notIts],
      [
        `${record}${'#'.repeat(RECORD_MAX + 1 - record.length)}`,
        `is longer than a record's ${RECORD_MAX} bytes`,
      ],
      ['', 'is empty'],
    ];
    for (const [text, problem] of cases) {
      expect(recordVerdict(text, night, good, publicKey)).toBe(problem);
    }
    // A rotation keeps the copies the old key recorded, as it keeps its seals: any listed key.
    expect(recordVerdict(record, night, good, `${otherPublic} ${publicKey}`)).toBe('ok');
    expect(recordVerdict(record, night, good, otherPublic)).toBe(
      "is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys",
    );
  });

  it('checks a restored signing pair with the backup’s own self-check, in one line between single quotes (Stop C’s re-review, finding V2)', () => {
    // The owner runs it as `sudo app-compose menumesh run --rm --no-deps -T backup sh -c '<it>'`:
    // nothing in it may end those quotes or be expanded by the owner's shell, and it prints a
    // fixed line, never a variable. It sources seal.sh where the image installs it, and its
    // seal_self_check is the one backup.sh and wal-ship.sh run before they sign anything.
    expect(SIGNING_PAIR_CHECK).not.toMatch(/['`$\\!\n]/);
    expect(pairCheckShape(SIGNING_PAIR_CHECK)).toEqual([]);
    expect(kit('backup/Dockerfile')).toContain(
      'COPY --chmod=644 counts.sql seal.sh /usr/local/share/menumesh/',
    );
    for (const helper of ['seal_public_keys_ok', 'seal_private_key_ok', 'seal_self_check']) {
      expect(kit('backup/seal.sh')).toContain(`\n${helper}() {\n`);
    }
    for (const script of ['backup.sh', 'wal-ship.sh']) {
      expect(code(kit(`backup/${script}`)).some((line) => line.includes('seal_self_check'))).toBe(
        true,
      );
    }
    // As before the re-review (finding U4): the self-check alone, so a list that is no list of
    // keys, which checks no probe, was blamed on the private key.
    const selfCheckAlone =
      /^\. \/usr\/local\/share\/menumesh\/seal\.sh; (?:seal_public_keys_ok \|\| \{ echo "[^"]+" >&2; exit 1; \}; )(?:seal_private_key_ok \|\| \{ echo "[^"]+" >&2; exit 1; \}; )/;
    const today = SIGNING_PAIR_CHECK.replace(
      selfCheckAlone,
      '. /usr/local/share/menumesh/seal.sh; ',
    );
    expect(today).not.toBe(SIGNING_PAIR_CHECK);
    refuses(pairCheckShape, today, 'a list that is no list of keys is not named');
    refuses(pairCheckShape, today, 'a private key that is no key is not named');
    // The private key held to its shape before the list, so a night with both wrong names the key.
    const keyFirst = SIGNING_PAIR_CHECK.replace(
      /(seal_public_keys_ok \|\| \{ echo "[^"]+" >&2; exit 1; \}; )(seal_private_key_ok \|\| \{ echo "[^"]+" >&2; exit 1; \}; )/,
      '$2$1',
    );
    refuses(pairCheckShape, keyFirst, 'a list that is no list of keys is not named');
    // A line that blames the private key for the list, or names no value.
    refuses(
      pairCheckShape,
      SIGNING_PAIR_CHECK.replace(
        'BACKUP_SIGNING_PUBLIC_KEY is not one Ed25519 public key or several',
        'BACKUP_SIGNING_KEY does not sign what the list checks',
      ),
      'a list that is no list of keys is not named',
    );
  });

  it('names the signing value that is no key, as the restores name it, before the backup or the shipper signs anything (Stop C’s re-review, finding U4)', () => {
    expect(signingShapes(backupSh, walShipSh)).toEqual([]);
    // As before the re-review: the self-check alone, which blamed the private key for a list that
    // is no list of keys.
    const backupKeys = backupSh.slice(
      backupSh.indexOf('seal_public_keys_ok ||\n'),
      backupSh.indexOf('seal_self_check ||\n'),
    );
    const todaysBackup = swap(backupSh, backupKeys, '');
    refuses(
      (text) => signingShapes(text, walShipSh),
      todaysBackup,
      'backup.sh doesn’t name BACKUP_SIGNING_PUBLIC_KEY',
    );
    refuses(
      (text) => signingShapes(text, walShipSh),
      todaysBackup,
      'backup.sh doesn’t name BACKUP_SIGNING_KEY',
    );
    const shipKeys = walShipSh.slice(
      walShipSh.indexOf('  if ! seal_public_keys_ok; then\n'),
      walShipSh.indexOf('  elif ! seal_self_check 2>"$work/tool"; then\n'),
    );
    const todaysShip = swap(
      swap(walShipSh, shipKeys, ''),
      '  elif ! seal_self_check 2>"$work/tool"; then\n',
      '  if ! seal_self_check 2>"$work/tool"; then\n',
    );
    refuses(
      (text) => signingShapes(backupSh, text),
      todaysShip,
      'wal-ship.sh doesn’t name BACKUP_SIGNING_PUBLIC_KEY',
    );
    refuses(
      (text) => signingShapes(backupSh, text),
      todaysShip,
      'wal-ship.sh doesn’t name BACKUP_SIGNING_KEY',
    );
    // The key's shape after the self-check, which then speaks first.
    refuses(
      (text) => signingShapes(text, walShipSh),
      swap(
        swap(backupSh, backupKeys, ''),
        '  fail "BACKUP_SIGNING_KEY does not sign what BACKUP_SIGNING_PUBLIC_KEY\'s first key checks, so no night could be sealed: nothing was uploaded"\n',
        `  fail "BACKUP_SIGNING_KEY does not sign what BACKUP_SIGNING_PUBLIC_KEY's first key checks, so no night could be sealed: nothing was uploaded"\n${backupKeys}`,
      ),
      'backup.sh doesn’t name BACKUP_SIGNING_PUBLIC_KEY',
    );
  });
});

// --- CI ---

/** The jobs of a workflow: each name with its lines. */
function jobs(text: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  let inJobs = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) inJobs = line.startsWith('jobs:');
    else if (inJobs) {
      const name = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1];
      if (name) found.set(name, (current = []));
      else current?.push(line);
    }
  }
  return found;
}
const jobIf = (text: string, job: string) =>
  /^ {4}if: (.*)$/m.exec((jobs(text).get(job) ?? []).join('\n'))?.[1] ?? '';
/** The events a workflow runs on. */
const triggers = (text: string) => {
  const start = text.split('\n').indexOf('on:');
  const lines = text.split('\n').slice(start + 1);
  const end = lines.findIndex((line) => /^\S/.test(line));
  return lines
    .slice(0, end)
    .map((line) => /^ {2}([a-z_]+):/.exec(line)?.[1])
    .filter((name) => name !== undefined);
};

/** Every image build is labelled with the tag it pushes, which app-deploy checks (VPS-41). */
const labels = (text: string) => {
  const steps = text
    .split(/\n(?= {6}- )/)
    .filter((step) => step.includes('uses: docker/build-push-action@'));
  return [
    ...(steps.length ? [] : ['no build-push-action']),
    ...steps.flatMap((step) => {
      const label =
        /^ {10}labels: org\.opencontainers\.image\.version=(\$\{\{ steps\.names\.outputs\.\w+ \}\})$/m.exec(
          step,
        )?.[1];
      const tags = /^ {10}tags: (.+)$/m.exec(step)?.[1] ?? '';
      if (!label) return [`a build without the version label: ${tags}`];
      const sameTag =
        tags.endsWith(`:${label}`) ||
        (tags === '${{ steps.names.outputs.image }}' &&
          label === '${{ steps.names.outputs.tag }}' &&
          text.includes('echo "image=ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/menumesh:$tag"'));
      return sameTag ? [] : [`the label ${label} is not the tag of ${tags}`];
    }),
  ];
};

/** The checks of the tags the server accepts (its conf's TAG and EXTRA_TAG), before every push or deploy. */
const TAG_CHECKS = [
  ['vps-build.yml', "pattern='^staging-[0-9a-f]{40}$'"],
  ['vps-build.yml', "pattern='^prod-v[0-9]+\\.[0-9]+\\.[0-9]+$'"],
  ['vps-build.yml', '[[ "$tag" =~ $pattern ]]'],
  ['vps-build.yml', '[[ "$migrate_tag" =~ ^migrate-[0-9a-f]{40}$ ]]'],
  ['vps-backup-image.yml', '[[ "$tag" =~ ^backup-[0-9a-f]{40}$ ]]'],
  ['vps-deploy-staging.yml', '[[ "$WEB" =~ ^staging-[0-9a-f]{40}@sha256:[0-9a-f]{64}$ ]]'],
  ['vps-deploy-staging.yml', '[[ "$MIGRATE" =~ ^migrate-[0-9a-f]{40}@sha256:[0-9a-f]{64}$ ]]'],
] as const;
const tagChecks = (files: Record<string, string>) =>
  TAG_CHECKS.filter(([file, check]) => !code(files[file]).some((line) => line.includes(check))).map(
    ([file, check]) => `${file} has no ${check}`,
  );

describe('the VPS workflows', () => {
  const build = workflow('vps-build.yml');
  const backupImage = workflow('vps-backup-image.yml');
  const deploy = workflow('vps-deploy-staging.yml');
  const ping = workflow('vps-ping.yml');
  const release = workflow('vps-release.yml');
  const ci = workflow('ci.yml');

  it('labels every image with the tag it is pushed under', () => {
    expect(labels(build)).toEqual([]);
    expect(labels(backupImage)).toEqual([]);
    expect(
      [...build.matchAll(/uses: docker\/build-push-action@/g)].length +
        [...backupImage.matchAll(/uses: docker\/build-push-action@/g)].length,
    ).toBe(3);
    refuses(
      labels,
      swap(
        build,
        '          labels: org.opencontainers.image.version=${{ steps.names.outputs.migrate_tag }}\n',
        '',
      ),
      'without the version label',
    );
    refuses(
      labels,
      swap(
        build,
        'version=${{ steps.names.outputs.migrate_tag }}',
        'version=${{ steps.names.outputs.tag }}',
      ),
      'is not the tag of',
    );
  });

  it('checks every tag against the patterns the server accepts', () => {
    const files = {
      'vps-build.yml': build,
      'vps-backup-image.yml': backupImage,
      'vps-deploy-staging.yml': deploy,
    };
    expect(tagChecks(files)).toEqual([]);
    expect(
      tagChecks({
        ...files,
        'vps-build.yml': swap(build, "'^staging-[0-9a-f]{40}$'", "'^staging-[0-9a-f]{7}$'"),
      }),
    ).toEqual(["vps-build.yml has no pattern='^staging-[0-9a-f]{40}$'"]);
    expect(
      tagChecks({
        ...files,
        'vps-deploy-staging.yml': swap(deploy, '[[ "$MIGRATE" =~ ^migrate-', '[[ "$MIGRATE" =~ ^'),
      }),
    ).toHaveLength(1);
  });

  it('spends no minutes until the owner turns the two repository variables on', () => {
    const gates = (files: Record<string, string>) => [
      ...(jobIf(files.ci, 'vps-build').includes("vars.VPS_IMAGES == 'true'")
        ? []
        : ['ci vps-build']),
      ...(jobIf(files.ci, 'vps-staging').includes("vars.VPS_IMAGES == 'true'") &&
      jobIf(files.ci, 'vps-staging').includes("vars.VPS_DEPLOY_STAGING == 'true'")
        ? []
        : ['ci vps-staging']),
      ...(jobIf(files.ci, 'staging').includes("vars.VPS_DEPLOY_STAGING != 'true'")
        ? []
        : ['ci staging']),
      ...(jobIf(files.release, 'check') === "vars.VPS_IMAGES == 'true'" &&
      (jobs(files.release).get('build') ?? []).includes('    needs: check')
        ? []
        : ['vps-release']),
      ...(jobIf(files.backupImage, 'build').startsWith("vars.VPS_IMAGES == 'true'")
        ? []
        : ['vps-backup-image']),
      ...(JSON.stringify(triggers(files.build)) === '["workflow_call"]'
        ? []
        : ['vps-build runs on its own']),
      ...(JSON.stringify(triggers(files.deploy)) === '["workflow_call"]'
        ? []
        : ['vps-deploy-staging runs on its own']),
      ...(JSON.stringify(triggers(files.release)) === '["workflow_dispatch"]'
        ? []
        : ['vps-release runs on its own']),
      ...(JSON.stringify(triggers(files.ping)) === '["workflow_dispatch"]'
        ? []
        : ['vps-ping runs on its own']),
    ];
    const files = { ci, release, backupImage, build, deploy, ping };
    expect(gates(files)).toEqual([]);
    expect(gates({ ...files, ci: swap(ci, "&& vars.VPS_IMAGES == 'true'\n", '\n') })).toContain(
      'ci vps-build',
    );
    expect(gates({ ...files, ci: swap(ci, "&& vars.VPS_DEPLOY_STAGING != 'true'", '') })).toContain(
      'ci staging',
    );
    expect(
      gates({ ...files, release: swap(release, "    if: vars.VPS_IMAGES == 'true'\n", '') }),
    ).toContain('vps-release');
    expect(
      gates({
        ...files,
        deploy: swap(deploy, 'on:\n  workflow_call:', 'on:\n  push:\n  workflow_call:'),
      }),
    ).toContain('vps-deploy-staging runs on its own');
  });

  it('installs the pinned cloudflared, checked by its sha256, and keeps the SSH session alive', () => {
    const tunnel = (text: string) => [
      ...(text.includes(
        'https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-linux-amd64',
      )
        ? []
        : ['not cloudflared 2026.9.3']),
      ...(text.includes(
        'echo "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2  /tmp/cloudflared" | sha256sum -c -',
      )
        ? []
        : ['cloudflared is not checked by its sha256']),
      ...(/-o ServerAliveInterval=30\b/.test(text) ? [] : ['no ServerAliveInterval=30']),
    ];
    // The deploy waits on the server's health gate and the migrations: 45 minutes at most.
    const deployTimeout = (text: string) =>
      /^ {4}timeout-minutes: 45$/m.test((jobs(text).get('deploy') ?? []).join('\n'))
        ? []
        : ['the deploy job has no 45-minute timeout'];
    expect(tunnel(deploy)).toEqual([]);
    expect(tunnel(ping)).toEqual([]);
    expect(deployTimeout(deploy)).toEqual([]);
    refuses(
      tunnel,
      swap(deploy, '77e26d8d900e0b84', '77e26d8d900e0b85'),
      'not checked by its sha256',
    );
    refuses(
      tunnel,
      swap(ping, '-o ServerAliveInterval=30', '-o ServerAliveInterval=300'),
      'no ServerAliveInterval=30',
    );
    refuses(
      deployTimeout,
      swap(deploy, '    timeout-minutes: 45\n', '    timeout-minutes: 360\n'),
      '45-minute timeout',
    );
  });
});

// --- copies kept byte for byte ---

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** What differs from a list of `<sha256>  <file>` lines: a changed, missing or unlisted file. */
/**
 * config/db/pg_hba.conf is the image's /etc/postgresql/pg_hba.conf byte for byte, the sha256
 * SOURCES.md lists for it, with one line added at the end: the backup's replication connection
 * (VPS-43). The rehearsal compares it with the image's own file too.
 */
const REPLICATION_LINE = 'host replication supabase_admin samenet scram-sha-256';
const hbaPin = (file: Buffer, sources: string) => {
  const listed =
    /^\| `db\/pg_hba\.conf` +\| `\/etc\/postgresql\/pg_hba\.conf` +\| `([0-9a-f]{64})` \|$/m.exec(
      sources,
    )?.[1];
  const ending = Buffer.from(`\n${REPLICATION_LINE}\n`);
  const upstream = file.subarray(0, file.length - ending.length + 1);
  const ends = file.length > ending.length && file.subarray(-ending.length).equals(ending);
  return [
    ...(ends ? [] : [`the last line is not "${REPLICATION_LINE}"`]),
    ...(ends && listed !== undefined && sha256(upstream) === listed
      ? []
      : ['without its last line the file is not the image’s, as SOURCES.md lists it']),
  ];
};

const unlike = (sums: [string, string][], files: Record<string, Buffer>) => [
  ...sums
    .filter(([sum, name]) => !files[name] || sha256(files[name]) !== sum)
    .map(([, name]) => `${name} changed`),
  ...Object.keys(files)
    .filter((name) => !sums.some(([, listed]) => listed === name))
    .map((name) => `${name} is not listed`),
];

describe('copies kept byte for byte', () => {
  it('keeps the server team’s files as SOURCE lists them', () => {
    const sums = [
      ...readFileSync(join(VENDOR, 'SOURCE'), 'utf8').matchAll(/^([0-9a-f]{64}) {2}(\S+)$/gm),
    ].map((m) => [m[1], m[2]] as [string, string]);
    const files = Object.fromEntries(
      readdirSync(VENDOR)
        .filter((name) => name !== 'SOURCE')
        .map((name) => [name, readFileSync(join(VENDOR, name))]),
    );
    expect(sums.length).toBeGreaterThanOrEqual(5);
    expect(unlike(sums, files)).toEqual([]);
    expect(unlike(sums, { ...files, Caddyfile: Buffer.from(`${files.Caddyfile}\n`) })).toEqual([
      'Caddyfile changed',
    ]);
    expect(unlike(sums, { ...files, extra: Buffer.from('x') })).toEqual(['extra is not listed']);
  });

  it('keeps the verbatim init SQL as SOURCES.md lists it', () => {
    const sums = [
      ...kit('config/SOURCES.md').matchAll(
        /^\| `(db\/[a-z]+\.sql)` +\| [^|]+\| `([0-9a-f]{64})` \|$/gm,
      ),
    ].map((m) => [m[2], m[1]] as [string, string]);
    const files = Object.fromEntries(
      readdirSync(join(KIT, 'config', 'db'))
        .filter((name) => name.endsWith('.sql'))
        .map((name) => [`db/${name}`, readFileSync(join(KIT, 'config', 'db', name))]),
    );
    expect(sums).toHaveLength(4);
    expect(unlike(sums, files)).toEqual([]);
    expect(unlike(sums, { ...files, 'db/jwt.sql': Buffer.from('-- changed\n') })).toEqual([
      'db/jwt.sql changed',
    ]);
  });

  it('keeps db’s host rules as the image’s file and the one line, as SOURCES.md lists it', () => {
    const hba = readFileSync(join(KIT, 'config', 'db', 'pg_hba.conf'));
    const sources = kit('config/SOURCES.md');
    expect(hbaPin(hba, sources)).toEqual([]);
    const text = hba.toString('utf8');
    const bad = (changed: string) => hbaPin(Buffer.from(changed), sources).join('\n');
    expect(bad(swap(text, '# IPv6 external connections', '# IPv6 connections'))).toContain(
      'not the image’s',
    );
    expect(bad(`${text}host all all all trust\n`)).toContain('the last line is not');
    expect(bad(text.replace(REPLICATION_LINE, 'host replication all all trust'))).toContain(
      'the last line is not',
    );
  });
});

// --- the kit check: scripts/vps-kit.mts and deploy/vps/test ---

const conf = kit('test/menumesh.conf');
/** A value of the conf, as the shell reads it: NAME=value, NAME="value" or NAME='value'. */
const confValue = (text: string, name: string) => {
  const match = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)'|([^\\s#]*))`, 'm').exec(text);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
};
/** The aliases each service has on an edge network: "<service> <network> <alias>". */
const edgeAliases = (text: string) =>
  [...services(text)].flatMap(([name, service]) =>
    [
      ...(key(service, 'networks') ?? [])
        .join('\n')
        .matchAll(/^ {6}(edge-[a-z-]+):\n {8}aliases: \[([^\]]*)\]$/gm),
    ].flatMap((m) => m[2].split(',').map((alias) => `${name} ${m[1]} ${alias.trim()}`)),
  );
const VPS_WORKFLOWS = ['vps-build.yml', 'vps-backup-image.yml', 'vps-deploy-staging.yml'].map(
  (name) => workflow(name),
);

/**
 * /etc/apps/menumesh.conf as the kit check installs it (and the RUNBOOK asks the admin to write
 * it) fits the kit: its upstreams are the edge aliases and the site's proxies, its edge networks
 * the compose file's, each deploy target a service running its images.env variable, and each tag
 * one CI checks before it pushes. app-deploy reads most of it, and that only runs on the server.
 */
const serverConf = (text: string, composeText = compose) => {
  const upstreams = (confValue(text, 'UPSTREAMS') ?? '').split(' ').filter(Boolean);
  const aliases = edgeAliases(composeText).map((line) => line.split(' ')[2]);
  const external = [
    ...composeText
      .slice(composeText.indexOf('\nnetworks:\n'))
      .matchAll(/^ {2}([a-z0-9-]+):\n {4}external: true$/gm),
  ].map((m) => m[1]);
  const targets = [...text.matchAll(/\b(?:MIGRATE_)?SERVICE=(\S+) (?:MIGRATE_)?VAR=(\S+)/g)];
  const tags = [...text.matchAll(/\b(?:EXTRA_)?TAG='([^']+)'/g)].map((m) => m[1]);
  return [
    ...(JSON.stringify(upstreams.map((entry) => entry.split(':')[0]).sort()) ===
    JSON.stringify([...aliases].sort())
      ? []
      : [`UPSTREAMS ${upstreams.join(' ')} are not the edge aliases ${aliases.join(' ')}`]),
    ...upstreams
      .filter((entry) => !site.includes(`\treverse_proxy ${entry} {\n`))
      .map((entry) => `the site proxies to no ${entry}`),
    ...(confValue(text, 'EDGE_NETWORKS') === external.join(' ')
      ? []
      : [`EDGE_NETWORKS is not ${external.join(' ')}`]),
    ...(targets.length === 5 ? [] : [`${targets.length} deploy targets, not 5`]),
    ...targets
      .filter(
        ([, service, variable]) =>
          value(services(composeText).get(service) ?? [], 'image') !==
            `\${${variable}:?set ${variable} in images.env}` ||
          !templateNames(kit('env/images.env.example')).includes(variable),
      )
      .map(([, service, variable]) => `${service} does not run ${variable} from images.env`),
    ...(tags.length === 4 ? [] : [`${tags.length} tags, not 4`]),
    ...tags
      .filter(
        (tag) =>
          !VPS_WORKFLOWS.some((file) => code(file).some((line) => line.includes(`^${tag}$`))),
      )
      .map((tag) => `no workflow checks ^${tag}$`),
    ...(services(composeText).has((confValue(text, 'PREDEPLOY_DB') ?? '').split(' ')[0])
      ? []
      : ['PREDEPLOY_DB names no service']),
    ...(confValue(text, 'ZONE') === 'menumesh.in' && confValue(text, 'ENV_PREFIX') === 'MENUMESH_'
      ? []
      : ['ZONE or ENV_PREFIX is not menumesh.in, MENUMESH_']),
  ];
};

/**
 * The RUNBOOK gives the server's admin the conf as one sh block, which must be test/menumesh.conf
 * without its header: the values the kit check ran with are the ones the server gets.
 */
const runbookConf = (runbook: string, confText = conf) => {
  const blocks = [...runbook.matchAll(/^```sh\n([\s\S]*?)^```$/gm)]
    .map((match) => match[1])
    .filter((block) => /^PROJECT_DIR=/m.test(block));
  if (blocks.length !== 1) return [`the RUNBOOK has ${blocks.length} conf blocks, not 1`];
  const lines = confText.split('\n');
  const want = lines.slice(lines.findIndex((line) => !line.startsWith('#')));
  const have = blocks[0].split('\n');
  const at = [...Array(Math.max(want.length, have.length)).keys()].find(
    (index) => want[index] !== have[index],
  );
  return at === undefined
    ? []
    : [
        `line ${at + 1} of the RUNBOOK's conf block is ${JSON.stringify(have[at] ?? '')}, ` +
          `test/menumesh.conf has ${JSON.stringify(want[at] ?? '')}`,
      ];
};

describe('the kit check (scripts/vps-kit.mts, deploy/vps/test)', () => {
  it('is the conf the RUNBOOK gives the server’s admin, line for line', () => {
    const runbook = readFileSync(join('docs', 'RUNBOOK.md'), 'utf8');
    expect(runbookConf(runbook)).toEqual([]);
    refuses(runbookConf, swap(runbook, '\nLOG_REDACT=1\n', '\nLOG_REDACT=0\n'), 'LOG_REDACT=0');
    refuses(
      runbookConf,
      swap(runbook, '\nPROJECT_DIR=/srv/menumesh\n', '\nPROJECT=/srv/menumesh\n'),
      'the RUNBOOK has 0 conf blocks, not 1',
    );
    refuses((text) => runbookConf(runbook, text), `${conf}EXTRA_KEEP=5\n`, 'EXTRA_KEEP=5');
  });

  it('installs a menumesh.conf that fits the compose file, the site file and CI', () => {
    expect(serverConf(conf)).toEqual([]);
    refuses(
      serverConf,
      swap(conf, 'SERVICE=web VAR=WEB_IMAGE', 'SERVICE=web VAR=WEB_IMG'),
      'web does not run WEB_IMG from images.env',
    );
    refuses(
      serverConf,
      swap(conf, ' menumesh-gw:8000', ''),
      'UPSTREAMS menumesh-web:3000 menumesh-web-staging:3000 are not the edge aliases',
    );
    refuses(serverConf, swap(conf, 'menumesh-gw:8000', 'menumesh-gw:8080'), 'no menumesh-gw:8080');
    refuses(
      serverConf,
      swap(conf, "TAG='staging-[0-9a-f]{40}'", "TAG='staging-[0-9a-f]{7}'"),
      'no workflow checks ^staging-[0-9a-f]{7}$',
    );
    refuses(
      (text) => serverConf(conf, text),
      swapIn(compose, 'web', '        aliases: [menumesh-web]', '        aliases: [menumesh-app]'),
      'are not the edge aliases',
    );
    refuses(serverConf, swap(conf, '"db supabase_admin', '"postgres supabase_admin'), 'PREDEPLOY');
  });

  it('lints the crontabs as BusyBox crond reads them, against what the scheduler mounts', () => {
    const jobsKnown = cronCallJobs(cronCall);
    expect(jobsKnown).toEqual(['daily', 'daily-retry', 'digest', 'digest-retry', 'jobs']);
    const mounted = serviceMounts(services(compose).get('scheduler') ?? []);
    expect(mounted).toContainEqual(['./config/scheduler/production.crontab', '/etc/crontabs/root']);
    const targets = mounted.map(([, target]) => target);
    const lint = (text: string) => lintCrontab(text, targets, jobsKnown);
    const production = kit('config/scheduler/production.crontab');
    expect(lint(production)).toEqual([]);
    expect(lint(kit('config/scheduler/staging.crontab'))).toEqual([]);
    refuses(lint, swap(production, '30 21 * * *', '60 21 * * *'), 'the minute field 60');
    refuses(lint, swap(production, '15 3 * * *', '15 3 * * 8'), 'the day of the week field 8');
    refuses(lint, `CRON_SECRET=x\n${production}`, 'BusyBox crond takes no variables');
    refuses(
      lint,
      swap(production, 'cron-call daily\n', 'cron-call weekly\n'),
      'knows no job weekly',
    );
    refuses(
      lint,
      swap(production, '/opt/menumesh/cron-call jobs', '/opt/menumesh/other jobs'),
      '/opt/menumesh/other is not mounted',
    );
    refuses(lint, swap(production, '* * * * * /bin/sh', '* * * * /bin/sh'), 'day of the week');
    refuses(lint, '# nothing\n', 'no job at all');
  });

  it('runs Caddy with the flags of app-apply’s own caddy_run', () => {
    const appApply = readFileSync(join(VENDOR, 'app-apply'), 'utf8');
    const paths = { config: '/w/tree', certs: '/w/certs', envFile: '/w/edge.docker' };
    expect(caddyRunArgs(appApply, paths, 'caddy:test', ['validate'])).toEqual([
      ...['run', '--rm', '--network', 'none', '--log-driver', 'none', '--read-only'],
      ...['--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE'],
      ...['--security-opt', 'no-new-privileges:true', '--label', 'kit.throwaway=1'],
      ...['--cpus', '0.5', '--memory', '256m', '--memory-swap', '256m', '--pids-limit', '256'],
      ...['--tmpfs', '/tmp:size=16m', '--tmpfs', '/data:size=16m', '--tmpfs', '/config:size=16m'],
      ...['--env-file', '/w/edge.docker'],
      ...['--mount', 'type=bind,source=/w/tree,target=/etc/caddy,readonly'],
      ...['--mount', 'type=bind,source=/w/certs,target=/certs,readonly'],
      ...['--entrypoint', 'caddy', 'caddy:test', 'validate'],
    ]);
    expect(() =>
      caddyRunArgs(
        swap(appApply, 'local config=$1 certs=$2 envf=$3', 'local dir=$1 certs=$2 envf=$3'),
        paths,
        'caddy:test',
        [],
      ),
    ).toThrow('no caddy_run of the known shape');
    expect(() =>
      caddyRunArgs(
        swap(appApply, '--label kit.throwaway=1', '--label kit.throwaway=1 -v "$HOME:/home"'),
        paths,
        'caddy:test',
        [],
      ),
    ).toThrow('caddy_run uses $HOME');
  });

  it('validates the gateway as start.sh fills it in, with every resource inline', () => {
    const names = envoyKeyNames(envoyStart);
    expect(names).toHaveLength(6);
    const keys = Object.fromEntries(names.map((name) => [name, `test-${name.toLowerCase()}`]));
    const listeners = renderListeners(lds, keys);
    expect(listeners).not.toMatch(/\$\{[A-Z_]/);
    expect(listeners).toContain('test-supabase_secret_key');
    const fewer = Object.fromEntries(Object.entries(keys).filter(([name]) => name !== 'ANON_KEY'));
    expect(() => renderListeners(lds, fewer)).toThrow(
      '${ANON_KEY}, which start.sh does not fill in',
    );
    const bootstrap = envoyBootstrap(envoyYaml, listeners, cds);
    expect(bootstrap).not.toContain('dynamic_resources');
    expect(bootstrap).not.toContain("'@type': type.googleapis.com/envoy.config.");
    expect(bootstrap).toMatch(/^static_resources:\n {2}listeners:\n {4}-$/m);
    expect(bootstrap.match(/^ {4}-$/gm)).toHaveLength(5);
    expect(bootstrap).toContain('\nadmin:\n');
    expect(() => envoyBootstrap(envoyYaml, 'kind: nothing\n', cds)).toThrow('no resources:');
    expect(() =>
      envoyBootstrap(envoyYaml, listeners, cds.replace("  - '@type'", '  - "@type"')),
    ).toThrow("has no '@type' first");
  });
});

// --- the local rehearsal: deploy/vps/local and scripts/vps-kit.mts ---

// The override pnpm vps:rehearse puts on top of compose.yml on a development machine. It is never
// installed: app-apply would refuse it (another project name, published ports), and these rules
// keep it a stand-in that can't reach beyond this machine.
const rehearsal = kit('local/compose.rehearsal.yml');

/** Published only on 127.0.0.1, and only the app (3300) and the gateway (8300). */
function localPorts(text: string): string[] {
  const published = [...services(text)].flatMap(([name, service]) => {
    const ports = key(service, 'ports');
    if (!ports) return [];
    const one =
      ports.length === 1 ? /^ {4}ports: \['(127\.0\.0\.1:\d+:\d+)'\]$/.exec(ports[0]) : null;
    return [one ? `${name} ${one[1]}` : `${name} ${ports.map((line) => line.trim()).join(' ')}`];
  });
  const wanted = ['web 127.0.0.1:3300:3000', 'api-gw 127.0.0.1:8300:8000'];
  return [
    ...published.filter((entry) => !wanted.includes(entry)).map((entry) => `publishes ${entry}`),
    ...wanted
      .filter((entry) => !published.includes(entry))
      .map((entry) => `does not publish ${entry}`),
  ];
}

/** compose.yml's staging services: those on a staging network. */
const stagingServices = (composeText: string) =>
  [...services(composeText)]
    .filter(([, service]) =>
      (key(service, 'networks') ?? []).some((line) => /\bstaging\b/.test(line)),
    )
    .map(([name]) => name);

/** Each staging service is behind the staging profile alone, which the rehearsal never turns on. */
const stagingOff = (text: string, composeText = compose) =>
  stagingServices(composeText)
    .filter((name) => value(services(text).get(name) ?? [], 'profiles') !== '!override [staging]')
    .map((name) => `${name} is not behind the staging profile alone`);

/** The rehearsal's db runs the server's command, with shared_buffers=128MB for Docker Desktop. */
function dbCommand(text: string, composeText = compose): string[] {
  const server = key(services(composeText).get('db') ?? [], 'command') ?? [];
  const local = key(services(text).get('db') ?? [], 'command') ?? [];
  if (!server.some((line) => line.endsWith('- shared_buffers=480MB'))) {
    return ['compose.yml’s db has no shared_buffers=480MB'];
  }
  const expected = server.map((line) =>
    line.replace(/- shared_buffers=480MB$/, '- shared_buffers=128MB'),
  );
  return JSON.stringify(local) === JSON.stringify(expected)
    ? []
    : [
        `the override’s db command is not the server’s with shared_buffers=128MB: ${local
          .filter((line) => !expected.includes(line))
          .concat(expected.filter((line) => !local.includes(line)))
          .map((line) => line.trim())
          .join(', ')}`,
      ];
}

/** Its own project, edge networks and an internal bucket network, and a stand-in S3 pinned there. */
function localNetworks(text: string): string[] {
  const block = text.slice(text.indexOf('\nnetworks:\n'));
  const s3 = services(text).get('s3') ?? [];
  return [
    ...(/^name: menumesh-rehearsal$/m.test(text) ? [] : ['the project is not menumesh-rehearsal']),
    ...['edge-menumesh', 'edge-menumesh-staging']
      .filter((name) => !new RegExp(`^ {2}${name}:\\n {4}external: false$`, 'm').test(block))
      .map((name) => `${name} is not the project’s own network`),
    ...(/^ {2}bucket:\n {4}internal: true$/m.test(block) ? [] : ['bucket is not internal']),
    ...(value(s3, 'networks') === '[bucket]' ? [] : ['s3 is not on the bucket network alone']),
    ...(/^rclone\/rclone:[\d.]+@sha256:[0-9a-f]{64}$/.test(value(s3, 'image') ?? '')
      ? []
      : ['s3 is not rclone pinned by digest']),
  ];
}

/**
 * Every third-party host the code names: the providers' defaults (src/lib/env.server.ts, which
 * also holds MenuMesh's own public hosts), PostHog's API and assets hosts in both regions, and
 * the backup's alerts (notify.sh).
 */
const THIRD_PARTY = [
  ...[
    ...readFileSync('src/lib/env.server.ts', 'utf8').matchAll(
      /urlWithDefault\('(https?:[^']+)'\)/g,
    ),
  ].map((match) => new URL(match[1]).hostname),
  ...['https://us.i.posthog.com', 'https://eu.i.posthog.com'].flatMap((api) =>
    Object.values(posthogHosts(api)).map((url) => new URL(url).hostname),
  ),
  ...[...kit('backup/notify.sh').matchAll(/https:\/\/([a-z0-9.-]+)\//g)].map((match) => match[1]),
];

/** Each of them resolves to 0.0.0.0 in the containers that have a way out: web, scheduler, backup. */
function sinkhole(text: string): string[] {
  const block = /^x-sinkhole: &sinkhole\n((?: {2}\S+: \S+\n)+)/m.exec(text)?.[1] ?? '';
  const hosts = new Map([...block.matchAll(/^ {2}(\S+): (\S+)$/gm)].map((m) => [m[1], m[2]]));
  return [
    ...THIRD_PARTY.filter((host) => hosts.get(host) !== '0.0.0.0').map(
      (host) => `${host} is not sent to the sinkhole`,
    ),
    ...[...hosts]
      .filter(([, address]) => address !== '0.0.0.0')
      .map(([host, address]) => `${host} goes to ${address}`),
    ...['web', 'scheduler', 'backup']
      .filter((name) => value(services(text).get(name) ?? [], 'extra_hosts') !== '*sinkhole')
      .map((name) => `${name} does not use the sinkhole`),
  ];
}

/** What the server gets from this folder (every file but local/, the vendored copies and the README), and CI. */
const installed = () => [
  ...readdirSync(KIT, { recursive: true, encoding: 'utf8' })
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => !/^(local|test\/vendor)(\/|$)|^README\.md$/.test(path))
    .filter((path) => !/\.(crt|pem|key)$/.test(path))
    .flatMap((path) => {
      try {
        return [[`deploy/vps/${path}`, kit(path)] as const];
      } catch {
        return []; // a folder
      }
    }),
  ...readdirSync(join('.github', 'workflows')).map(
    (name) => [`.github/workflows/${name}`, workflow(name)] as const,
  ),
];

/** Nothing the server or CI gets names the override; the README says it is never installed. */
const neverInstalled = (files: readonly (readonly [string, string])[], readme: string) => [
  ...files
    .filter(([, text]) => /deploy\/vps\/local|compose\.rehearsal|(^|[\s'"`(])local\//m.test(text))
    .map(([path]) => `${path} names the local override`),
  ...readme
    .split('\n')
    .filter((line) => /`local\/`|local\/compose/.test(line) && !/never installed/.test(line))
    .map((line) => `README: ${line.trim()}`),
];

/** A schema-only dump of two functions, in pg_dump's layout. */
const DUMP = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  '\\restrict AbCd1234',
  '',
  '-- Dumped from database version 17.6',
  '-- Dumped by pg_dump version 17.6',
  '',
  "SET client_encoding = 'UTF8';",
  '',
  '--',
  '-- Name: one(); Type: FUNCTION; Schema: public; Owner: postgres',
  '--',
  '',
  'CREATE FUNCTION public.one() RETURNS integer',
  '    LANGUAGE sql',
  '    AS $$',
  '  select 1',
  '  where true',
  '$$;',
  '',
  '--',
  '-- Name: two(); Type: FUNCTION; Schema: private; Owner: postgres',
  '--',
  '',
  'CREATE FUNCTION private.two() RETURNS integer',
  '    LANGUAGE sql',
  '    AS $$ select 2 $$;',
  '',
  '\\unrestrict AbCd1234',
  '',
].join('\n');

describe('the local rehearsal (deploy/vps/local, scripts/vps-kit.mts)', () => {
  it('publishes only the app and the gateway, and only on 127.0.0.1', () => {
    expect(localPorts(rehearsal)).toEqual([]);
    refuses(localPorts, swap(rehearsal, "['127.0.0.1:3300:3000']", "['3300:3000']"), 'web');
    refuses(localPorts, swap(rehearsal, '127.0.0.1:8300:8000', '0.0.0.0:8300:8000'), 'api-gw');
    refuses(
      localPorts,
      swapIn(
        rehearsal,
        'db',
        '    command:\n',
        "    ports: ['127.0.0.1:5432:5432']\n    command:\n",
      ),
      'publishes db 127.0.0.1:5432:5432',
    );
    refuses(
      localPorts,
      swap(rehearsal, "    ports: ['127.0.0.1:8300:8000']", '    ports:\n      - 8300:8000'),
      'does not publish api-gw 127.0.0.1:8300:8000',
    );
  });

  it('keeps every staging service behind a profile the rehearsal never turns on', () => {
    expect(stagingServices(compose)).toEqual([
      'web-staging',
      'scheduler-staging',
      'migrate-staging',
    ]);
    expect(stagingOff(rehearsal)).toEqual([]);
    refuses(
      stagingOff,
      swapIn(rehearsal, 'migrate-staging', 'profiles: !override [staging]', 'profiles: [staging]'),
      'migrate-staging is not behind the staging profile alone',
    );
    refuses(
      (text) => stagingOff(rehearsal, text),
      swapIn(
        compose,
        'backup',
        '    networks: [default, data]',
        '    networks: [default, staging]',
      ),
      'backup is not behind the staging profile alone',
    );
  });

  it('runs the server’s database command with smaller buffers, and nothing else changed', () => {
    expect(dbCommand(rehearsal)).toEqual([]);
    refuses(
      dbCommand,
      swap(rehearsal, '      - -c\n      - jit=off\n', ''),
      'not the server’s with shared_buffers=128MB: - jit=off',
    );
    refuses(
      (text) => dbCommand(rehearsal, text),
      swapIn(
        compose,
        'db',
        '      - jit=off\n',
        '      - jit=off\n      - -c\n      - work_mem=8MB\n',
      ),
      'work_mem=8MB',
    );
    refuses(
      (text) => dbCommand(rehearsal, text),
      swap(compose, 'shared_buffers=480MB', 'shared_buffers=512MB'),
      'has no shared_buffers=480MB',
    );
  });

  it('has its own project and edge networks, and an S3 stand-in on an internal network', () => {
    expect(localNetworks(rehearsal)).toEqual([]);
    refuses(
      localNetworks,
      swap(rehearsal, 'name: menumesh-rehearsal', 'name: menumesh'),
      'project',
    );
    refuses(
      localNetworks,
      swap(
        rehearsal,
        '  edge-menumesh:\n    external: false',
        '  edge-menumesh:\n    external: true',
      ),
      'edge-menumesh is not the project’s own network',
    );
    refuses(
      localNetworks,
      swap(rehearsal, '  bucket:\n    internal: true', '  bucket: {}'),
      'bucket is not internal',
    );
    refuses(
      localNetworks,
      swapIn(rehearsal, 's3', '    networks: [bucket]', '    networks: [bucket, default]'),
      's3 is not on the bucket network alone',
    );
    refuses(localNetworks, rehearsal.replace(/(rclone:[\d.]+)@sha256:[0-9a-f]+/, '$1'), 'digest');
  });

  it('sends every third-party host the code names to 0.0.0.0 in the containers with a way out', () => {
    expect(THIRD_PARTY).toEqual(
      expect.arrayContaining([
        'api.resend.com',
        'api.razorpay.com',
        'openrouter.ai',
        'sentry.io',
        'challenges.cloudflare.com',
        'us-assets.i.posthog.com',
        'api.telegram.org',
        'staging.menumesh.in',
      ]),
    );
    expect(sinkhole(rehearsal)).toEqual([]);
    refuses(sinkhole, swap(rehearsal, '  openrouter.ai: 0.0.0.0\n', ''), 'openrouter.ai');
    refuses(
      sinkhole,
      swap(rehearsal, '  api.resend.com: 0.0.0.0', '  api.resend.com: 10.0.0.1'),
      '10.0.0.1',
    );
    refuses(
      sinkhole,
      swapIn(rehearsal, 'scheduler', '    extra_hosts: *sinkhole\n', ''),
      'scheduler does not use the sinkhole',
    );
  });

  it('is never installed: nothing the server or CI gets names it', () => {
    const files = installed();
    expect(files.map(([path]) => path)).toEqual(
      expect.arrayContaining([
        'deploy/vps/compose.yml',
        'deploy/vps/test/kit-check.sh',
        '.github/workflows/vps-deploy-staging.yml',
      ]),
    );
    const readme = kit('README.md');
    expect(neverInstalled(files, readme)).toEqual([]);
    refuses(
      (text) => neverInstalled([['deploy/vps/compose.yml', text]], readme),
      `include: [local/compose.rehearsal.yml]\n${compose}`,
      'deploy/vps/compose.yml names the local override',
    );
    refuses(
      (text) => neverInstalled([], text),
      swap(readme, '| never installed ', '| /srv/menumesh/ '),
      'README',
    );
  });

  it('names its images as images.env does, and checks their labels as app-deploy does', () => {
    const template = kit('env/images.env.example');
    expect(
      Object.keys(REHEARSAL_IMAGES).every((name) => templateNames(template).includes(name)),
    ).toBe(true);
    expect(Object.values(REHEARSAL_IMAGES)).toEqual([
      'menumesh-web:rehearsal',
      'menumesh-migrate:rehearsal',
      'menumesh-backup:rehearsal',
    ]);
    const filled = rehearsalImagesEnv(template);
    expect(filled).toContain('\nWEB_IMAGE=menumesh-web:rehearsal\n');
    expect(filled).toContain('\nMIGRATE_IMAGE=menumesh-migrate:rehearsal\n');
    expect(filled).toContain('\nBACKUP_IMAGE=menumesh-backup:rehearsal\n');
    // Staging's stay unset: a staging service started by mistake has no image to run.
    expect(filled).toContain('\nSTAGING_IMAGE=ghcr.io/nanu1605/menumesh:none\n');
    expect(filled).toContain('\nMIGRATE_STAGING_IMAGE=ghcr.io/nanu1605/menumesh:none\n');
    expect(filled.split('\n').filter((line) => line.startsWith('#'))).toEqual(
      template.split('\n').filter((line) => line.startsWith('#')),
    );
    expect(() => rehearsalImagesEnv(swap(template, 'BACKUP_IMAGE=', '# BACKUP_IMAGE='))).toThrow(
      'no BACKUP_IMAGE line',
    );

    expect(labelRefusal('menumesh-web:rehearsal', 'rehearsal')).toBeUndefined();
    expect(labelRefusal('ghcr.io/nanu1605/menumesh:prod-v1.2.3@sha256:ab12', 'prod-v1.2.3')).toBe(
      undefined,
    );
    expect(labelRefusal('menumesh-migrate:migrate-0123abcd', 'rehearsal')).toBe(
      "menumesh-migrate:migrate-0123abcd is labelled 'rehearsal', not migrate-0123abcd",
    );
    expect(labelRefusal('localhost:5000/menumesh', '')).toBe(
      "localhost:5000/menumesh is labelled 'nothing', not latest",
    );
  });

  it('reads the VM’s memory, the build context, the seed files and Envoy’s access lines', () => {
    const meminfo =
      'MemTotal:       15912824 kB\nMemFree:         3823408 kB\nMemAvailable:    7751448 kB\n';
    expect(memAvailableMib(meminfo)).toBe(7569);
    expect(memAvailableMib('MemTotal: 1 kB\n')).toBeUndefined();
    expect(statsMib('143.6MiB / 1.5GiB')).toBeCloseTo(143.6);
    expect(statsMib('1.5GiB / 2GiB')).toBe(1536);
    expect(statsMib('512KiB / 32MiB')).toBe(0.5);
    expect(statsMib('2GB / 4GB')).toBeCloseTo(1907.35, 2);
    expect(statsMib('--')).toBeNaN();

    const context = webContext(readFileSync('.dockerignore', 'utf8'));
    expect(context).toEqual(
      expect.arrayContaining(['src', 'public', 'package.json', 'next.config.ts', 'Dockerfile']),
    );
    expect(context).toContain('.dockerignore');
    expect(context).not.toContain('supabase');

    expect(seedFiles(readFileSync('supabase/config.toml', 'utf8'))).toEqual([
      'supabase/seed.sql',
      'supabase/seeds/test_helpers.sql',
    ]);
    expect(() => seedFiles('[db]\nport = 54322\n')).toThrow('no [db.seed] sql_paths');

    const log = [
      '[2026-11-12 00:00:01.000][1][warning][misc] Deprecated field: dns_refresh_rate',
      '[2026-11-12T00:00:02.123Z] GET /rest/v1/x 503 UH 0ms rest',
      'Envoy started',
    ].join('\n');
    expect(accessLines(log)).toEqual(['[2026-11-12T00:00:02.123Z] GET /rest/v1/x 503 UH 0ms rest']);
  });

  it('compares schema dumps object by object, telling line ends and layout from changes', () => {
    const objects = dumpObjects(DUMP);
    expect([...objects.keys()]).toEqual([
      'the preamble',
      'FUNCTION public.one()',
      'FUNCTION private.two()',
    ]);
    expect(objects.get('the preamble')).not.toContain('restrict');
    expect(objects.get('the preamble')).not.toContain('Dumped');
    const same = compareDumps(DUMP, DUMP.replaceAll('AbCd1234', 'Other999'));
    expect(same).toEqual({
      objects: 3,
      onlyMine: [],
      onlyTheirs: [],
      lineEnds: [],
      layout: [],
      changed: [],
    });
    const crlf = DUMP.replace('  select 1\n  where true\n', '  select 1\r\n  where true\r\n');
    expect(compareDumps(DUMP, crlf).lineEnds).toEqual(['FUNCTION public.one()']);
    const wrapped = DUMP.replace('  select 1\n  where true\n', '  select 1 where true\n');
    expect(compareDumps(DUMP, wrapped)).toMatchObject({
      lineEnds: [],
      layout: ['FUNCTION public.one()'],
      changed: [],
    });
    const changed = compareDumps(DUMP, DUMP.replace('select 2', 'select 3'));
    expect(changed).toMatchObject({
      lineEnds: [],
      layout: [],
      changed: ['FUNCTION private.two()'],
    });
    expect(objects.get('FUNCTION private.two()')).toBe(
      'CREATE FUNCTION private.two() RETURNS integer\n    LANGUAGE sql\n    AS $$ select 2 $$;',
    );
    // Without the last object, the one before it is still the same.
    const fewer = DUMP.slice(0, DUMP.indexOf('--\n-- Name: two()'));
    expect(compareDumps(DUMP, fewer)).toMatchObject({
      onlyMine: ['FUNCTION private.two()'],
      changed: [],
    });
    expect(compareDumps(fewer, DUMP).onlyTheirs).toEqual(['FUNCTION private.two()']);
  });

  it('tells what a dump can’t carry from a restore that lost something', () => {
    // Lines as vps:backup-test's FINGERPRINT writes them, from the rehearsal's own clusters.
    const source = [
      'ext|pg_graphql|1.5.11|graphql',
      'ext|pg_net|0.20.3|extensions',
      'proc|graphql_public.graphql(text,text,jsonb,jsonb)|supabase_admin 0 v -|=X/supabase_admin src=eea1e5aaac19 ext=pg_graphql',
      'proc|net.http_get(text,jsonb,jsonb,integer)|supabase_admin 0 v search_path=net|=X/supabase_admin src=7ceed451732f ext=pg_net',
      'proc|public.place_order(uuid)|postgres 1 v search_path=""|=X/postgres src=0123456789ab ext=-',
      'rel|public.orders|r postgres 1 0 p d|anon=r/postgres,postgres=arwdDxtm/postgres ext=-',
      'schema|graphql_public|supabase_admin|anon=U/supabase_admin,supabase_admin=UC/supabase_admin',
      'schema|public|pg_database_owner|=U/pg_database_owner,pg_database_owner=UC/pg_database_owner',
      'seq|graphql.seq_schema_version|11|ext=pg_graphql',
      'seq|public.invoice_seq|42|ext=-',
      'rows|public.orders|25|33a6d08881910e74a1afaec53b55ab6f',
    ];
    expect(restoreDifferences(source, source)).toEqual({ known: [], unknown: [] });
    const restored = source
      .filter((line) => !line.startsWith('proc|graphql_public.graphql('))
      .map((line) =>
        line
          .replace('v search_path=net|', 'v -|')
          .replace(
            'graphql_public|supabase_admin|anon=U/supabase_admin,',
            'graphql_public|supabase_admin|',
          )
          .replace('seq_schema_version|11|', 'seq_schema_version|3632|'),
      );
    expect(restoreDifferences(source, restored)).toEqual({
      known: [
        "pg_graphql's graphql_public.graphql(text,text,jsonb,jsonb): made by an event trigger, not by its script, so not there",
        "pg_net's net.http_get(text,jsonb,jsonb,integer): settings search_path=net → -",
        "schema graphql_public: only its owner's grant, not anon=U/supabase_admin,supabase_admin=UC/supabase_admin",
        "pg_graphql's graphql.seq_schema_version: value 11 → 3632",
      ],
      unknown: [],
    });
    // The same changes outside an extension, or with the extension at another version, are lost
    // data: every one of them fails.
    const lost = source
      .filter((line) => !line.startsWith('rel|public.orders|'))
      .map((line) =>
        line
          .replace('ext|pg_net|0.20.3|', 'ext|pg_net|0.19.5|')
          .replace('v search_path=net|', 'v -|')
          .replace('v search_path=""|', 'v -|')
          .replace('public|pg_database_owner|=U/pg_database_owner,', 'public|pg_database_owner|')
          .replace('invoice_seq|42|', 'invoice_seq|1|')
          .replace('orders|25|33a6d08881910e74a1afaec53b55ab6f', 'orders|24|0000'),
      )
      .concat('role|intruder|0100100|-1 -');
    const { known, unknown } = restoreDifferences(source, lost);
    expect(known).toEqual([]);
    expect(unknown).toEqual([
      'ext|pg_net: 0.20.3 | extensions in the source, 0.19.5 | extensions restored',
      'proc|net.http_get(text,jsonb,jsonb,integer): supabase_admin 0 v search_path=net | =X/supabase_admin src=7ceed451732f ext=pg_net in the source, supabase_admin 0 v - | =X/supabase_admin src=7ceed451732f ext=pg_net restored',
      'proc|public.place_order(uuid): postgres 1 v search_path="" | =X/postgres src=0123456789ab ext=- in the source, postgres 1 v - | =X/postgres src=0123456789ab ext=- restored',
      'only in the source: rel|public.orders|r postgres 1 0 p d|anon=r/postgres,postgres=arwdDxtm/postgres ext=-',
      'schema|public: pg_database_owner | =U/pg_database_owner,pg_database_owner=UC/pg_database_owner in the source, pg_database_owner | pg_database_owner=UC/pg_database_owner restored',
      'seq|public.invoice_seq: 42 | ext=- in the source, 1 | ext=- restored',
      'rows|public.orders: 25 | 33a6d08881910e74a1afaec53b55ab6f in the source, 24 | 0000 restored',
      'only in the restore: role|intruder|0100100|-1 -',
    ]);
  });
  it('reads the shipper’s WAL names and checks their signatures as a restore does', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const own = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const other = generateKeyPairSync('ed25519')
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64');
    const sum = 'ab'.repeat(32);
    const message = walMessage('7301234567890123456', '000000010000000A00000003', sum);
    expect(message).toBe(`menumesh wal 1 7301234567890123456 000000010000000A00000003 ${sum}\n`);
    const signature = sign(null, Buffer.from(message), privateKey).toString('base64url');
    const name = `wal/7301234567890123456/0000000A/000000010000000A00000003.${signature}.zst.age`;
    expect(walObject(name)).toEqual({
      cluster: '7301234567890123456',
      folder: '0000000A',
      walfile: '000000010000000A00000003',
      signature,
    });
    expect(
      walObject(`wal/7301234567890123456/history/00000002.history.${signature}.zst.age`),
    ).toMatchObject({ folder: 'history', walfile: '00000002.history' });
    expect(
      walObject(`wal/1/0000000A/000000010000000A00000003.00000028.backup.${signature}.zst.age`)
        ?.walfile,
    ).toBe('000000010000000A00000003.00000028.backup');
    // A segment in another log id's folder, a history file among the segments, a lower-case or
    // short name, a cluster that is no number, another suffix: none is the shipper's.
    for (const bad of [
      `wal/7301234567890123456/0000000B/000000010000000A00000003.${signature}.zst.age`,
      `wal/7301234567890123456/0000000A/00000002.history.${signature}.zst.age`,
      `wal/7301234567890123456/0000000a/000000010000000a00000003.${signature}.zst.age`,
      `wal/7301234567890123456/0000000A/000000010000000A0000003.${signature}.zst.age`,
      `wal/cluster/0000000A/000000010000000A00000003.${signature}.zst.age`,
      `wal/7301234567890123456/0000000A/000000010000000A00000003.${signature}.age`,
      `wal/7301234567890123456/0000000A/000000010000000A00000003.${signature.slice(1)}.zst.age`,
    ]) {
      expect(walObject(bad), bad).toBeUndefined();
    }
    expect(new RegExp(`^(?:${WAL_FILE})$`).test('archtemp.000000010000000A00000003.12.34')).toBe(
      false,
    );
    expect(signedBy(own, message, signature)).toBe(true);
    expect(signedBy(`${other} ${own}`, message, signature)).toBe(true);
    expect(signedBy(other, message, signature)).toBe(false);
    expect(signedBy(own, message.replace(sum, 'cd'.repeat(32)), signature)).toBe(false);
    // The one spelling only: the last character's unused bits set, or padding.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const unused = `${signature.slice(0, -1)}${alphabet[alphabet.indexOf(signature.at(-1)!) ^ 1]}`;
    expect(Buffer.from(unused, 'base64url').equals(Buffer.from(signature, 'base64url'))).toBe(true);
    expect(signedBy(own, message, unused)).toBe(false);
    expect(signedBy(own, message, `${signature}==`)).toBe(false);
  });
});
