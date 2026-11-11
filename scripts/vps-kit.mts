/**
 * Checks the shared server kit in deploy/vps on this machine, before any server exists
 * (docs/DECISIONS.md VPS-42). Everything runs in throwaway containers named menumesh-kit-*, from
 * images pinned by digest, and is removed at the end; nothing touches the local Supabase stack.
 *
 *   pnpm vps:check   the server's own rules on the kit. deploy/vps/test/kit-check.sh runs the
 *                    vendored app-apply as root in a throwaway Ubuntu container (Dockerfile.kitcheck,
 *                    built here once and never pushed). Around it, on this machine: Caddy adapts and
 *                    validates the edge's tree with menumesh.caddy and the redact file, with
 *                    app-apply's own caddy_run flags; Envoy validates the gateway's config;
 *                    shellcheck reads every script; the crontabs are linted.
 *   pnpm vps:edge    how the edge behaves: the server's Caddy tree with menumesh.caddy, in front of
 *                    three stub upstreams, answering on 127.0.0.1:8443.
 *
 * The local rehearsal of the whole stack, as compose project menumesh-rehearsal: compose.yml in a
 * mirror of /srv/menumesh (.vps-rehearsal/, gitignored) with deploy/vps/local/compose.rehearsal.yml
 * on top, ports on 127.0.0.1 only, the CLI stack only ever read.
 *
 *   pnpm vps:rehearse [--fresh] [--rebuild]
 *                    builds the three images and brings the stack up as the server's install and
 *                    app-deploy do, proving each step on the way (memory, secrets, labels, start
 *                    order, migrations, schema parity, the pre-deploy dump, health, the gateway).
 *                    A rerun reuses the stack, the secrets and an image nothing changed for;
 *                    --fresh starts from new secrets and empty volumes, --rebuild builds every image.
 *   pnpm vps:backup-test
 *                    the nightly backup into a local S3 and the monthly restore test.
 *   pnpm vps:down [--images]
 *                    removes the rehearsal's containers, networks and volumes (and its three images
 *                    with --images), and nothing else.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KIT = join(ROOT, 'deploy', 'vps');
const VENDOR = join(KIT, 'test', 'vendor', 'jainav-infotech');
const USAGE = `Usage: pnpm vps:check
       pnpm vps:edge
       pnpm vps:rehearse [--fresh] [--rebuild]
       pnpm vps:backup-test
       pnpm vps:down [--images]`;

/** shellcheck 0.11.0, pushed 2025-08-04. */
const SHELLCHECK =
  'koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d';
/**
 * The edge's Caddy: the tag the server's edge.conf names (CADDY_IMAGE), pinned here by the digest
 * that tag had on 2026-11-11 (pushed 2026-11-06). caddyImage() refuses a tag that no longer
 * matches the vendored edge.conf.
 */
const CADDY =
  'caddy:2.11.9-alpine@sha256:0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee';
/** What the KVM 4 is expected to report as MemTotal, in MiB (to be read on the server). */
const MEMTOTAL_MIB = 15_990;
/** Where vps:edge's Caddy listens, on this machine only. */
const EDGE_PORT = 8443;
/** The edge network of vps:edge: a plain bridge, so Caddy can publish its port. */
const EDGE_NETWORK = 'menumesh-kit-edge';

// --- pure helpers, also run by tests/unit/vps-kit.test.ts ---

/** The services of a compose file written as deploy/vps/compose.yml is: each name and its lines, comments left out. */
export function composeServices(text: string): Map<string, string[]> {
  const services = new Map<string, string[]>();
  let inServices = false;
  let current: string[] | undefined;
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    if (/^\S/.test(line)) {
      inServices = line.startsWith('services:');
      current = undefined;
      continue;
    }
    if (!inServices) continue;
    const name = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(line)?.[1];
    if (name) services.set(name, (current = []));
    else current?.push(line);
  }
  return services;
}

/** One key of a service: its own line and the lines indented under it; undefined when it has none. */
export function serviceKey(lines: readonly string[], key: string): string[] | undefined {
  const start = lines.findIndex((line) => line.startsWith(`    ${key}:`));
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^ {4}\S/.test(line));
  return lines.slice(start, end < 0 ? lines.length : end);
}

/** A service's short-form mounts, as [source, target] pairs. */
export function serviceMounts(lines: readonly string[]): [string, string][] {
  return (serviceKey(lines, 'volumes') ?? [])
    .map((line) => /^\s+- ([^:\s]+):([^:\s]+)/.exec(line))
    .filter((match) => match !== null)
    .map((match) => [match[1], match[2]]);
}

/** The jobs cron-call knows: the labels of its first case statement. */
export function cronCallJobs(cronCall: string): string[] {
  const block = /\ncase \$job in\n([\s\S]*?)\nesac\n/.exec(cronCall)?.[1] ?? '';
  return [...block.matchAll(/^([a-z|\s-]+)\)/gm)]
    .flatMap((match) => match[1].split('|'))
    .map((label) => label.trim())
    .filter(Boolean);
}

/**
 * What is wrong with a crontab for BusyBox crond: lines of five time fields in their ranges and a
 * command, and every command `/bin/sh <a script compose mounts> <a job that script knows>`.
 */
export function lintCrontab(
  text: string,
  mounted: readonly string[],
  jobs: readonly string[],
): string[] {
  const problems: string[] = [];
  const fields: [string, number, number][] = [
    ['minute', 0, 59],
    ['hour', 0, 23],
    ['day of the month', 1, 31],
    ['month', 1, 12],
    ['day of the week', 0, 7],
  ];
  let jobLines = 0;
  text.split('\n').forEach((line, index) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const at = `line ${index + 1}`;
    jobLines++;
    const words = line.trim().split(/\s+/);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      problems.push(`${at}: sets ${words[0].split('=')[0]}; BusyBox crond takes no variables`);
      return;
    }
    if (words.length < 6) {
      problems.push(`${at}: needs five time fields and a command`);
      return;
    }
    fields.forEach(([name, min, max], i) => {
      const ok = words[i].split(',').every((part) => {
        const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
        if (!match) return false;
        const [, , from, to, step] = match;
        if (step !== undefined && Number(step) < 1) return false;
        if (from === undefined) return true;
        const low = Number(from);
        const high = to === undefined ? low : Number(to);
        return low >= min && high <= max && low <= high;
      });
      if (!ok) problems.push(`${at}: the ${name} field ${words[i]} is not in ${min}-${max}`);
    });
    const [shell, script, job, ...rest] = words.slice(5);
    if (shell !== '/bin/sh' || rest.length) {
      problems.push(`${at}: the command must be /bin/sh <script> <job>`);
    } else if (!mounted.includes(script)) {
      problems.push(`${at}: ${script} is not mounted in the scheduler`);
    } else if (!jobs.includes(job)) {
      problems.push(`${at}: ${script} knows no job ${job}`);
    }
  });
  if (!jobLines) problems.push('no job at all');
  return problems;
}

/** Splits one shell command line into words, without its double quotes. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (const match of line.matchAll(pattern)) words.push(match[1] ?? match[2]);
  return words;
}

/**
 * The docker run arguments of app-apply's caddy_run (its throwaway Caddy: no network, read-only,
 * no capabilities but NET_BIND_SERVICE, small tmpfs mounts, the env file, the config and certs
 * folders read-only), read from the vendored app-apply itself, so a run here is the run root
 * makes on the server. Throws when caddy_run changed shape: copy the server's new flags in by
 * hand then.
 */
export function caddyRunArgs(
  appApply: string,
  paths: { config: string; certs: string; envFile: string },
  image: string,
  caddyArgs: readonly string[],
): string[] {
  const body = /\ncaddy_run\(\) \{[^\n]*\n([\s\S]*?)\n\}\n/.exec(appApply)?.[1];
  if (!body?.includes('local config=$1 certs=$2 envf=$3')) {
    throw new Error('app-apply has no caddy_run of the known shape (config, certs, env file)');
  }
  const command = body
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('clean docker run '));
  if (!command) throw new Error('caddy_run has no `clean docker run` line');
  const values: Record<string, string> = {
    $config: paths.config,
    $certs: paths.certs,
    $envf: paths.envFile,
    $CADDY_IMAGE: image,
  };
  return shellWords(command)
    .slice(2)
    .flatMap((word) => {
      if (word === '$@') return [...caddyArgs];
      const filled = word.replace(/\$[A-Za-z_]+/g, (name) => {
        if (!(name in values)) throw new Error(`caddy_run uses ${name}, which is not known here`);
        return values[name];
      });
      return [filled];
    });
}

/** The key names start.sh writes into the listener template (its printf lines for sed). */
export function envoyKeyNames(startSh: string): string[] {
  return [...startSh.matchAll(/printf 's\|\$\{([A-Z_]+)\}\|%s\|g\\n'/g)].map((match) => match[1]);
}

/** lds.template.yaml with every ${NAME} start.sh knows filled in; throws if another is left. */
export function renderListeners(template: string, keys: Record<string, string>): string {
  let text = template;
  for (const [name, value] of Object.entries(keys)) text = text.split(`\${${name}}`).join(value);
  const left = /\$\{[A-Z_][A-Z0-9_]*\}/.exec(text);
  if (left)
    throw new Error(`the listener template holds ${left[0]}, which start.sh does not fill in`);
  return text;
}

/**
 * Envoy's bootstrap with the listeners and clusters inline: `envoy --mode validate` loads static
 * resources, not the files that dynamic_resources names. Each resource loses its '@type' line,
 * which only the file-based form has.
 */
export function envoyBootstrap(envoyYaml: string, listeners: string, clusters: string): string {
  const resources = (text: string, type: string) => {
    const lines = text.split('\n');
    const start = lines.indexOf('resources:');
    if (start < 0) throw new Error(`no resources: in the ${type} file`);
    const typeLine = `  - '@type': type.googleapis.com/envoy.config.${type}`;
    let count = 0;
    const items = lines.slice(start + 1).map((line) => {
      if (line === typeLine) {
        count++;
        return '    -';
      }
      if (/^ {2}- /.test(line))
        throw new Error(`a resource of the ${type} file has no '@type' first`);
      return line ? `  ${line}` : line;
    });
    if (!count) throw new Error(`no ${type} in its file`);
    return items.join('\n').trimEnd();
  };
  const kept: string[] = [];
  let dynamic = false;
  for (const line of envoyYaml.split('\n')) {
    if (/^[A-Za-z_]/.test(line)) dynamic = line.startsWith('dynamic_resources:');
    if (!dynamic) kept.push(line);
  }
  return [
    kept.join('\n').trimEnd(),
    'static_resources:',
    '  listeners:',
    resources(listeners, 'listener.v3.Listener'),
    '  clusters:',
    resources(clusters, 'cluster.v3.Cluster'),
    '',
  ].join('\n');
}

/** The rehearsal's own images, each tagged and labelled `rehearsal`, by their images.env names. */
export const REHEARSAL_IMAGES: Readonly<Record<string, string>> = {
  WEB_IMAGE: 'menumesh-web:rehearsal',
  MIGRATE_IMAGE: 'menumesh-migrate:rehearsal',
  BACKUP_IMAGE: 'menumesh-backup:rehearsal',
};

/** MemAvailable of /proc/meminfo in MiB; undefined when the line is missing. */
export function memAvailableMib(meminfo: string): number | undefined {
  const kib = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)?.[1];
  return kib === undefined ? undefined : Math.floor(Number(kib) / 1024);
}

/** The first figure of docker stats' MEM USAGE ("123.4MiB / 1.5GiB"), in MiB. */
export function statsMib(usage: string): number {
  const match = /^([\d.]+)\s*(B|kB|KiB|MB|MiB|GB|GiB)\b/.exec(usage.trim());
  if (!match) return NaN;
  const scale: Record<string, number> = {
    B: 1 / 1048576,
    kB: 1000 / 1048576,
    KiB: 1 / 1024,
    MB: 1e6 / 1048576,
    MiB: 1,
    GB: 1e9 / 1048576,
    GiB: 1024,
  };
  return Number(match[1]) * scale[match[2]];
}

/**
 * images.env for the rehearsal: the template with the rehearsal's images; staging's stay ":none",
 * so a staging service started by mistake has no image to run.
 */
export function rehearsalImagesEnv(
  template: string,
  images: Readonly<Record<string, string>> = REHEARSAL_IMAGES,
): string {
  let text = template;
  for (const [name, ref] of Object.entries(images)) {
    const line = new RegExp(`^${name}=.*$`, 'm');
    if (!line.test(text)) throw new Error(`images.env.example has no ${name} line`);
    text = text.replace(line, `${name}=${ref}`);
  }
  return text;
}

/**
 * app-deploy's label rule (fetch): an image's org.opencontainers.image.version must be the tag it
 * is asked for under. app-deploy's refusal, or undefined when the image passes.
 */
export function labelRefusal(ref: string, label: string): string | undefined {
  const name = ref.split('@')[0];
  const colon = name.lastIndexOf(':');
  const tag = colon > name.lastIndexOf('/') ? name.slice(colon + 1) : 'latest';
  return label === tag ? undefined : `${ref} is labelled '${label || 'nothing'}', not ${tag}`;
}

/** The web image's build context: .dockerignore's allowlist, and the two files that shape the image. */
export function webContext(dockerignore: string): string[] {
  return [
    ...[...dockerignore.matchAll(/^!(\S+)$/gm)].map((match) => match[1].replace(/\/$/, '')),
    'Dockerfile',
    '.dockerignore',
  ];
}

/** The seed files `supabase db reset` loads, from supabase/config.toml's [db.seed] sql_paths. */
export function seedFiles(configToml: string): string[] {
  const list = /^\[db\.seed\][\s\S]*?^sql_paths = \[([^\]]*)\]$/m.exec(configToml)?.[1];
  if (list === undefined) throw new Error('supabase/config.toml has no [db.seed] sql_paths');
  return [...list.matchAll(/"([^"]+)"/g)].map((match) =>
    join('supabase', match[1].replace(/^\.\//, '')).replaceAll('\\', '/'),
  );
}

/**
 * A schema-only pg_dump as objects: each "-- Name: ...; Type: ...; Schema: ..." header (its owner
 * left out) with the text under it, without what changes from run to run (pg_dump 17.6's
 * \restrict key and the version comments).
 */
export function dumpObjects(dump: string): Map<string, string> {
  const objects = new Map<string, string>();
  let key = 'the preamble';
  let lines: string[] = [];
  let header = false;
  const keep = () => {
    let unique = key;
    for (let n = 2; objects.has(unique); n++) unique = `${key} (${n})`;
    objects.set(unique, lines.join('\n').trim());
  };
  for (const line of dump.split('\n')) {
    if (/^\\(un)?restrict /.test(line) || /^-- Dumped (from|by) /.test(line)) continue;
    const name = /^-- (?:Data for )?Name: (.*); Type: (.*); Schema: (.*?);/.exec(line);
    if (!name) {
      // The "--" lines around a header belong to neither object.
      if (!(header && line === '--')) lines.push(line);
      header = false;
      continue;
    }
    if (lines.at(-1) === '--') lines.pop();
    keep();
    key = `${name[2]} ${name[3]}.${name[1]}`;
    lines = [];
    header = true;
  }
  keep();
  return objects;
}

/**
 * Two schema dumps compared object by object: names only in one; objects whose text differs only
 * in carriage returns (a function body from a file checked out with CRLF line ends), only in other
 * whitespace (layout), or otherwise (changed).
 */
export function compareDumps(mine: string, theirs: string) {
  const [a, b] = [dumpObjects(mine), dumpObjects(theirs)];
  const bare = (text: string) => text.replaceAll('\r', '');
  const flat = (text: string) => text.replace(/\s+/g, ' ');
  const differ = [...a.keys()].filter((name) => b.has(name) && a.get(name) !== b.get(name));
  return {
    objects: a.size,
    onlyMine: [...a.keys()].filter((name) => !b.has(name)),
    onlyTheirs: [...b.keys()].filter((name) => !a.has(name)),
    lineEnds: differ.filter((name) => bare(a.get(name)!) === bare(b.get(name)!)),
    layout: differ.filter(
      (name) =>
        bare(a.get(name)!) !== bare(b.get(name)!) && flat(a.get(name)!) === flat(b.get(name)!),
    ),
    changed: differ.filter((name) => flat(a.get(name)!) !== flat(b.get(name)!)),
  };
}

/** Envoy's access-log lines in a stretch of its output (VPS-35: only answers of 500 and more). */
export function accessLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] [A-Z]+ \S+ \d{3} /.test(line));
}

// --- running things ---

type Run = { status: number; stdout: string; stderr: string };

/**
 * Runs docker for its answer; the values it needs stay off the command line where it matters
 * (`input` goes to its stdin, `env` to its environment).
 */
function docker(args: string[], input?: string | Buffer, env?: Record<string, string>): Run {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    input,
    env: env ? { ...process.env, ...env } : undefined,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** Stops the run; the finally blocks on the way out still remove the throwaway containers. */
function fail(message: string): never {
  throw new Error(message);
}

const read = (...path: string[]) => readFileSync(join(KIT, ...path), 'utf8');

/** One host-side check's result, printed as it comes. */
class Checks {
  passed = 0;
  failed = 0;
  ok(name: string) {
    this.passed++;
    console.log(`✔ ${name}`);
  }
  bad(name: string, detail = '') {
    this.failed++;
    console.error(`✖ ${name}${detail ? `\n${detail.replace(/^/gm, '    | ')}` : ''}`);
  }
  expect(name: string, condition: boolean, detail = '') {
    if (condition) this.ok(name);
    else this.bad(name, detail);
  }
}

/** The checker image, built from Dockerfile.kitcheck once per version of that file. */
function checkerImage(): string {
  const dockerfile = join(KIT, 'test', 'Dockerfile.kitcheck');
  const hash = createHash('sha256').update(readFileSync(dockerfile)).digest('hex').slice(0, 12);
  const tag = `menumesh-kit-check:${hash}`;
  if (docker(['image', 'inspect', tag]).status === 0) return tag;
  console.log(`Building ${tag} (once; the Docker CLI and Compose are downloaded and checked)…`);
  const built = spawnSync(
    'docker',
    ['build', '--platform', 'linux/amd64', '--file', dockerfile, '--tag', tag, join(KIT, 'test')],
    { stdio: 'inherit' },
  );
  if (built.status !== 0) fail(`docker build of ${tag} failed.`);
  // The image of an earlier Dockerfile.kitcheck is no use any more.
  for (const old of docker(['image', 'ls', 'menumesh-kit-check', '--format', '{{.Tag}}'])
    .stdout.split('\n')
    .filter((found) => found && found !== hash)) {
    docker(['image', 'rm', `menumesh-kit-check:${old}`]);
  }
  return tag;
}

/** The edge's Caddy image, as long as the vendored edge.conf still names its tag. */
function caddyImage(): string {
  const tag = /^CADDY_IMAGE=(\S+)$/m.exec(readFileSync(join(VENDOR, 'edge.conf'), 'utf8'))?.[1];
  if (!tag || !CADDY.startsWith(`${tag}@sha256:`)) {
    fail(`The vendored edge.conf names ${tag}, but vps-kit.mts pins ${CADDY}: pin the new tag.`);
  }
  return CADDY;
}

/** A work folder with what the checker and the Caddy runs share. */
function workFolder(checker: string): { dir: string; password: string; checks: string } {
  const dir = mkdtempSync(join(tmpdir(), 'menumesh-kit-'));
  try {
    // MemTotal for check_sum, as the server is expected to report it.
    writeFileSync(
      join(dir, 'meminfo'),
      `MemTotal:       ${MEMTOTAL_MIB * 1024} kB\nMemFree:        ${MEMTOTAL_MIB * 512} kB\n`,
    );
    // A throwaway basic-auth account for staging, hashed by the edge's own Caddy.
    const password = randomBytes(12).toString('base64url');
    const hash = docker([
      'run',
      '--rm',
      '--name',
      `menumesh-kit-caddy-hash-${process.pid}`,
      '--network',
      'none',
      CADDY,
      'caddy',
      'hash-password',
      '--plaintext',
      password,
    ]);
    if (hash.status !== 0) fail(`caddy hash-password failed: ${hash.stderr}`);
    writeFileSync(
      join(dir, 'edge.env'),
      `MENUMESH_STAGING_AUTH_USER=menumesh\nMENUMESH_STAGING_AUTH_HASH='${hash.stdout.trim()}'\n`,
    );
    // The certificate, and edge.env as app-apply hands it to docker run.
    const prepared = runChecker(checker, dir, 'prepare');
    if (prepared.status !== 0)
      fail(`kit-check.sh prepare failed:\n${prepared.stdout}${prepared.stderr}`);
    return { dir, password, checks: prepared.stdout };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function runChecker(image: string, dir: string, command: 'prepare' | 'check'): Run {
  return docker([
    'run',
    '--rm',
    '--name',
    `menumesh-kit-check-${process.pid}-${command}`,
    '--network',
    'none',
    '--mount',
    `type=bind,source=${join(dir, 'meminfo')},target=/proc/meminfo,readonly`,
    '--mount',
    `type=bind,source=${KIT},target=/kit,readonly`,
    '--mount',
    `type=bind,source=${dir},target=/out`,
    image,
    'bash',
    '/kit/test/kit-check.sh',
    command,
  ]);
}

/** Writes files under a folder, making the folders on the way. */
function put(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** snippets.caddy as the server's admin makes it: the server's, with MenuMesh's tls_menumesh added. */
const snippets = () =>
  `${readFileSync(join(VENDOR, 'snippets.caddy'), 'utf8')}\n${read('edge', 'tls_menumesh.caddy')}`;

/** The edge's config tree as it will be: the server's files, with MenuMesh's site and redact files. */
function edgeTree(dir: string, redact: string | null, ranges?: string) {
  put(dir, {
    Caddyfile: readFileSync(join(VENDOR, 'Caddyfile'), 'utf8'),
    'cloudflare-ranges.caddy':
      ranges ?? readFileSync(join(VENDOR, 'cloudflare-ranges.caddy'), 'utf8'),
    'snippets.caddy': snippets(),
    'sites/menumesh.caddy': read('edge', 'menumesh.caddy'),
  });
  rmSync(join(dir, 'log-redact.d'), { recursive: true, force: true });
  if (redact !== null) put(dir, { 'log-redact.d/menumesh.caddy': redact });
}

/** What Caddy printed but its info lines, as app-apply shows a failed adapt or validate. */
const caddyProblems = (stderr: string) =>
  stderr
    .split('\n')
    .filter((line) => !line.includes('"level":"info"'))
    .join('\n');

let caddyRuns = 0;
/** A throwaway Caddy run with app-apply's own caddy_run flags (and a name to find it by). */
function caddyRun(config: string, certs: string, envFile: string, args: string[]): Run {
  const appApply = readFileSync(join(VENDOR, 'app-apply'), 'utf8');
  const [run, ...rest] = caddyRunArgs(appApply, { config, certs, envFile }, caddyImage(), args);
  return docker([run, '--name', `menumesh-kit-caddy-${process.pid}-${++caddyRuns}`, ...rest]);
}

/** The shell scripts of the kit, as their first line says: the vendored files are the server team's. */
function kitScripts(): string[] {
  return readdirSync(KIT, { recursive: true, encoding: 'utf8' })
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => !path.startsWith('test/vendor/'))
    .filter((path) => {
      const file = join(KIT, path);
      try {
        return /^#!\/bin\/(ba)?sh\b/.test(readFileSync(file, 'utf8').slice(0, 20));
      } catch {
        return false;
      }
    })
    .sort();
}

async function check() {
  const checks = new Checks();
  const compose = read('compose.yml');
  const services = composeServices(compose);

  // Crontabs: BusyBox crond reads them as they are, so a wrong field shows only on the server.
  const jobs = cronCallJobs(read('config', 'scheduler', 'cron-call'));
  for (const [service, file] of [
    ['scheduler', 'production.crontab'],
    ['scheduler-staging', 'staging.crontab'],
  ]) {
    const mounts = serviceMounts(services.get(service) ?? []);
    const mountsFile = mounts.some(
      ([source, target]) =>
        source === `./config/scheduler/${file}` && target === '/etc/crontabs/root',
    );
    const problems = lintCrontab(
      read('config', 'scheduler', file),
      mounts.map(([, target]) => target),
      jobs,
    );
    if (!mountsFile) problems.push(`${service} does not mount it as /etc/crontabs/root`);
    checks.expect(
      `crontab ${file}: fields in range, every command a mounted script`,
      !problems.length,
      problems.join('\n'),
    );
  }

  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) {
    fail('Docker is not running.');
  }
  const checker = checkerImage();
  const work = workFolder(checker);
  try {
    process.stdout.write(work.checks);
    const certs = join(work.dir, 'certs');
    const envFile = join(work.dir, 'edge.docker');

    // The site file's JSON check (app-apply menumesh site, check 2) adapts the server's snippets
    // and this one site; the checker replays this run once it has compared the three files.
    const adapt = join(work.dir, 'adapt');
    put(adapt, {
      Caddyfile: 'import /etc/caddy/snippets.caddy\nimport /etc/caddy/sites/menumesh.caddy\n',
      'snippets.caddy': snippets(),
      'sites/menumesh.caddy': read('edge', 'menumesh.caddy'),
    });
    const empty = join(work.dir, 'empty');
    mkdirSync(empty);
    const adapted = caddyRun(adapt, empty, envFile, [
      'adapt',
      '--config',
      '/etc/caddy/Caddyfile',
      '--adapter',
      'caddyfile',
    ]);
    put(adapt, {
      'adapted.json': adapted.stdout,
      'adapt.err': adapted.stderr,
      status: `${adapted.status}\n`,
    });
    checks.expect(
      'caddy adapt of the server’s snippets with menumesh.caddy (app-apply’s caddy_run flags)',
      adapted.status === 0,
      caddyProblems(adapted.stderr),
    );

    // Check 3 of app-apply menumesh site and app-apply edge redact: the whole tree, with the
    // certificates, through Caddy's own validate.
    const tree = join(work.dir, 'tree');
    const validate = () =>
      caddyRun(tree, certs, envFile, [
        'validate',
        '--config',
        '/etc/caddy/Caddyfile',
        '--adapter',
        'caddyfile',
      ]);
    edgeTree(tree, null);
    let run = validate();
    checks.expect(
      'caddy validate of the edge tree with menumesh.caddy',
      run.status === 0,
      caddyProblems(run.stderr),
    );
    edgeTree(tree, read('edge', 'log-redact.caddy'));
    run = validate();
    checks.expect(
      'caddy validate of that tree with log-redact.d/menumesh.caddy',
      run.status === 0,
      caddyProblems(run.stderr),
    );
    edgeTree(tree, 'request>uri regexp (unclosed x\n');
    run = validate();
    checks.expect(
      'caddy validate refuses a broken redact line',
      run.status !== 0 && /error/i.test(run.stderr),
      `exit ${run.status}`,
    );

    // app-apply's own checks, the contract's rules and the edge files' text checks.
    const result = runChecker(checker, work.dir, 'check');
    process.stdout.write(result.stdout);
    if (result.stderr.trim()) process.stderr.write(result.stderr);
    const counted = /^(\d+) checks, (\d+) failed$/m.exec(result.stdout);
    if (!counted) checks.bad('kit-check.sh check finished', `exit ${result.status}`);
    else {
      checks.passed += Number(counted[1]) - Number(counted[2]);
      checks.failed += Number(counted[2]);
    }

    // Envoy's own validate of the gateway's config, as start.sh fills it in.
    const image = /^ {4}image: (envoyproxy\/envoy:\S+)$/m.exec(compose)?.[1];
    if (!image) checks.bad('envoy validate', 'no envoyproxy/envoy image in compose.yml');
    else {
      const names = envoyKeyNames(read('config', 'envoy', 'start.sh'));
      const keys = Object.fromEntries(
        names.map((name) => [name, `kit-check-${name.toLowerCase()}`]),
      );
      const bootstrap = envoyBootstrap(
        read('config', 'envoy', 'envoy.yaml'),
        renderListeners(read('config', 'envoy', 'lds.template.yaml'), keys),
        read('config', 'envoy', 'cds.yaml'),
      );
      const envoy = (text: string) => {
        const dir = mkdtempSync(join(work.dir, 'envoy-'));
        writeFileSync(join(dir, 'bootstrap.yaml'), text);
        return docker([
          'run',
          '--rm',
          '--name',
          `menumesh-kit-envoy-${process.pid}-${relative(work.dir, dir)}`,
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges:true',
          '--user',
          '101:101',
          '--memory',
          '224m',
          '--mount',
          `type=bind,source=${dir},target=/cfg,readonly`,
          '--entrypoint',
          'envoy',
          image,
          '--mode',
          'validate',
          '--disable-hot-restart',
          '--log-level',
          'error',
          '-c',
          '/cfg/bootstrap.yaml',
        ]);
      };
      checks.expect(
        `the six keys start.sh fills in are the template's (${names.length})`,
        names.length === 6,
        names.join(' '),
      );
      run = envoy(bootstrap);
      checks.expect(
        `envoy --mode validate of the gateway's listeners and clusters (${image.split('@')[0]})`,
        run.status === 0 && run.stdout.includes('OK'),
        `${run.stdout}${run.stderr}`,
      );
      run = envoy(bootstrap.replace('idle_timeout: 60s', 'idle_timeout: a minute'));
      checks.expect(
        'envoy --mode validate refuses a broken copy',
        run.status !== 0,
        `exit ${run.status}`,
      );
    }

    // Every shell script of the kit, kit-check.sh included.
    const scripts = kitScripts();
    run = docker([
      'run',
      '--rm',
      '--name',
      `menumesh-kit-shellcheck-${process.pid}`,
      '--network',
      'none',
      '--mount',
      `type=bind,source=${KIT},target=/mnt,readonly`,
      '--workdir',
      '/mnt',
      SHELLCHECK,
      ...scripts,
    ]);
    checks.expect(
      `shellcheck of the kit's ${scripts.length} scripts (${scripts.map((path) => path.split('/').pop()).join(', ')})`,
      run.status === 0 && scripts.length > 0,
      `${run.stdout}${run.stderr}`,
    );
  } finally {
    rmSync(work.dir, { recursive: true, force: true });
  }
  console.log(`\nvps:check: ${checks.passed + checks.failed} checks, ${checks.failed} failed`);
  if (checks.failed) process.exit(1);
}

// --- vps:edge ---

type Reply = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/**
 * One request to the edge on 127.0.0.1, as Cloudflare sends it: TLS with the host's name, HTTP/1.1.
 * `send` is the body (none by default), sent chunked, without a Content-Length, with `chunked`;
 * `length` claims a Content-Length without sending a body.
 */
function edgeRequest(
  host: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    send?: string | Buffer;
    chunked?: boolean;
    length?: number;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { Host: host, ...options.headers };
    if (options.length !== undefined) headers['Content-Length'] = options.length;
    if (options.chunked) headers['Transfer-Encoding'] = 'chunked';
    // An answer that comes before the whole body (413) ends the upload: the error writing the
    // rest is expected then.
    let answered = false;
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: EDGE_PORT,
        servername: host,
        path,
        method: options.method ?? 'GET',
        headers,
        rejectUnauthorized: false,
        agent: false,
        timeout: 10_000,
      },
      (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
          req.destroy();
        });
      },
    );
    req.on('timeout', () =>
      req.destroy(new Error(`${options.method ?? 'GET'} ${host}${path} timed out`)),
    );
    req.on('error', (error) => {
      if (!answered) reject(error);
    });
    if (options.length !== undefined) req.flushHeaders();
    else req.end(options.send);
  });
}

/** What a stub upstream saw: its lines of name=value. */
const seen = (reply: Reply) =>
  Object.fromEntries(
    reply.body
      .split('\n')
      .map((line) => /^([a-z-]+)=(.*)$/.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => [match[1], match[2]]),
  ) as Record<string, string | undefined>;

/**
 * The stubs: the same Caddy, telling what they received, as Next.js sets its deployment header.
 * Like an app, a stub reads the whole body before it answers (the placeholder reads it), so the
 * edge's log counts every byte that reached it.
 */
const STUB = `{
	admin off
	auto_https off
	persist_config off
}

:3000, :8000 {
	header x-nextjs-deployment-id test
	@read expression {http.request.body} != ""
	header @read x-stub-body read
	respond <<STUB
		stub={$STUB_NAME}
		request={method} {uri}
		host={host}
		x-forwarded-for={header.X-Forwarded-For}
		x-real-ip={header.X-Real-IP}
		cf-connecting-ip={header.CF-Connecting-IP}
		sb-forwarded-for={header.Sb-Forwarded-For}
		true-client-ip={header.True-Client-IP}
		x-client-ip={header.X-Client-IP}
		forwarded={header.Forwarded}
		x-forwarded-host={header.X-Forwarded-Host}
		x-forwarded-proto={header.X-Forwarded-Proto}
		x-forwarded-port={header.X-Forwarded-Port}
		upgrade={header.Upgrade}
		STUB 200
}
`;

const FORGED = '203.0.113.9';
const VISITOR = '198.51.100.23';
const forgedHeaders = {
  'X-Forwarded-For': FORGED,
  'X-Real-IP': FORGED,
  'True-Client-IP': FORGED,
  'X-Client-IP': FORGED,
  Forwarded: `for=${FORGED}`,
  'Sb-Forwarded-For': FORGED,
  'X-Forwarded-Host': 'kit-check.example',
  'X-Forwarded-Proto': 'http',
  'X-Forwarded-Port': '80',
};
const websocket = {
  Connection: 'Upgrade',
  Upgrade: 'websocket',
  'Sec-WebSocket-Version': '13',
  'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
};

async function edge() {
  const checks = new Checks();
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0)
    fail('Docker is not running.');
  const checker = checkerImage();
  const work = workFolder(checker);
  const names = ['web', 'gw', 'web-staging'].map((name) => `menumesh-kit-edge-${name}`);
  const caddy = 'menumesh-kit-edge-caddy';
  const cleanup = () => {
    docker(['rm', '--force', caddy, ...names]);
    docker(['network', 'rm', EDGE_NETWORK]);
  };
  cleanup();
  try {
    const tree = join(work.dir, 'tree');
    edgeTree(tree, read('edge', 'log-redact.caddy'));
    put(join(work.dir, 'stub'), { Caddyfile: STUB });
    if (docker(['network', 'create', EDGE_NETWORK]).status !== 0)
      fail(`docker network create ${EDGE_NETWORK} failed.`);
    const hardened = [
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
    ];
    for (const [index, alias] of [
      'menumesh-web',
      'menumesh-gw',
      'menumesh-web-staging',
    ].entries()) {
      const started = docker([
        'run',
        '--detach',
        '--name',
        names[index],
        '--network',
        EDGE_NETWORK,
        '--network-alias',
        alias,
        ...hardened,
        '--tmpfs',
        '/data:size=1m',
        '--tmpfs',
        '/config:size=1m',
        '--memory',
        '64m',
        '--env',
        `STUB_NAME=${alias}`,
        '--mount',
        `type=bind,source=${join(work.dir, 'stub')},target=/etc/caddy,readonly`,
        caddyImage(),
      ]);
      if (started.status !== 0) fail(`The stub ${alias} did not start: ${started.stderr}`);
    }
    // As the server's edge compose file runs Caddy, with the port on this machine only.
    const started = docker([
      'run',
      '--detach',
      '--name',
      caddy,
      '--network',
      EDGE_NETWORK,
      '--publish',
      `127.0.0.1:${EDGE_PORT}:443`,
      ...hardened,
      '--cap-add',
      'NET_BIND_SERVICE',
      '--tmpfs',
      '/tmp:size=16m',
      '--tmpfs',
      '/data:size=16m',
      '--tmpfs',
      '/config:size=16m',
      '--memory',
      '256m',
      '--memory-swap',
      '256m',
      '--pids-limit',
      '256',
      '--env-file',
      join(work.dir, 'edge.docker'),
      '--mount',
      `type=bind,source=${tree},target=/etc/caddy,readonly`,
      '--mount',
      `type=bind,source=${join(work.dir, 'certs')},target=/certs,readonly`,
      caddyImage(),
    ]);
    if (started.status !== 0) fail(`Caddy did not start: ${started.stderr}`);
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      ready = await edgeRequest('www.menumesh.in', '/').then(
        () => true,
        () => false,
      );
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) {
      fail(`Caddy does not answer on 127.0.0.1:${EDGE_PORT}:\n${docker(['logs', caddy]).stderr}`);
    }

    const auth = {
      Authorization: `Basic ${Buffer.from(`menumesh:${work.password}`).toString('base64')}`,
    };
    // The largest browser upload through the gateway (a 5 MiB support screenshot) and the largest
    // server action (2 MiB), each with room for its multipart wrapping.
    const uploads = [
      ['api.menumesh.in', '/storage/v1/object/b/x.png', 5 * 1024 * 1024 + 4096],
      ['menumesh.in', '/', 2 * 1024 * 1024 + 4096],
    ] as const;
    const tests: [string, () => Promise<void>][] = [];
    const test = (name: string, body: () => Promise<void>) => tests.push([name, body]);
    const expectStatus = async (
      host: string,
      path: string,
      status: number,
      options: Parameters<typeof edgeRequest>[2] = {},
    ) => {
      const reply = await edgeRequest(host, path, options);
      if (reply.status !== status) {
        throw new Error(
          `${options.method ?? 'GET'} ${host}${path}: ${reply.status}, not ${status}`,
        );
      }
      return reply;
    };

    test('www.menumesh.in redirects to menumesh.in with 308, path and query kept', async () => {
      const reply = await expectStatus('www.menumesh.in', '/menu?table=4', 308);
      if (reply.headers.location !== 'https://menumesh.in/menu?table=4') {
        throw new Error(`Location: ${reply.headers.location}`);
      }
    });
    test('a WebSocket upgrade gets 400 on menumesh.in and staging (with the password; 401 without)', async () => {
      await expectStatus('menumesh.in', '/', 400, { headers: websocket });
      await expectStatus('staging.menumesh.in', '/', 400, { headers: { ...websocket, ...auth } });
      await expectStatus('staging.menumesh.in', '/', 401, { headers: websocket });
    });
    test('the Realtime socket on api.menumesh.in reaches the gateway, upgrade and query kept', async () => {
      const reply = seen(
        await expectStatus('api.menumesh.in', '/realtime/v1/websocket?vsn=1.0.0', 200, {
          headers: websocket,
        }),
      );
      if (reply.stub !== 'menumesh-gw' || reply.upgrade !== 'websocket')
        throw new Error(JSON.stringify(reply));
      if (reply.request !== 'GET /realtime/v1/websocket?vsn=1.0.0')
        throw new Error(`${reply.request}`);
    });
    test('api.menumesh.in serves only the four Supabase prefixes; anything else is 404', async () => {
      for (const prefix of [
        '/auth/v1/health',
        '/rest/v1/x',
        '/realtime/v1/api/x',
        '/storage/v1/object/x',
      ]) {
        const reply = seen(await expectStatus('api.menumesh.in', prefix, 200));
        if (reply.stub !== 'menumesh-gw' || reply.request !== `GET ${prefix}`) {
          throw new Error(`${prefix}: ${JSON.stringify(reply)}`);
        }
      }
      for (const path of [
        '/',
        '/foo',
        '/graphql/v1',
        '/pg/tables',
        '/functions/v1/hello',
        '/rest/v2/x',
      ]) {
        const reply = await expectStatus('api.menumesh.in', path, 404);
        if (seen(reply).stub) throw new Error(`${path} reached ${seen(reply).stub}`);
      }
    });
    test('staging asks for the password everywhere but the exempt paths', async () => {
      const unauthorised = await expectStatus('staging.menumesh.in', '/', 401);
      if (!String(unauthorised.headers['www-authenticate']).startsWith('Basic')) {
        throw new Error(`WWW-Authenticate: ${unauthorised.headers['www-authenticate']}`);
      }
      const reply = seen(await expectStatus('staging.menumesh.in', '/', 200, { headers: auth }));
      if (reply.stub !== 'menumesh-web-staging') throw new Error(JSON.stringify(reply));
      await expectStatus('staging.menumesh.in', '/', 401, {
        headers: { Authorization: `Basic ${Buffer.from('menumesh:wrong').toString('base64')}` },
      });
      for (const path of [
        '/t/AbCdEfGhIjKlMnOp',
        '/login',
        '/api/webhooks/razorpay',
        '/api/cron/jobs',
      ]) {
        await expectStatus('staging.menumesh.in', path, 401);
      }
      await expectStatus('staging.menumesh.in', '/api/health', 401, { method: 'POST', send: '{}' });
    });
    test('staging lets machines and installs in without it: health, install files, webhooks', async () => {
      for (const path of [
        '/api/health',
        '/app.webmanifest',
        '/sw.js',
        '/icon/192',
        '/apple-icon',
        '/maskable-icon.png',
        '/favicon.ico',
      ]) {
        await expectStatus('staging.menumesh.in', path, 200);
      }
      await expectStatus('staging.menumesh.in', '/api/health', 200, { method: 'HEAD' });
      for (const path of ['/api/webhooks/razorpay', '/api/webhooks/resend']) {
        const reply = seen(
          await expectStatus('staging.menumesh.in', path, 200, { method: 'POST', send: '{}' }),
        );
        if (reply.stub !== 'menumesh-web-staging') throw new Error(JSON.stringify(reply));
      }
    });
    test('a body over the limit gets 413 from its Content-Length alone, before any byte of it', async () => {
      await expectStatus('api.menumesh.in', '/storage/v1/object/b/x.png', 413, {
        method: 'POST',
        length: 6_500_000,
      });
      await expectStatus('menumesh.in', '/', 413, { method: 'POST', length: 3_500_000 });
      await expectStatus('staging.menumesh.in', '/api/webhooks/razorpay', 413, {
        method: 'POST',
        length: 3_500_000,
      });
    });
    test('a body without a Content-Length is cut off at the limit with 413', async () => {
      await expectStatus('api.menumesh.in', '/storage/v1/object/b/x.png', 413, {
        method: 'POST',
        chunked: true,
        send: Buffer.alloc(6_100_000, 120),
      });
      await expectStatus('menumesh.in', '/', 413, {
        method: 'POST',
        chunked: true,
        send: Buffer.alloc(3_100_000, 120),
      });
    });
    test('a 5 MiB upload reaches the gateway whole, and a 2 MiB server action the app', async () => {
      for (const [host, path, size] of uploads) {
        const reply = await expectStatus(host, path, 200, {
          method: 'POST',
          send: Buffer.alloc(size, 120),
        });
        // The edge's log then says how much of it was read (below).
        if (reply.headers['x-stub-body'] !== 'read')
          throw new Error(`${host}: the stub read no body`);
      }
    });
    test(`forged client addresses are replaced or dropped (from an address that is not Cloudflare's)`, async () => {
      for (const host of ['menumesh.in', 'api.menumesh.in']) {
        const path = host === 'menumesh.in' ? '/' : '/rest/v1/x';
        const reply = seen(
          await expectStatus(host, path, 200, {
            headers: { ...forgedHeaders, 'CF-Connecting-IP': FORGED },
          }),
        );
        const peer = reply['x-real-ip'] ?? '';
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(peer) || peer === FORGED)
          throw new Error(JSON.stringify(reply));
        for (const name of ['x-forwarded-for', 'cf-connecting-ip', 'sb-forwarded-for']) {
          if (reply[name] !== peer) throw new Error(`${host} ${name}=${reply[name]}, not ${peer}`);
        }
        for (const name of ['true-client-ip', 'x-client-ip', 'forwarded']) {
          if (reply[name]) throw new Error(`${host} passed ${name}=${reply[name]}`);
        }
        if (
          reply['x-forwarded-host'] !== host ||
          reply['x-forwarded-proto'] !== 'https' ||
          reply['x-forwarded-port'] !== '443'
        ) {
          throw new Error(JSON.stringify(reply));
        }
      }
    });
    test('the app’s x-nextjs-deployment-id reaches the browser', async () => {
      for (const [host, headers] of [
        ['menumesh.in', {}],
        ['staging.menumesh.in', auth],
      ] as const) {
        const reply = await expectStatus(host, '/', 200, { headers });
        if (reply.headers['x-nextjs-deployment-id'] !== 'test') {
          throw new Error(`${host}: ${reply.headers['x-nextjs-deployment-id']}`);
        }
      }
    });
    // Requests for the log checks below.
    test('the requests the log must leave out or redact are answered', async () => {
      await expectStatus('menumesh.in', '/_next/static/chunks/app.js', 200);
      await expectStatus('menumesh.in', '/api/health', 200);
      await expectStatus('menumesh.in', '/t/AbCdEfGhIjKlMnOp/session', 200);
      await expectStatus('menumesh.in', '/super/alerts', 200);
      await expectStatus('menumesh.in', '/t/AbCdEfGhIjKlMnOp?lang=hi&ref=kit-check-query', 200);
      await expectStatus('api.menumesh.in', '/rest/v1/menu_items?select=*', 200);
      await expectStatus('api.menumesh.in', '/rest/v1/rpc/staff_get_board', 200, {
        method: 'POST',
        send: '{}',
      });
      await expectStatus('api.menumesh.in', '/storage/v1/object/public/menu/a.jpg', 200);
      await expectStatus('api.menumesh.in', '/rest/v1/orders', 200, { method: 'OPTIONS' });
      await expectStatus('staging.menumesh.in', '/t/AbCdEfGhIjKlMnOp?x=kit-check-query', 200, {
        headers: auth,
      });
    });

    const runTests = async () => {
      for (const [name, body] of tests.splice(0)) {
        try {
          await body();
          checks.ok(name);
        } catch (error) {
          checks.bad(name, (error as Error).message);
        }
      }
    };
    await runTests();

    // As if from Cloudflare: its header names the visitor, and nothing else a client sends does.
    edgeTree(tree, read('edge', 'log-redact.caddy'), 'trusted_proxies static private_ranges\n');
    const reload = docker([
      'exec',
      caddy,
      'caddy',
      'reload',
      '--config',
      '/etc/caddy/Caddyfile',
      '--adapter',
      'caddyfile',
      '--force',
    ]);
    checks.expect(
      'Caddy reloads the tree with this machine’s addresses standing in for Cloudflare’s',
      reload.status === 0,
      reload.stderr,
    );
    test(`from Cloudflare, every client-IP header is its CF-Connecting-IP (${VISITOR}) and nothing a client forged`, async () => {
      for (const [host, path, headers] of [
        ['menumesh.in', '/', {}],
        ['api.menumesh.in', '/rest/v1/x', {}],
        ['staging.menumesh.in', '/t/AbCdEfGhIjKlMnOp?x=kit-check-query', auth],
      ] as const) {
        const reply = seen(
          await expectStatus(host, path, 200, {
            headers: { ...forgedHeaders, ...headers, 'CF-Connecting-IP': VISITOR },
          }),
        );
        for (const name of [
          'x-forwarded-for',
          'x-real-ip',
          'cf-connecting-ip',
          'sb-forwarded-for',
        ]) {
          if (reply[name] !== VISITOR) throw new Error(`${host} ${name}=${reply[name]}`);
        }
        for (const name of ['true-client-ip', 'x-client-ip', 'forwarded']) {
          if (reply[name]) throw new Error(`${host} passed ${name}=${reply[name]}`);
        }
      }
    });
    await runTests();

    // The shared log (stdout: the sites' access lines; stderr: Caddy's own).
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const logs = docker(['logs', caddy]);
    const lines = `${logs.stdout}\n${logs.stderr}`
      .split('\n')
      .filter((line) => line.startsWith('{'));
    type Entry = {
      logger?: string;
      request?: Record<string, unknown>;
      status?: number;
      bytes_read?: number;
    };
    const access = lines
      .map((line) => JSON.parse(line) as Entry)
      .filter((entry) => entry.logger?.startsWith('http.log.access'));
    const uris = access.map((entry) => String(entry.request?.uri));
    checks.expect(
      'the log has a line for the requests it keeps',
      uris.includes('/') && uris.includes('/rest/v1/x') && access.length > 10,
      uris.join('\n'),
    );
    const quiet = uris.filter((uri) =>
      /^\/(_next\/static\/|api\/health$|t\/[^/]+\/session$|super\/alerts$|rest\/v1\/(menu_items|rpc\/staff_get_board)|storage\/v1\/object\/public\/)/.test(
        uri,
      ),
    );
    checks.expect(
      'no line for static files, the health check, polls, board and menu reads, public files',
      !quiet.length,
      quiet.join('\n'),
    );
    checks.expect(
      'the diner’s QR token is /t/_ in the log, and no query string is',
      uris.includes('/t/_') &&
        !uris.some((uri) => uri.includes('?') || uri.includes('AbCdEfGhIjKlMnOp')),
      uris.join('\n'),
    );
    const leaks = lines.filter(
      (line) =>
        line.includes(FORGED) ||
        line.includes(VISITOR) ||
        line.includes('kit-check-query') ||
        line.includes(work.password) ||
        /"(headers|resp_headers|client_ip|user_id)":/.test(line),
    );
    checks.expect(
      'no line holds a header, a client address, the staging login or a query',
      !leaks.length,
      leaks.join('\n'),
    );
    const options = access.filter((entry) => entry.request?.method === 'OPTIONS');
    checks.expect('preflights stay out of the log', !options.length, JSON.stringify(options));
    const whole = uploads.map(([host, path, size]) =>
      access.some(
        (entry) =>
          entry.request?.host === host &&
          entry.request?.uri === path &&
          entry.request?.method === 'POST' &&
          entry.status === 200 &&
          entry.bytes_read === size,
      ),
    );
    checks.expect(
      `the uploads reached their upstream whole (${uploads.map(([, , size]) => size).join(' and ')} bytes read)`,
      whole.every(Boolean),
      JSON.stringify(access.filter((entry) => entry.request?.method === 'POST')),
    );
  } finally {
    cleanup();
    rmSync(work.dir, { recursive: true, force: true });
  }
  console.log(`\nvps:edge: ${checks.passed + checks.failed} checks, ${checks.failed} failed`);
  if (checks.failed) process.exit(1);
}

// --- the rehearsal: vps:rehearse, vps:backup-test, vps:down ---

/** The rehearsal's compose project: every container, network and volume it makes carries its name. */
const PROJECT = 'menumesh-rehearsal';
/** The project's folder (gitignored): a mirror of /srv/menumesh, with the throwaway secrets. */
const MIRROR = join(ROOT, '.vps-rehearsal');
/** Goes on top of compose.yml here only; the file says what it changes. */
const OVERRIDE = join(KIT, 'local', 'compose.rehearsal.yml');
/** What Docker Desktop's VM must have available (MemAvailable) before the stack starts, in MiB. */
const NEED_MIB = 6 * 1024;
/** The local Supabase stack's database (pnpm db:start): only ever read, for parity and the locale. */
const CLI_DB = 'supabase_db_tableorder';
/** Newer than any migration: the version of the runner's broken extra file and of its fake row. */
const LATE = '29991231235959';
/** compose's label on everything of the project, one-off containers included. */
const PROJECT_LABEL = `label=com.docker.compose.project=${PROJECT}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (since: number) => Math.round((Date.now() - since) / 100) / 10;
const gib = (mib: number) => (mib / 1024).toFixed(2);
const tail = (text: string, count = 30) => text.trimEnd().split('\n').slice(-count).join('\n');
const lines = (text: string) => text.split('\n').filter(Boolean);
const slash = (path: string) => path.replaceAll('\\', '/');
const shown = (path: string) => slash(relative(ROOT, path));

/** docker compose on the rehearsal, as app-compose runs the server's project: its folder, compose file and two env files, with the override on top. */
const composeArgs = (args: string[]) => [
  'compose',
  '-p',
  PROJECT,
  '--project-directory',
  MIRROR,
  '-f',
  join(MIRROR, 'compose.yml'),
  '-f',
  OVERRIDE,
  '--env-file',
  join(MIRROR, '.env'),
  '--env-file',
  join(MIRROR, 'images.env'),
  ...args,
];
const compose = (args: string[], input?: string | Buffer) => docker(composeArgs(args), input);

/** The project's containers, networks or volumes, by compose's label. */
function projectObjects(kind: 'container' | 'network' | 'volume'): string[] {
  const args =
    kind === 'container'
      ? ['ps', '-a', '-q', '--filter', PROJECT_LABEL]
      : [kind, 'ls', '-q', '--filter', PROJECT_LABEL];
  return lines(docker(args).stdout);
}

/** A service's long-running container, never a one-off of it, as app-deploy finds it. */
function containerOf(service: string): string | undefined {
  return lines(
    docker([
      'ps',
      '-a',
      '-q',
      '--filter',
      PROJECT_LABEL,
      '--filter',
      `label=com.docker.compose.service=${service}`,
      '--filter',
      'label=com.docker.compose.oneoff=False',
    ]).stdout,
  )[0];
}

/** A container's whole log (Postgres and Envoy write to stderr). */
function logsOf(id: string): string {
  const logs = docker(['logs', id]);
  return `${logs.stdout}${logs.stderr}`;
}

/** The Docker daemon's clock, which stamps the log lines (the VM's, not this machine's). */
const daemonNow = () => docker(['info', '--format', '{{.SystemTime}}']).stdout.trim();

/** The lines a container logged since a time of the daemon's clock. */
function logsSince(id: string, since: string): string[] {
  const logs = docker(['logs', '--since', since, id]);
  return lines(`${logs.stdout}${logs.stderr}`);
}

const PSQL = ['psql', '-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1'];
const LOCAL_DB = ['-h', '127.0.0.1', '-d', 'postgres'];

/** SQL (on stdin) in the rehearsal's database, as supabase_admin unless named: its rows, tab-separated. */
function dbSql(query: string, user = 'supabase_admin'): string[] {
  const run = compose(['exec', '-T', 'db', ...PSQL, '-U', user, ...LOCAL_DB], query);
  if (run.status !== 0) fail(`psql in the rehearsal's db: ${run.stderr.trim()}`);
  return lines(run.stdout);
}

/** Whether the local Supabase stack's database runs. */
const cliRunning = () =>
  docker(['inspect', '--format', '{{.State.Running}}', CLI_DB]).stdout.trim() === 'true';

/** The same in the CLI stack's database, in read-only transactions; undefined when it isn't running. */
function cliSql(query: string): string[] | undefined {
  if (!cliRunning()) return undefined;
  const run = docker(
    [
      'exec',
      '-i',
      '--env',
      'PGOPTIONS=-c default_transaction_read_only=on',
      CLI_DB,
      ...PSQL,
      '-U',
      'supabase_admin',
      ...LOCAL_DB,
    ],
    query,
  );
  if (run.status !== 0) fail(`psql in ${CLI_DB}: ${run.stderr.trim()}`);
  return lines(run.stdout);
}

/**
 * Waits for a service as app-deploy's wait_healthy does: healthy passes; unhealthy, a restart or
 * an exit fails at once; one without a healthcheck passes after 15 s. Seconds since `since`.
 */
async function waitHealthy(service: string, limit: number, since: number): Promise<number> {
  const id = containerOf(service) ?? fail(`${service} has no container`);
  const format =
    '{{.State.Status}} {{.State.Restarting}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}';
  let first: number | undefined;
  for (;;) {
    const state = docker(['inspect', '--format', format, id]);
    if (state.status !== 0) fail(`${service}'s container is gone`);
    const [status, restarting, count, health] = state.stdout.trim().split(' ');
    first ??= Number(count);
    if (restarting === 'true' || Number(count) > first) {
      fail(`${service} keeps restarting:\n${tail(logsOf(id))}`);
    }
    if (status !== 'running') fail(`${service} is ${status}:\n${tail(logsOf(id))}`);
    const waited = seconds(since);
    if (health === 'healthy' || (health === 'none' && waited >= 15)) return waited;
    if (health === 'unhealthy') fail(`${service} is unhealthy:\n${tail(logsOf(id))}`);
    if (waited >= limit) fail(`${service} is not healthy after ${waited} s`);
    await sleep(1000);
  }
}

/** Runs `docker <first> | docker <second> > file` without a shell; both exit statuses. */
function pipeline(first: string[], second: string[], file: string) {
  return new Promise<{ first: number; second: number; stderr: string }>((resolve, reject) => {
    const out = openSync(file, 'w');
    const a = spawn('docker', first, { stdio: ['ignore', 'pipe', 'pipe'] });
    const b = spawn('docker', second, { stdio: ['pipe', out, 'pipe'] });
    a.stdout.pipe(b.stdin!);
    let stderr = '';
    a.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    b.stderr!.on('data', (chunk: Buffer) => (stderr += chunk));
    const codes: number[] = [];
    const done = (index: number) => (code: number | null) => {
      codes[index] = code ?? 1;
      if (codes.filter((found) => found !== undefined).length === 2) {
        closeSync(out);
        resolve({ first: codes[0], second: codes[1], stderr });
      }
    };
    a.on('error', reject).on('close', done(0));
    b.on('error', reject).on('close', done(1));
  });
}

/** A request to a port on this machine, as a browser or curl would make it; a 101 is an upgrade. */
function local(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 101, headers: res.headers, body: '' });
    });
    req.on('timeout', () => req.destroy(new Error(`${path} timed out`)));
    req.on('error', reject);
    req.end(options.body);
  });
}

/**
 * Runs an ES module in the web container with its node, as the app's server code would run:
 * `input` (no secret: the container has its own keys) comes in as a constant, `gw` is the gateway
 * the server calls, `key` the server's SUPABASE_SECRET_KEY. Its last line of output, as JSON.
 */
function inWeb<T>(code: string, input: unknown = null): T {
  const script = [
    `const input = ${JSON.stringify(input)};`,
    "const gw = 'http://api-gw:8000';",
    'const key = process.env.SUPABASE_SECRET_KEY;',
    code,
  ].join('\n');
  const run = compose(['exec', '-T', 'web', 'node', '--input-type=module', '-'], script);
  if (run.status !== 0) fail(`node in the web container failed:\n${tail(run.stderr)}`);
  return JSON.parse(lines(run.stdout).pop() ?? 'null') as T;
}

/** A JWT's header. */
const jwtHeader = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()) as Record<string, string>;

/** Whether an ES256 token's signature checks out against a JWK. */
function es256Verifies(token: string, jwk: Record<string, unknown>): boolean {
  const [header, claims, signature] = token.split('.');
  return verify(
    'SHA256',
    Buffer.from(`${header}.${claims}`),
    { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  );
}

// Step 1: Docker Desktop's memory.
function memory(checks: Checks) {
  const total = Number(docker(['info', '--format', '{{.MemTotal}}']).stdout.trim()) / 1048576;
  // The VM's own view, from an image the stack runs anyway.
  const image =
    /^ {4}image: (curlimages\/curl:\S+)$/m.exec(read('compose.yml'))?.[1] ??
    fail('compose.yml has no curlimages/curl image');
  const meminfo = docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--name',
    `${PROJECT}-meminfo-${process.pid}`,
    '--entrypoint',
    'cat',
    image,
    '/proc/meminfo',
  ]);
  const available =
    memAvailableMib(meminfo.stdout) ??
    fail(`No MemAvailable in the VM's /proc/meminfo: ${meminfo.stderr.trim()}`);
  // On a rerun the rehearsal already runs, and what it holds is the rehearsal's own.
  const running = lines(docker(['ps', '-q', '--filter', PROJECT_LABEL]).stdout);
  const own = running.length
    ? lines(docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', ...running]).stdout)
        .map(statsMib)
        .reduce((sum, mib) => sum + (Number.isNaN(mib) ? 0 : mib), 0)
    : 0;
  const free = available + own;
  if (free < NEED_MIB) {
    fail(
      `Docker Desktop's VM has ${gib(free)} GiB available, and the rehearsal needs ${gib(NEED_MIB)} GiB. ` +
        'Stop another stack, or give the VM more memory (Docker Desktop, Settings, Resources), and run it again.',
    );
  }
  checks.ok(
    `Docker Desktop's VM: ${gib(total)} GiB, ${gib(free)} GiB available (MemAvailable${own ? `, ${gib(own)} GiB of it the rehearsal's own` : ''}); ${gib(NEED_MIB)} GiB needed`,
  );
}

/** Removes the project's containers, networks and volumes: compose down, then anything left with its label. */
function removeProject() {
  if (['compose.yml', '.env', 'images.env'].every((file) => existsSync(join(MIRROR, file)))) {
    compose(['--profile', '*', 'down', '--volumes', '--remove-orphans']);
  }
  const containers = projectObjects('container');
  if (containers.length) docker(['rm', '--force', '--volumes', ...containers]);
  const networks = projectObjects('network');
  if (networks.length) docker(['network', 'rm', ...networks]);
  const volumes = projectObjects('volume');
  if (volumes.length) docker(['volume', 'rm', ...volumes]);
}

/**
 * The rehearsal's own earlier builds, which a rebuild left without a tag (only its images are
 * labelled version rehearsal): removed unless a container still uses one, which docker refuses.
 */
function removeOldBuilds() {
  const old = lines(
    docker([
      'images',
      '-q',
      '--no-trunc',
      '--filter',
      'dangling=true',
      '--filter',
      'label=org.opencontainers.image.version=rehearsal',
    ]).stdout,
  );
  for (const id of new Set(old)) docker(['image', 'rm', id]);
}

/** scripts/vps-secrets.mts, as pnpm vps:secrets runs it. */
function vpsSecrets(args: string[]): Run {
  const result = spawnSync(
    process.execPath,
    [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      join(ROOT, 'scripts', 'vps-secrets.mts'),
      ...args,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

// Step 2: the secrets, the mirror of /srv/menumesh, the images.
function secrets(checks: Checks, fresh: boolean): Record<string, string> {
  const envFile = join(MIRROR, '.env');
  if (!existsSync(envFile) && projectObjects('volume').length) {
    fail(
      `The rehearsal's volumes are there but ${shown(envFile)} is not, and the database keeps the ` +
        'old password: pnpm vps:down first, or run this with --fresh.',
    );
  }
  const make = fresh || !existsSync(envFile);
  if (make) {
    const made = vpsSecrets([
      '--rehearsal',
      '--out',
      MIRROR,
      ...(existsSync(envFile) ? ['--force'] : []),
    ]);
    if (made.status !== 0) fail(`vps:secrets --rehearsal failed:\n${made.stdout}${made.stderr}`);
  }
  const checked = vpsSecrets(['--check', MIRROR, '--rehearsal']);
  checks.expect(
    `secrets ${make ? 'made by' : 'kept from the last run of'} vps:secrets --rehearsal in ${shown(MIRROR)}/: .env, env/web.env, env/web-staging.env and a throwaway age key, checked by name`,
    checked.status === 0,
    `${checked.stdout}${checked.stderr}`,
  );
  return parseEnv(readFileSync(envFile, 'utf8')) as Record<string, string>;
}

/** Writes a file of the mirror only when it changed, so a running container's bind mount keeps it. */
function mirrorFile(path: string, data: string | Buffer, written: string[]) {
  const target = join(MIRROR, path);
  if (existsSync(target) && readFileSync(target).equals(Buffer.from(data))) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  written.push(slash(path));
}

/**
 * /srv/menumesh as the owner fills it: compose.yml and config/ from the kit, a stand-in for the
 * CA certificate staging's migrations need, images.env naming the rehearsal's images, and
 * backup-out/, which app-apply makes. The env files are vps:secrets'.
 */
function mirror(checks: Checks) {
  const written: string[] = [];
  mirrorFile('compose.yml', read('compose.yml'), written);
  for (const path of readdirSync(join(KIT, 'config'), { recursive: true, encoding: 'utf8' })) {
    const source = join(KIT, 'config', path);
    if (statSync(source).isFile()) mirrorFile(join('config', path), readFileSync(source), written);
  }
  if (!existsSync(join(MIRROR, 'config', 'migrate', 'supabase-ca.crt'))) {
    mirrorFile(
      join('config', 'migrate', 'supabase-ca.crt'),
      'a stand-in for the CA certificate the owner downloads; staging never runs here\n',
      written,
    );
  }
  mirrorFile('images.env', rehearsalImagesEnv(read('env', 'images.env.example')), written);
  mkdirSync(join(MIRROR, 'backup-out'), { recursive: true });
  const config = compose(['config', '--quiet']);
  checks.expect(
    `/srv/menumesh mirrored in ${shown(MIRROR)}/ (compose.yml, config/, images.env with the rehearsal's images, backup-out/; ${written.length} files written), and compose reads it with the override`,
    config.status === 0,
    config.stderr,
  );
}

const git = (...args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });

/** Whether anything under `paths` differs between the commit `since` and the working tree. */
function changedSince(since: string, paths: string[]): boolean {
  if (git('diff', '--quiet', since, 'HEAD', '--', ...paths).status !== 0) return true;
  return git('status', '--porcelain', '--', ...paths).stdout.trim() !== '';
}

/** An image's labels; undefined when there is no such image. */
function imageLabels(ref: string): Record<string, string> | undefined {
  const run = docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', ref]);
  return run.status === 0
    ? ((JSON.parse(run.stdout) as Record<string, string> | null) ?? {})
    : undefined;
}

const imageMb = (ref: string) =>
  Math.round(
    Number(docker(['image', 'inspect', '--format', '{{.Size}}', ref]).stdout.trim()) / 1e6,
  );

/** docker build of one rehearsal image, labelled with its tag as CI labels its images; seconds taken. */
function build(ref: string, args: string[], env?: Record<string, string>): number {
  const started = Date.now();
  const tag = ref.slice(ref.lastIndexOf(':') + 1);
  const run = docker(
    ['build', '--tag', ref, '--label', `org.opencontainers.image.version=${tag}`, ...args],
    undefined,
    env,
  );
  if (run.status !== 0)
    fail(`docker build of ${ref} failed:\n${tail(run.stderr || run.stdout, 40)}`);
  return seconds(started);
}

function images(checks: Checks, env: Record<string, string>, rebuild: boolean) {
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  // The web image holds the rehearsal's addresses and publishable key: new secrets need a new image.
  const keys = createHash('sha256')
    .update([env.SUPABASE_PUBLIC_URL, env.SITE_URL, env.SUPABASE_PUBLISHABLE_KEY].join('|'))
    .digest('hex')
    .slice(0, 16);
  const web = REHEARSAL_IMAGES.WEB_IMAGE;
  const labels = imageLabels(web);
  const from = labels?.['org.opencontainers.image.revision'];
  const keep =
    !rebuild &&
    labels?.['io.menumesh.rehearsal'] === keys &&
    from !== undefined &&
    !changedSince(from, webContext(readFileSync(join(ROOT, '.dockerignore'), 'utf8')));
  if (keep) {
    checks.ok(
      `${web} kept: built from ${from.slice(0, 12)}, and nothing it is built from changed since (${imageMb(web)} MB)`,
    );
  } else {
    console.log(`  building ${web}, a minute or more…`);
    // The rehearsal's addresses and key; no Sentry or PostHog values, so it reports nowhere.
    const took = build(
      web,
      [
        '--label',
        `io.menumesh.rehearsal=${keys}`,
        '--build-arg',
        `NEXT_PUBLIC_APP_URL=${env.SITE_URL}`,
        '--build-arg',
        `NEXT_PUBLIC_SUPABASE_URL=${env.SUPABASE_PUBLIC_URL}`,
        '--build-arg',
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
        '--build-arg',
        `NEXT_PUBLIC_BUILD_SHA=${sha}`,
        '--build-arg',
        `DEPLOYMENT_ID=rehearsal-${sha.slice(0, 12)}-${Date.now().toString(36)}`,
        ROOT,
      ],
      { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY },
    );
    checks.ok(`${web} built in ${took} s from ${sha.slice(0, 12)} (${imageMb(web)} MB)`);
  }
  const migrate = REHEARSAL_IMAGES.MIGRATE_IMAGE;
  let took = build(migrate, [
    '--file',
    join(KIT, 'migrate', 'Dockerfile'),
    '--build-arg',
    `REVISION=${sha}`,
    ROOT,
  ]);
  checks.ok(`${migrate} built in ${took} s (${imageMb(migrate)} MB)`);
  const backup = REHEARSAL_IMAGES.BACKUP_IMAGE;
  took = build(backup, ['--build-arg', `REVISION=${sha}`, join(KIT, 'backup')]);
  checks.ok(`${backup} built in ${took} s (${imageMb(backup)} MB)`);

  // app-deploy's fetch reads the label with this very format, and refuses an image whose label is
  // not the tag it is asked for under.
  const label = (ref: string) =>
    docker([
      'image',
      'inspect',
      '--format',
      '{{index .Config.Labels "org.opencontainers.image.version"}}',
      ref,
    ]).stdout.trim();
  const refusals = Object.values(REHEARSAL_IMAGES)
    .map((ref) => labelRefusal(ref, label(ref)))
    .filter((refusal) => refusal !== undefined);
  const elsewhere = labelRefusal(`menumesh-migrate:migrate-${sha}`, label(migrate));
  checks.expect(
    "app-deploy's label check: each image's org.opencontainers.image.version is its tag, rehearsal; one asked for under another tag is refused",
    !refusals.length && elsewhere !== undefined,
    refusals.join('\n'),
  );
  return sha;
}

// Step 3: db, then the Supabase services; the locale.
async function supabase(checks: Checks) {
  const db = value('db', 'image');
  // The running containers, by id: compose recreates one whose settings changed.
  const running = (services: string[]) =>
    services
      .map((service) => {
        const id = containerOf(service);
        const state = id && docker(['inspect', '--format', '{{.State.Running}}', id]).stdout;
        return state?.trim() === 'true' ? id : '-';
      })
      .join(' ');
  const took = (before: string, services: string[], started: number) =>
    before === running(services) ? '(already up)' : `in ${seconds(started)} s`;
  let started = Date.now();
  let before = running(['db']);
  let run = compose(['up', '-d', '--wait', '--wait-timeout', '180', 'db']);
  if (run.status !== 0) fail(`db did not turn healthy:\n${tail(run.stderr)}`);
  checks.ok(
    `db healthy ${took(before, ['db'], started)}: ${db.split('@')[0]}, shared_buffers ${dbSql('show shared_buffers')[0]}`,
  );
  const services = ['auth', 'rest', 'realtime', 'storage', 'api-gw'];
  before = running(services);
  started = Date.now();
  run = compose(['up', '-d', '--wait', '--wait-timeout', '180', ...services]);
  if (run.status !== 0) fail(`The Supabase services did not turn healthy:\n${tail(run.stderr)}`);
  checks.ok(`${services.join(', ')} healthy ${took(before, services, started)}`);

  // The locale gate (VPS-34): what initdb gave the rehearsal, the CLI stack and the image.
  const locale =
    "select datname, datlocprovider, datcollate, datctype, coalesce(datlocale, '-') from pg_database where datname in ('postgres', 'template1') order by datname";
  const describe = (rows: string[]) => rows.map((row) => row.split('\t').join(' ')).join('; ');
  const mine = describe(dbSql(locale));
  const cli = cliSql(locale);
  const theirs = cli && describe(cli);
  const initdb =
    lines(
      docker(['image', 'inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', db])
        .stdout,
    ).find((line) => line.startsWith('POSTGRES_INITDB_ARGS=')) ?? 'no POSTGRES_INITDB_ARGS';
  checks.expect(
    `locale (datname, provider, collate, ctype, locale): ${mine}; the CLI stack ${theirs === mine ? 'the same' : theirs}; the image's ${initdb}`,
    theirs === mine,
    theirs === undefined ? `${CLI_DB} is not running` : `the CLI stack: ${theirs}`,
  );
}

/** A value of a service in the kit's compose.yml (one line of its own). */
function value(service: string, name: string): string {
  return (
    serviceKey(composeServices(read('compose.yml')).get(service) ?? [], name)?.[0]
      .slice(`    ${name}:`.length)
      .trim() ?? fail(`compose.yml's ${service} has no ${name}`)
  );
}

// Step 4: migrations as app-deploy runs them, and schema parity with the CLI stack.
async function migrations(checks: Checks) {
  const files = readdirSync(join(ROOT, 'supabase', 'migrations')).filter((name) =>
    /^\d+_.+\.sql$/.test(name),
  );
  const wanted = files.map((name) => name.split('_')[0]).sort();
  const versions = () =>
    dbSql("select to_regclass('supabase_migrations.schema_migrations') is not null")[0] === 't'
      ? dbSql('select version from supabase_migrations.schema_migrations order by version')
      : [];
  const applied = () => versions().join(' ') === wanted.join(' ');
  // app-deploy: timeout 600 docker compose ... run --rm --no-deps -T <MIGRATE_SERVICE>
  const migrate = (...extra: string[]) => {
    const started = Date.now();
    const run = compose(['run', '--rm', '--no-deps', '-T', ...extra, 'migrate']);
    return {
      ...run,
      took: seconds(started),
      said: lines(run.stdout).filter((line) => line.startsWith('migrate:')),
    };
  };
  const db = containerOf('db') ?? fail('db has no container');
  const before = versions().length;
  let since = daemonNow();
  let run = migrate();
  const written = logsSince(db, since);
  checks.expect(
    `migrate as app-deploy runs it (run --rm --no-deps -T migrate): exit ${run.status} in ${run.took} s, "${run.said.at(-1)}"; ${versions().length} history rows for the ${files.length} files`,
    run.status === 0 && applied(),
    tail(`${run.stdout}${run.stderr}`),
  );
  // The journal keeps what db writes, against the app's 45,000 lines a day (VPS-34).
  checks.expect(
    `db wrote ${written.length} log lines during that run${before ? ' (nothing to apply)' : `, which applied all ${files.length} files`}`,
    written.length < 10,
    `the database logged the migrations (log_statement): ${written.length} lines, such as\n${written.slice(0, 5).join('\n')}`,
  );
  // Nor does it log statement text another way: DDL as postgres (the image's log_statement is
  // ddl), and a statement over auto_explain's 10 s.
  const marker = `rehearsal_${randomBytes(4).toString('hex')}`;
  since = daemonNow();
  dbSql(`begin; create table public.${marker} (id int); rollback;`, 'postgres');
  dbSql(`select '${marker}' as marker, pg_sleep(10.5)`, 'postgres');
  const quoted = logsSince(db, since).filter((line) => line.includes(marker));
  checks.expect(
    `db's log keeps no statement text: a DDL statement and a 10.5 s query as postgres leave ${quoted.length} lines naming them`,
    !quoted.length,
    quoted.join('\n'),
  );
  run = migrate();
  checks.expect(
    `a second run: exit ${run.status}, "${run.said.at(-1)}"`,
    run.status === 0 && /nothing to apply/.test(run.said.join('\n')) && applied(),
    tail(`${run.stdout}${run.stderr}`),
  );
  const broken = join(MIRROR, 'migrate-tests', `${LATE}_rehearsal_broken.sql`);
  mkdirSync(dirname(broken), { recursive: true });
  writeFileSync(
    broken,
    '-- A broken migration: its table and row must roll back with it.\n' +
      'create table public.rehearsal_broken (id int);\n' +
      'insert into public.rehearsal_broken values (1);\n' +
      'select 1 / 0;\n',
  );
  run = migrate('--volume', `${slash(broken)}:/migrations/${LATE}_rehearsal_broken.sql:ro`);
  const recorded = dbSql(
    `select count(*) from supabase_migrations.schema_migrations where version = '${LATE}'`,
  )[0];
  const left = dbSql("select to_regclass('public.rehearsal_broken') is not null")[0];
  checks.expect(
    `with a broken extra file mounted: exit ${run.status}, nothing recorded for it, its table rolled back`,
    run.status === 1 && recorded === '0' && left === 'f' && applied(),
    tail(`${run.stdout}${run.stderr}`),
  );
  const fake = String(Number(LATE) - 1);
  dbSql(
    `insert into supabase_migrations.schema_migrations (version, name) values ('${fake}', 'rehearsal_newer')`,
  );
  try {
    run = migrate();
  } finally {
    dbSql(`delete from supabase_migrations.schema_migrations where version = '${fake}'`);
  }
  checks.expect(
    `with a history row the image lacks: exit ${run.status}, refused (the row is removed again)`,
    run.status === 2 && applied(),
    tail(`${run.stdout}${run.stderr}`),
  );

  // Schema parity with the CLI stack, which the repository tests with (read only there).
  if (!cliRunning()) {
    checks.bad('schema parity with the CLI stack', `${CLI_DB} is not running (pnpm db:start)`);
    return;
  }
  const dump = [
    'pg_dump',
    '--schema-only',
    '-U',
    'supabase_admin',
    ...LOCAL_DB,
    '-n',
    'public',
    '-n',
    'private',
  ];
  const mine = compose(['exec', '-T', 'db', ...dump]);
  const theirs = docker([
    'exec',
    '--env',
    'PGOPTIONS=-c default_transaction_read_only=on',
    CLI_DB,
    ...dump,
  ]);
  if (mine.status !== 0 || theirs.status !== 0)
    fail(`pg_dump failed:\n${mine.stderr}${theirs.stderr}`);
  const compared = compareDumps(mine.stdout, theirs.stdout);
  const differences = [
    ...compared.onlyMine.map((name) => `only in the rehearsal: ${name}`),
    ...compared.onlyTheirs.map((name) => `only in the CLI stack: ${name}`),
    ...compared.changed.map((name) => `different: ${name}`),
  ];
  // Whitespace is not a difference: a function body keeps the bytes of the file it came from, and
  // a Windows checkout may hand psql a file with CRLF line ends.
  checks.expect(
    `schema parity (pg_dump --schema-only -n public -n private): the ${compared.objects} objects are the CLI stack's${compared.lineEnds.length ? `; ${compared.lineEnds.length} differ only in CR line ends` : ''}${compared.layout.length ? `; only the layout differs in ${compared.layout.join(', ')}` : ''}`,
    !differences.length,
    differences.join('\n'),
  );
  // What the migrations make outside those schemas: Storage's policies and buckets, the Realtime
  // publication, an extension.
  const outside =
    [
      "select 'policy', policyname, cmd, array_to_string(roles, ','), coalesce(qual, ''), coalesce(with_check, '') from pg_policies where schemaname = 'storage'",
      "select 'bucket', id, name, public::text, coalesce(file_size_limit::text, ''), coalesce(array_to_string(allowed_mime_types, ','), '') from storage.buckets",
      "select 'publication', schemaname, tablename, '', '', '' from pg_publication_tables where pubname = 'supabase_realtime'",
      "select 'extension', extname, extnamespace::regnamespace::text, '', '', '' from pg_extension where extname = 'pg_trgm'",
    ].join(' union all ') + ' order by 1, 2, 3';
  const history = 'select version from supabase_migrations.schema_migrations order by version';
  const [mineOutside, theirsOutside] = [dbSql(outside), cliSql(outside) ?? []];
  const theirVersions = cliSql(history) ?? [];
  const count = (kind: string) => mineOutside.filter((row) => row.startsWith(`${kind}\t`)).length;
  checks.expect(
    `the same ${count('policy')} Storage policies, ${count('bucket')} buckets, ${count('publication')} published tables and pg_trgm; the same ${theirVersions.length} migration versions`,
    mineOutside.join('\n') === theirsOutside.join('\n') &&
      theirVersions.join(' ') === versions().join(' '),
    `rehearsal:\n${mineOutside.join('\n')}\nCLI stack:\n${theirsOutside.join('\n')}\nversions: ${theirVersions.join(' ')}`,
  );
}

// Step 5: app-deploy's pre-deploy dump.
async function predeployDump(checks: Checks, env: Record<string, string>) {
  const [service, user, ...databases] = (
    /^PREDEPLOY_DB="([^"]+)"$/m.exec(read('test', 'menumesh.conf'))?.[1] ??
    fail('test/menumesh.conf has no PREDEPLOY_DB')
  ).split(' ');
  const dir = join(MIRROR, 'predeploy');
  mkdirSync(dir, { recursive: true });
  const backup = REHEARSAL_IMAGES.BACKUP_IMAGE;
  for (const database of databases) {
    const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
    const file = join(dir, `production-${stamp}-${database}.dump.age`);
    const started = Date.now();
    // app-deploy: "${dc[@]}" exec -T <service> pg_dump -Fc -U <user> <database> | age -r <recipient>.
    // The host's age is a throwaway container of the backup image here.
    const piped = await pipeline(
      composeArgs(['exec', '-T', service, 'pg_dump', '-Fc', '-U', user, database]),
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '--name',
        `${PROJECT}-age-${process.pid}`,
        backup,
        'age',
        '-r',
        env.BACKUP_AGE_RECIPIENT,
      ],
      file,
    );
    const bytes = statSync(file).size;
    // Read back with the rehearsal's throwaway key, as the owner would read a real one.
    const listed = docker(
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '--name',
        `${PROJECT}-restore-list-${process.pid}`,
        '--mount',
        `type=bind,source=${join(MIRROR, 'age')},target=/run/age,readonly`,
        backup,
        'sh',
        '-c',
        'age -d -i /run/age/identity.txt | pg_restore -l',
      ],
      readFileSync(file),
    );
    const entries = lines(listed.stdout).filter((line) => !line.startsWith(';')).length;
    checks.expect(
      `the pre-deploy dump as app-deploy makes it (exec -T ${service} pg_dump -Fc -U ${user} ${database} | age): ${bytes} bytes in ${seconds(started)} s, over 256; pg_restore -l reads ${entries} entries`,
      piped.first === 0 && piped.second === 0 && bytes > 256 && listed.status === 0 && entries > 0,
      `${piped.stderr}${listed.stderr}`,
    );
    // app-deploy keeps the newest three.
    const dumps = readdirSync(dir)
      .filter((name) => name.endsWith(`-${database}.dump.age`))
      .sort();
    for (const old of dumps.slice(0, -3)) rmSync(join(dir, old));
  }
}

// Step 6: the local seed, then web and the scheduler.
async function seedAndStart(checks: Checks) {
  const seeds = seedFiles(readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8'));
  const seeded = dbSql("select count(*) from public.restaurants where slug = 'demo'")[0] !== '0';
  if (!seeded) {
    for (const file of seeds) {
      const run = compose(
        [
          'exec',
          '-T',
          'db',
          'psql',
          '-X',
          '-q',
          '-v',
          'ON_ERROR_STOP=1',
          '-o',
          '/dev/null',
          '-U',
          'postgres',
          ...LOCAL_DB,
        ],
        readFileSync(join(ROOT, file), 'utf8'),
      );
      if (run.status !== 0) fail(`${file} failed in the rehearsal's db:\n${tail(run.stderr)}`);
    }
  }
  const [users, restaurants, dishes] = dbSql(
    'select count(*) from auth.users; select count(*) from public.restaurants; select count(*) from public.menu_items',
  );
  checks.ok(
    `${seeded ? 'the local seed is in from an earlier run' : `${seeds.join(' and ')} loaded by hand as postgres`} (the rehearsal's own: never in the migrate image): ${users} users, ${restaurants} restaurant, ${dishes} dishes`,
  );
  const gate = Number(/^HEALTH_TIMEOUT=(\d+)$/m.exec(read('test', 'menumesh.conf'))?.[1] ?? 300);
  const running = () =>
    ['web', 'scheduler'].map((service) => containerOf(service) ?? '-').join(' ');
  const before = running();
  const started = Date.now();
  const run = compose(['up', '-d', '--no-deps', 'web', 'scheduler']);
  if (run.status !== 0) fail(`web and scheduler did not start:\n${tail(run.stderr)}`);
  const [web, scheduler] = await Promise.all([
    waitHealthy('web', gate + 60, started),
    waitHealthy('scheduler', gate + 60, started),
  ]);
  checks.expect(
    `web healthy in ${web} s and scheduler in ${scheduler} s${before === running() ? ' (both were up)' : ''}: within app-deploy's ${gate} s gate`,
    web <= gate && scheduler <= gate,
  );
  const published = (service: string, port: string) =>
    lines(docker(['port', containerOf(service) ?? '', port]).stdout).join(' ');
  const [app, gateway] = [published('web', '3000/tcp'), published('api-gw', '8000/tcp')];
  checks.expect(
    `published on this machine only: web ${app}, api-gw ${gateway}`,
    app === '127.0.0.1:3300' && gateway === '127.0.0.1:8300',
  );
  // The server's edge networks are its admin's, internal, joined by Caddy. Here the project has its
  // own, a plain bridge: Docker publishes no port of a container that is on internal networks only.
  const networks = lines(
    docker(['network', 'ls', '--filter', PROJECT_LABEL, '--format', '{{.Name}} {{.Internal}}'])
      .stdout,
  ).sort();
  const has = (name: string, internal: boolean) =>
    networks.includes(`${PROJECT}_${name} ${internal}`);
  checks.expect(
    `the project's networks: ${networks.map((line) => line.replace(' true', ' (internal)').replace(' false', '')).join(', ')}; none of the server's or vps:edge's names`,
    networks.every((line) => line.startsWith(`${PROJECT}_`)) &&
      has('data', true) &&
      has('gateway', true) &&
      has('edge-menumesh', false),
    networks.join('\n'),
  );
}

// Step 7: the gateway, from this machine (the browser's way) and from the web container (the server's).
async function gateway(checks: Checks, env: Record<string, string>) {
  const publishable = env.SUPABASE_PUBLISHABLE_KEY;
  const apikey = { apikey: publishable };
  const gw = (path: string, options: Parameters<typeof local>[2] = {}) =>
    local(8300, path, options);
  const closed = ['/graphql/v1', '/pg/', '/functions/v1/', '/'];
  const json = (reply: Reply) => {
    try {
      return JSON.parse(reply.body) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  // A staff of the seeded restaurant signs in: an ES256 token, which the JWKS can check.
  const signIn = (email: string, password: string) =>
    gw('/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { ...apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  const owner = await signIn('owner@local.test', 'Password123!');
  const token = String(json(owner).access_token ?? '');
  const jwks = await gw('/auth/v1/.well-known/jwks.json');
  const keys = (json(jwks).keys ?? []) as Record<string, unknown>[];
  const header = token ? jwtHeader(token) : {};
  const jwk = keys.find((key) => key.kid === header.kid);
  checks.expect(
    `sign-in through 127.0.0.1:8300: an ${header.alg} token whose kid ${header.kid} is the JWKS's, and whose signature it checks; the JWKS answers without a key`,
    owner.status === 200 &&
      header.alg === 'ES256' &&
      jwk !== undefined &&
      es256Verifies(token, jwk) &&
      jwks.status === 200,
    `sign-in ${owner.status} ${owner.body.slice(0, 200)}; JWKS ${jwks.status}`,
  );

  // The four prefixes through the published port, with the publishable key (and the owner's token).
  const user = { ...apikey, Authorization: `Bearer ${token}` };
  const [auth, rest, realtime, storage, wrong, ...nowhere] = await Promise.all([
    gw('/auth/v1/health', { headers: apikey }),
    gw('/rest/v1/restaurants?select=slug', { headers: user }),
    gw(`/realtime/v1/websocket?apikey=${publishable}&vsn=1.0.0`, { headers: websocket }),
    gw('/storage/v1/bucket', { headers: user }),
    gw('/auth/v1/health', {
      headers: { apikey: `${publishable.slice(0, -1)}${publishable.endsWith('A') ? 'B' : 'A'}` },
    }),
    ...closed.map((path) => gw(path, { headers: apikey })),
  ]);
  checks.expect(
    `through 127.0.0.1:8300 with the publishable key: auth ${auth.status}, rest ${rest.status} (the owner's restaurant: ${rest.body}), realtime ${realtime.status} (a WebSocket), storage ${storage.status}; ${closed.join(', ')} ${nowhere.map((reply) => reply.status).join(', ')}`,
    auth.status === 200 &&
      rest.status === 200 &&
      rest.body.includes('"slug":"demo"') &&
      realtime.status === 101 &&
      storage.status === 200 &&
      nowhere.every((reply) => reply.status === 404),
  );
  checks.expect(
    `a publishable key with one character changed: ${wrong.status} from the gateway`,
    wrong.status === 401,
  );

  // The same from the server's side: the web container through http://api-gw:8000, its secret key.
  const inside = inWeb<Record<string, number>>(
    'const out = {};\nfor (const path of input) out[path] = (await fetch(gw + path, { headers: { apikey: key } })).status;\nconsole.log(JSON.stringify(out));',
    [
      '/auth/v1/health',
      '/rest/v1/restaurants?select=slug',
      '/realtime/v1/api/ping',
      '/storage/v1/bucket',
      ...closed,
    ],
  );
  const [authIn, restIn, realtimeIn, storageIn, ...closedIn] = Object.values(inside);
  checks.expect(
    `from the web container through http://api-gw:8000 with the secret key: auth ${authIn}, rest ${restIn}, realtime ${realtimeIn}, storage ${storageIn}; ${closed.join(', ')} ${closedIn.join(', ')}`,
    [authIn, restIn, realtimeIn, storageIn].every((status) => status === 200) &&
      closedIn.every((status) => status === 404),
  );
  const reach = inWeb<Record<string, string>>(
    [
      "import { lookup } from 'node:dns/promises';",
      'const out = {};',
      "for (const url of ['http://rest:3000/', 'http://db:5432/', 'http://auth:9999/health']) {",
      '  out[url] = await fetch(url, { signal: AbortSignal.timeout(8000) }).then((res) => String(res.status), (error) => String(error.cause?.code ?? error.name));',
      '}',
      "out.resolved = (await lookup('api.resend.com')).address;",
      'const started = Date.now();',
      "out.resend = await fetch('https://api.resend.com/emails', { method: 'POST' }).then((res) => String(res.status), (error) => String(error.cause?.code ?? error.name));",
      'out.ms = String(Date.now() - started);',
      'console.log(JSON.stringify(out));',
    ].join('\n'),
  );
  const direct = ['http://rest:3000/', 'http://db:5432/', 'http://auth:9999/health'].map(
    (url) => reach[url],
  );
  checks.expect(
    `the web container reaches Supabase only through the gateway: rest, db and auth ${[...new Set(direct)].join(', ')} from it`,
    direct.every((answer) => answer === 'ENOTFOUND'),
    JSON.stringify(reach),
  );
  checks.expect(
    `the sinkhole: api.resend.com is ${reach.resolved} in the web container, and a call to it ends in ${reach.resend} after ${reach.ms} ms`,
    reach.resolved === '0.0.0.0' && reach.resend === 'ECONNREFUSED',
    JSON.stringify(reach),
  );

  // A staff address on <slug>.staff.<STAFF_EMAIL_DOMAIN>, which has no mail records: made through
  // the Admin API, as the app makes its staff, and signing in. The rehearsal's domain, and the
  // server's own (menumesh.in).
  const domains = new Set([
    parseEnv(readFileSync(join(MIRROR, 'env', 'web.env'), 'utf8')).STAFF_EMAIL_DOMAIN ||
      'tableorder.test',
    'menumesh.in',
  ]);
  for (const domain of domains) {
    const email = `rehearsal${randomBytes(4).toString('hex')}@demo.staff.${domain}`;
    const password = randomBytes(18).toString('base64url');
    const made = inWeb<{ status: number; id?: string }>(
      "const res = await fetch(gw + '/auth/v1/admin/users', { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: input.email, password: input.password, email_confirm: true }) });\nconsole.log(JSON.stringify({ status: res.status, id: (await res.json()).id }));",
      { email, password },
    );
    const staff = made.status === 200 ? await signIn(email, password) : undefined;
    const staffToken = String((staff && json(staff).access_token) ?? '');
    if (made.id) {
      inWeb(
        "await fetch(gw + '/auth/v1/admin/users/' + input, { method: 'DELETE', headers: { apikey: key } });\nconsole.log('null');",
        made.id,
      );
    }
    checks.expect(
      `a staff address rehearsal…@demo.staff.${domain} made through the Admin API signs in (${staffToken ? jwtHeader(staffToken).alg : staff?.status}), then is removed`,
      made.status === 200 &&
        staff?.status === 200 &&
        staffToken !== '' &&
        jwtHeader(staffToken).alg === 'ES256',
      `Admin API ${made.status}; sign-in ${staff?.status} ${staff?.body.slice(0, 200)}`,
    );
  }

  // Storage: an upsert keeps the first upload's created_at (the data export's one ZIP), and the
  // export's 50 MiB goes through the gateway's storage route (timeout 0) from the server.
  const object = `rehearsal/${Date.now().toString(36)}.zip`;
  const upload = (bytes: number) =>
    inWeb<{ status: number; ms: number; body: string }>(
      [
        'const started = Date.now();',
        "const res = await fetch(gw + '/storage/v1/object/restaurant-exports/' + input.object, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/zip', 'x-upsert': 'true' }, body: Buffer.alloc(input.bytes, 120) });",
        'console.log(JSON.stringify({ status: res.status, ms: Date.now() - started, body: (await res.text()).slice(0, 200) }));',
      ].join('\n'),
      { object, bytes },
    );
  const row = () =>
    dbSql(
      `select created_at, updated_at, version from storage.objects where bucket_id = 'restaurant-exports' and name = '${object}'`,
    )[0]?.split('\t') ?? [];
  const first = upload(1024);
  const [created, updated, version] = row();
  await sleep(1100);
  const second = upload(2048);
  const [createdAgain, updatedAgain, versionAgain] = row();
  checks.expect(
    'a Storage upsert over an object keeps its created_at and gives it a new updated_at and version',
    first.status === 200 &&
      second.status === 200 &&
      created !== undefined &&
      createdAgain === created &&
      updatedAgain > updated &&
      versionAgain !== version,
    `uploads ${first.status} ${second.status}; ${created} ${updated} ${version} then ${createdAgain} ${updatedAgain} ${versionAgain}`,
  );
  const big = upload(50 * 1024 * 1024);
  const over = upload(50 * 1024 * 1024 + 1);
  inWeb(
    "await fetch(gw + '/storage/v1/object/restaurant-exports/' + input, { method: 'DELETE', headers: { apikey: key } });\nconsole.log('null');",
    object,
  );
  checks.expect(
    `a 50 MiB upload from the web container through http://api-gw:8000: ${big.status} in ${(big.ms / 1000).toFixed(1)} s; a byte more is refused (${over.body.match(/"statusCode":"(\d+)"/)?.[1] ?? over.status})`,
    big.status === 200 && /"statusCode":"413"/.test(over.body),
    `${big.body}\n${over.body}`,
  );

  // A 5xx: rest stopped for a moment. Envoy writes one access line for it, without the query.
  const marker = `rehearsal_5xx_${randomBytes(4).toString('hex')}`;
  const secret = randomBytes(6).toString('hex');
  const envoy = containerOf('api-gw') ?? fail('api-gw has no container');
  let failed: Reply | undefined;
  compose(['stop', 'rest']);
  try {
    failed = await gw(`/rest/v1/${marker}?token=${secret}`, { headers: apikey });
  } finally {
    const started = Date.now();
    compose(['start', 'rest']);
    await waitHealthy('rest', 60, started);
  }
  let found: string[] = [];
  let log = '';
  // Envoy flushes its access log every few seconds; wait for the line, then a little more for a second.
  for (let attempt = 0; attempt < 30 && !found.length; attempt++) {
    await sleep(1000);
    log = logsOf(envoy);
    found = accessLines(log).filter((line) => line.includes(marker));
  }
  await sleep(3000);
  log = logsOf(envoy);
  found = accessLines(log).filter((line) => line.includes(marker));
  let back = 0;
  for (let attempt = 0; attempt < 30 && back !== 200; attempt++) {
    back = (await gw('/rest/v1/restaurants?select=slug', { headers: user })).status;
    if (back !== 200) await sleep(1000);
  }
  const status = failed?.status ?? 0;
  checks.expect(
    `a forced 5xx (rest stopped): ${status}, and exactly one Envoy line for it, without the query: ${found.join(' | ')}; rest answers again (${back})`,
    status >= 500 &&
      found.length === 1 &&
      !found[0].includes('?') &&
      !log.includes(secret) &&
      back === 200,
    log
      .split('\n')
      .filter((line) => line.includes(marker) || line.includes(secret))
      .join('\n'),
  );
}

async function rehearse(fresh: boolean, rebuild: boolean) {
  const checks = new Checks();
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) {
    fail('Docker is not running.');
  }
  console.log('1. Docker Desktop’s memory');
  memory(checks);
  if (fresh) {
    removeProject();
    rmSync(MIRROR, { recursive: true, force: true });
    console.log(
      `  (--fresh: the project's containers, networks and volumes are removed, and ${shown(MIRROR)}/ with its secrets)`,
    );
  }
  console.log('2. Secrets, the mirror of /srv/menumesh, the images');
  const env = secrets(checks, fresh);
  mirror(checks);
  images(checks, env, rebuild || fresh);
  console.log('3. db, then auth, rest, realtime, storage and api-gw');
  await supabase(checks);
  console.log('4. Migrations, as app-deploy runs them');
  await migrations(checks);
  console.log('5. The pre-deploy dump');
  await predeployDump(checks, env);
  console.log('6. The seed, web and the scheduler');
  await seedAndStart(checks);
  console.log('7. The gateway');
  await gateway(checks, env);
  removeOldBuilds();
  console.log(
    `\nThe rehearsal stays up: the app on http://localhost:3300, Supabase on http://127.0.0.1:8300 (project ${PROJECT}, folder ${shown(MIRROR)}/). pnpm vps:down removes it.`,
  );
  console.log(`\nvps:rehearse: ${checks.passed + checks.failed} checks, ${checks.failed} failed`);
  if (checks.failed) process.exit(1);
}

// --- vps:backup-test (J.4 step 12) ---

async function backupTest() {
  const checks = new Checks();
  const db = containerOf('db');
  if (!db || !existsSync(join(MIRROR, '.env')))
    fail('The rehearsal is not up: pnpm vps:rehearse first.');
  const env = parseEnv(readFileSync(join(MIRROR, '.env'), 'utf8')) as Record<string, string>;
  // The bucket's stand-in: rclone's S3 server, on the internal bucket network only.
  const s3 = compose(['up', '-d', '--wait', '--wait-timeout', '60', 's3']);
  if (s3.status !== 0) fail(`s3 did not start:\n${tail(s3.stderr)}`);
  checks.ok(`the local S3 (rclone serve s3) is up, bucket ${env.BACKUP_BUCKET}`);

  // A settings archive as the host's app-config-archive leaves it: an age-encrypted tar.
  const out = join(MIRROR, 'backup-out');
  for (const old of readdirSync(out)) rmSync(join(out, old), { force: true });
  const archive = (stamp: string) => {
    const file = join(out, `config-${stamp}.tar.age`);
    const made = docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--name',
      `${PROJECT}-archive-${process.pid}`,
      '--mount',
      `type=bind,source=${out},target=/out`,
      REHEARSAL_IMAGES.BACKUP_IMAGE,
      'sh',
      '-c',
      `mkdir -p /tmp/s/env && cd /tmp/s && printf 'POSTGRES_PASSWORD=stand-in\\n' >.env && printf 'WEB_IMAGE=x:none\\n' >images.env && printf 'X=1\\n' >env/web.env && tar -cf - .env images.env env | age -r "$1" >/out/config-${stamp}.tar.age`,
      'archive',
      env.BACKUP_AGE_RECIPIENT,
    ]);
    if (made.status !== 0) fail(`The stand-in settings archive failed: ${made.stderr}`);
    return file;
  };
  // backup.sh's own stamp: date -u +%Y-%m-%dT%H%MZ.
  const stampNow = () => `${new Date().toISOString().slice(0, 16).replace(':', '')}Z`;
  const backup = () => {
    const started = Date.now();
    const ran = compose(['run', '--rm', '--no-deps', '-T', 'backup', '/usr/local/bin/backup.sh']);
    return { ...ran, took: seconds(started) };
  };
  const bucket = () =>
    lines(
      compose([
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '--entrypoint',
        'rclone',
        'backup',
        'lsf',
        '--format',
        'sp',
        '--recursive',
        `backups:${env.BACKUP_BUCKET}/`,
      ]).stdout,
    );
  const fresh = archive(stampNow());
  const good = backup();
  const night = /^backup (\S+): (.*)$/m.exec(good.stdout);
  const objects = bucket().filter((line) => night && line.includes(night[1]));
  checks.expect(
    `backup.sh with a fresh settings archive: exit ${good.status} in ${good.took} s, "${night?.[0] ?? tail(good.stdout + good.stderr, 3)}"; ${objects.length} objects of the night in the bucket`,
    good.status === 0 && night !== null && objects.length >= 5,
    `${good.stdout}${good.stderr}\n${objects.join('\n')}`,
  );
  // A new minute, so the next night has its own stamp; then the archive three hours old.
  const minute = new Date().getUTCMinutes();
  while (new Date().getUTCMinutes() === minute) await sleep(1000);
  const hoursAgo = new Date(Date.now() - 3 * 3600 * 1000);
  utimesSync(fresh, hoursAgo, hoursAgo);
  const old = backup();
  const later = bucket()
    .filter((line) => !night || !line.includes(night[1]))
    .filter((line) => line.startsWith('daily/'));
  checks.expect(
    `backup.sh with the archive three hours old: exit ${old.status} after its uploads (${later.length} more objects), "${tail(old.stderr, 1)}"`,
    old.status === 1 && /more than 2 hours old/.test(old.stderr + old.stdout) && later.length >= 4,
    `${old.stdout}${old.stderr}`,
  );

  // The monthly restore test into restore-db, with the rehearsal's throwaway key on /run/age.
  const started = Date.now();
  const run = compose([
    '--profile',
    'restore-test',
    'run',
    '--rm',
    '-T',
    '-e',
    'RESTORE_EXACT=1',
    '-e',
    `RESTORE_STAMP=${night?.[1] ?? ''}`,
    '--volume',
    `${slash(join(MIRROR, 'age'))}:/run/age:ro`,
    'restore-test',
  ]);
  compose(['--profile', 'restore-test', 'rm', '--stop', '--force', 'restore-db']);
  checks.expect(
    `the restore test (restore-db, RESTORE_EXACT=1): exit ${run.status} in ${seconds(started)} s, "${lines(run.stdout).at(-1)}"`,
    run.status === 0 && /restore test passed/.test(run.stdout),
    tail(`${run.stdout}${run.stderr}`),
  );
  const storage = lines(
    compose([
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'sh',
      'backup',
      '-c',
      'find /storage -type f | wc -l; find /storage -type f -exec stat -c %s {} + | awk \'{ n += $1 } END { printf "%.0f\\n", n }\'',
    ]).stdout,
  );
  // restore.sh compared the night's Storage archive (files and bytes) with its manifest; nothing
  // has written to storage-data since the night, so the volume must hold that many files.
  const counted = /Storage holds (\d+) files as the manifest counted\n/.exec(run.stdout)?.[1];
  checks.expect(
    `storage-data holds ${storage[0]?.trim()} files, ${storage[1]} bytes, as the night's archive and its manifest do (${counted ?? '?'} files)`,
    counted !== undefined && counted === storage[0]?.trim(),
    run.stdout,
  );
  compose(['rm', '--stop', '--force', 's3']);
  console.log(
    `\nvps:backup-test: ${checks.passed + checks.failed} checks, ${checks.failed} failed`,
  );
  if (checks.failed) process.exit(1);
}

// --- vps:down (J.4 step 13) ---

async function down(images: boolean) {
  const checks = new Checks();
  // Images by id with their names: an untagged one shows as <none>:<none>.
  const names = () => ({
    containers: lines(docker(['ps', '-a', '--format', '{{.Names}}']).stdout),
    networks: lines(docker(['network', 'ls', '--format', '{{.Name}}']).stdout),
    volumes: lines(docker(['volume', 'ls', '--format', '{{.Name}}']).stdout),
    images: lines(
      docker(['image', 'ls', '-a', '--no-trunc', '--format', '{{.ID}} {{.Repository}}:{{.Tag}}'])
        .stdout,
    ),
  });
  const rehearsalImages = Object.values(REHEARSAL_IMAGES);
  const before = names();
  // The rehearsal's images: its three tags, and its earlier builds (labelled version rehearsal).
  const ourImages = new Set(
    lines(
      docker([
        'images',
        '-a',
        '-q',
        '--no-trunc',
        '--filter',
        'label=org.opencontainers.image.version=rehearsal',
      ]).stdout,
    ),
  );
  const ours = (kind: string, name: string) =>
    kind === 'images'
      ? ourImages.has(name.split(' ')[0]) || rehearsalImages.includes(name.split(' ')[1])
      : name.startsWith(PROJECT);
  removeProject();
  if (images) {
    const present = rehearsalImages.filter((ref) =>
      before.images.some((line) => line.endsWith(` ${ref}`)),
    );
    if (present.length) docker(['image', 'rm', ...present]);
    removeOldBuilds();
  }
  const after = names();
  for (const kind of ['containers', 'networks', 'volumes', 'images'] as const) {
    if (kind === 'images' && !images) continue;
    const removed = before[kind].filter((name) => !after[kind].includes(name));
    const others = removed.filter((name) => !ours(kind, name));
    const left = after[kind].filter((name) => ours(kind, name));
    const shownNames = removed.map((name) => (kind === 'images' ? name.split(' ')[1] : name));
    checks.expect(
      `${kind}: ${removed.length} of the rehearsal's removed${removed.length ? ` (${shownNames.join(', ')})` : ''}, nothing else, none left`,
      !others.length && !left.length,
      [
        ...others.map((name) => `removed, not the rehearsal's: ${name}`),
        ...left.map((name) => `left: ${name}`),
      ].join('\n'),
    );
  }
  console.log(
    `\nThe secrets stay in ${shown(MIRROR)}/: pnpm vps:rehearse starts on new volumes with them, or --fresh makes new ones.`,
  );
  console.log(`\nvps:down: ${checks.passed + checks.failed} checks, ${checks.failed} failed`);
  if (checks.failed) process.exit(1);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const flags = (options: Record<string, { type: 'boolean'; default: boolean }>) =>
    parseArgs({ args: rest, options, strict: true, allowPositionals: false }).values as Record<
      string,
      boolean
    >;
  try {
    if (command === 'check') await check();
    else if (command === 'edge') await edge();
    else if (command === 'rehearse') {
      const { fresh, rebuild } = flags({
        fresh: { type: 'boolean', default: false },
        rebuild: { type: 'boolean', default: false },
      });
      await rehearse(fresh, rebuild);
    } else if (command === 'backup-test') {
      flags({});
      await backupTest();
    } else if (command === 'down') {
      await down(flags({ images: { type: 'boolean', default: false } }).images);
    } else fail(USAGE);
  } catch (error) {
    console.error(`\n✖ ${(error as Error).message}\n`);
    process.exit(1);
  }
}
