import { createHash } from 'node:crypto';
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
  statsMib,
  webContext,
} from '../../scripts/vps-kit.mts';

/**
 * The shared server kit (deploy/vps; docs/DECISIONS.md VPS-31 to VPS-42) is checked by the server's
 * own code only when the owner installs it, and some of it only when it first runs there. These
 * text rules pin what each file must keep, so a change that would break the contract, leak a
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
  ...(dockerfile.includes("printf '30 20 * * * /usr/local/bin/backup.sh\\n' >/etc/crontabs/root")
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
 * The month's copy in monthly/ is a whole night, its uploads checked and its settings archive
 * fresh: the 1st's, whatever monthly/ holds, or the next whole night's while monthly/ holds no
 * whole copy of the month, a manifest named as backup.sh names one with that night's roles, Storage
 * and settings archives and a dump of each database, each past its floor (review findings B4, N2
 * and N3, VPS-40). So names planted in monthly/ can't stop the 1st's copy, a night whose settings
 * archive failed is never the copy, and a 1st that failed leaves it to the next whole night. The
 * manifest goes last, and the copy still comes between the check of the uploads and the settings
 * archive's failure.
 */
const monthlyCopy = (script: string) => {
  const uploads = script.indexOf("reason='the check of the uploads'");
  const whole = script.indexOf('if [ -z "$archive_problem" ]; then\n  case $stamp in');
  const first = script.indexOf('    ????-??-01T*) whole= ;;');
  const listed = script.indexOf(
    `      whole=$(rclone lsf --files-only --format sp --separator ' ' --include "*-$month-*" "$remote/monthly/" |`,
  );
  const check = script.indexOf('  if [ -z "$whole" ]; then');
  const parts = script.indexOf(
    'case $name in manifest-*) ;; *) rclone copyto "$day/$name" "$remote/monthly/$name" ;; esac',
  );
  const manifest = script.indexOf(
    'rclone copyto "$day/manifest-$night.txt.age" "$remote/monthly/manifest-$night.txt.age"',
  );
  const archive = script.indexOf('[ -z "$archive_problem" ] || fail "$archive_problem"');
  return [
    ...(script.includes('--include "manifest-$month-*"')
      ? ['any name in monthly/ stops the month’s copy']
      : []),
    ...(whole > uploads && uploads >= 0
      ? []
      : ['a night whose settings archive failed can be the month’s copy']),
    ...(first > whole && first < check ? [] : ['the 1st’s copy waits on what monthly/ holds']),
    ...(listed > first && listed < check
      ? []
      : ['a 1st that failed leaves the month without a copy']),
    ...(script.includes(
      String.raw`"^manifest-" month "-[0-9][0-9]T[0-9][0-9][0-9][0-9]Z-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][.]txt[.]age$"`,
    ) && script.includes('s = substr(name, 10, 25)')
      ? []
      : ['a whole copy in monthly/ is not looked for under a night’s id']),
    ...(script.includes('ok = big(name, 256) && big("globals-" s ".sql.age", 256) &&') &&
    script.includes('big("storage-" s ".tar.age", 1024) && big("config-" s ".tar.age", 1024)') &&
    script.includes('if (!big(db[i] "-" s ".dump.age", 1024)) ok = 0')
      ? []
      : ['a copy in monthly/ counts as whole without every part past its floor']),
    ...(parts > check && manifest > parts ? [] : ['the manifest is not copied last']),
    ...(manifest < archive ? [] : ['the copy is not before the settings archive’s failure']),
  ];
};

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
  return [
    ...(key >= 0 ? [] : ['no random key for the restricted mode']),
    ...(restrict > key && key >= 0 && restrict < roles && roles < piped
      ? []
      : ['the roles reach psql without \\restrict first']),
    ...(script.split('fetch "globals-$night.sql.age"').length === 2 &&
    script.includes('for part in "globals-$night.sql.age" "storage-$night.tar.age"; do')
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
    `  night=$(rclone lsf --files-only --include 'manifest-*.txt.age' "$bucket/daily/" |`,
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
  const listing = script.indexOf(
    `\nnames=$(printf '%s\\n' "manifest-$night.txt.age" "globals-$night.sql.age" "storage-$night.tar.age" "config-$night.tar.age" | held)\n`,
  );
  const young = script.indexOf(
    [
      'if ! listed "$names" "manifest-$night.txt.age"; then',
      '  [ "$folder" = monthly ] ||',
      '    die "the night of $night is younger than 29 days, so only daily/ is read for it: daily/ keeps every night of the last 29 days under its lock; this one has no manifest there',
    ].join('\n'),
  );
  const old = script.indexOf(
    `  die "the night of $night is 29 days old or more, so only monthly/ is read for it: only the month's copy is kept past 29 days; the backup's journal line says 'kept in monthly/' for that night`,
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
    ...(script.includes('rclone cat --no-traverse "$bucket/$folder/$1"')
      ? []
      : ['the parts are not read from the night’s folder']),
    ...(script.includes('is not in daily/') ? ['a message names daily/ for any night'] : []),
  ];
};

/**
 * RESTORE_STAMP is a night's id as the backup's journal line prints it, its stamp and 8 hex
 * characters, checked whole before anything reads the bucket; the night's age comes from its stamp
 * part. Unasked, only manifests named as backup.sh names one count (review finding F1).
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
      String.raw`sed -n 's/^manifest-\([0-9]\{4\}-[0-9][0-9]-[0-9][0-9]T[0-9]\{4\}Z-[0-9a-f]\{8\}\)\.txt\.age$/\1/p'`,
    )
      ? []
      : ['unasked, a manifest not named as backup.sh names one counts']),
    ...(script.includes('if ($0 != "menumesh backup " night) {')
      ? []
      : ['the manifest’s first line is not checked against the night’s id']),
  ];
};

/**
 * A restore looks for each part by its exact name and reads it by that name (rclone's
 * --no-traverse: one request each), and never holds a folder's listing: a token holder can fill a
 * folder with names, and a listing held in the shell got every restore killed in its 384m (review
 * finding F2). Unasked, the restore test's one listing goes through a pipe that keeps only the
 * newest manifest id; rclone still lists the folder, which naming the night avoids.
 */
const restoreLookups = (script: string) => {
  const calls = code(script).filter((line) => /\brclone /.test(line));
  const unasked = script.indexOf(
    `  night=$(rclone lsf --files-only --include 'manifest-*.txt.age' "$bucket/daily/" |`,
  );
  const pipe = script.slice(unasked, script.indexOf("\n      }')\n", unasked));
  return [
    ...(script.includes(
      'held() {\n  rclone lsf --files-only --no-traverse --files-from-raw - "$bucket/$folder/"\n}',
    )
      ? []
      : ['a part is looked for in a listing of its folder']),
    ...(script.includes(
      'fetch() {\n  rclone cat --no-traverse "$bucket/$folder/$1" | age --decrypt --identity "$AGE_IDENTITY_FILE"\n}',
    )
      ? []
      : ['a part is read after a listing of its folder']),
    ...(/^\s*\w+=\$\(rclone (lsf|ls|lsjson)\b[^|]*$/m.test(script)
      ? ['a folder’s listing is held in the shell']
      : []),
    ...(unasked >= 0 && !/\bsort\b/.test(pipe) && pipe.includes('$0 > newest { newest = $0 }')
      ? []
      : ['unasked, more than the newest manifest id is kept']),
    ...(calls.length === 3
      ? []
      : [`${calls.length} rclone commands, not the 3 of lookups and reads`]),
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
    // As after B4 too: a night whose settings archive failed could be the copy (N3).
    refuses(
      monthlyCopy,
      swap(
        backupSh,
        'if [ -z "$archive_problem" ]; then\n  case $stamp in',
        'if true; then\n  case $stamp in',
      ),
      'settings archive failed',
    );
    // As before B4: the 1st only.
    refuses(
      monthlyCopy,
      swap(
        backupSh,
        `      whole=$(rclone lsf --files-only --format sp --separator ' ' --include "*-$month-*" "$remote/monthly/" |`,
        `      whole=never; : $(rclone lsf --files-only --format sp --separator ' ' --include "*-$month-*" "$remote/monthly/" |`,
      ),
      'without a copy',
    );
    refuses(
      monthlyCopy,
      swap(backupSh, 'big("config-" s ".tar.age", 1024)', 'big("config-" s ".tar.age", 0)'),
      'past its floor',
    );
    refuses(
      monthlyCopy,
      swap(
        backupSh,
        '    rclone copyto "$day/manifest-$night.txt.age" "$remote/monthly/manifest-$night.txt.age"\n',
        '',
      ),
      'not copied last',
    );
    // As before review finding F1: a whole copy looked for under the stamp alone.
    refuses(
      monthlyCopy,
      swap(
        backupSh,
        'Z-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][.]txt[.]age$")) continue',
        'Z[.]txt[.]age$")) continue',
      ),
      'not looked for under a night’s id',
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
        'if ! listed "$names" "manifest-$night.txt.age"; then\n',
        [
          'if [ "$folder" = daily ] && ! listed "$names" "manifest-$night.txt.age"; then',
          '  folder=monthly',
          '  names=$(echo "manifest-$night.txt.age" | held)',
          'fi',
          'if ! listed "$names" "manifest-$night.txt.age"; then',
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
      swap(
        restoreSh,
        'rclone cat --no-traverse "$bucket/$folder/$1"',
        'rclone cat --no-traverse "$bucket/daily/$1"',
      ),
      'night’s folder',
    );
    refuses(
      restoreFolder,
      swap(restoreSh, '"$part is not in $folder/"', '"$part is not in daily/"'),
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
        `names=$(printf '%s\\n' "manifest-$night.txt.age" "globals-$night.sql.age" "storage-$night.tar.age" "config-$night.tar.age" | held)`,
        'names=$(rclone lsf --files-only "$bucket/$folder/")',
      ),
      'listing is held in the shell',
    );
    refuses(
      restoreLookups,
      swap(
        restoreSh,
        'rclone cat --no-traverse "$bucket/$folder/$1"',
        'rclone cat "$bucket/$folder/$1"',
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
        `  night=$(rclone lsf --files-only --include 'manifest-*.txt.age' "$bucket/daily/" |`,
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
      'more than the newest manifest id is kept',
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
});
