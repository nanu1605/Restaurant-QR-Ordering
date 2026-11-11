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
 * The local rehearsal of the whole stack (rehearse, backup-test, down) is not written yet.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KIT = join(ROOT, 'deploy', 'vps');
const VENDOR = join(KIT, 'test', 'vendor', 'jainav-infotech');
const USAGE = `Usage: pnpm vps:check
       pnpm vps:edge`;

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

// --- running things ---

type Run = { status: number; stdout: string; stderr: string };

/** Runs docker for its answer; the values it needs stay off the command line where it matters. */
function docker(args: string[]): Run {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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

if (import.meta.main) {
  const command = process.argv[2];
  try {
    if (command === 'check') await check();
    else if (command === 'edge') await edge();
    else if (command === 'rehearse' || command === 'backup-test' || command === 'down') {
      fail(
        `vps-kit.mts ${command}: not yet. The local rehearsal of the whole stack is still to come.`,
      );
    } else fail(USAGE);
  } catch (error) {
    console.error(`\n✖ ${(error as Error).message}\n`);
    process.exit(1);
  }
}
