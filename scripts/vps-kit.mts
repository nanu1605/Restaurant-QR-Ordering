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
 *                    order, WAL archiving and the host rules, migrations, schema parity, the
 *                    pre-deploy dump, health, the gateway, the WAL shipped to a local S3 from quiet
 *                    logs). A rerun reuses the stack, the secrets and an image nothing changed for;
 *                    --fresh starts from new secrets and empty volumes, --rebuild builds every image.
 *   pnpm vps:backup-test
 *                    the signing helpers and the seal's reader against Node's crypto; db's WAL
 *                    shipped and signed, an outage of the shipper alerted and ended, and the
 *                    shipper's other failures on a spool and a bucket of their own; the nightly
 *                    backup into the local S3, each night named by its id (its stamp and 8 random
 *                    hex characters), with a base backup and a signed seal: a night with a stale
 *                    settings archive, then the month's copy in monthly/ past planted names and a
 *                    copy sealed by another key, no second copy, a night in the service with its
 *                    shipper at once, a base a checkpoint overtakes, which its slot carries, a
 *                    1st's copy, and a 1st whose base failed; every seal and the base read as a
 *                    restore reads them; a night whose id someone else wrote a name of first,
 *                    stopped before its first upload; the monthly restore test; planted
 *                    nights and names the restore must refuse or not read, each night read from the
 *                    one folder its age gives and only as its seal gives it; and the disaster
 *                    recovery of the 1st's copy, from monthly/, on the rehearsal's own volumes,
 *                    after a recovery without RESTORE_STAMP is refused, whose new cluster ships its
 *                    WAL under its own identifier.
 *   pnpm vps:down [--images]
 *                    removes the rehearsal's containers, networks and volumes (and its three images
 *                    with --images), and nothing else.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
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

/** What the third field of a FINGERPRINT line holds, word by word (the last takes the rest). */
const FINGERPRINT_FIELDS: Record<string, string[]> = {
  proc: ['owner', 'security definer', 'volatility', 'settings'],
  rel: ['kind', 'owner', 'row security', 'forced row security', 'persistence', 'replica identity'],
  type: ['type', 'owner'],
  seq: ['value'],
};

/**
 * A cluster's FINGERPRINT (vps:backup-test) against its restore's: what differs, as `known` (what a
 * dump can't carry, each named) and `unknown` (anything else, which fails the test). pg_dump writes
 * no member of an extension but its grants: CREATE EXTENSION makes the members again from the
 * extension's script, and pg_restore makes event triggers last. So what an event trigger or
 * supautils changed on a member after the script ran (pg_net's search_path, pg_graphql's
 * graphql_public.graphql, the pgsodium objects supautils makes for postgres) and a member
 * sequence's value come back as the script makes them. And the graphql and graphql_public schemas
 * keep their grants in a pg_init_privs row of an extension that owns neither (the image's
 * pg_graphql setup): pg_dump takes that row for their first state and writes no grant, so they
 * come back with their owner's grant only.
 */
export function restoreDifferences(source: readonly string[], restored: readonly string[]) {
  const fields = (line: string) => line.split('|');
  // One line per name, but for these kinds: one per name and second field.
  const keyOf = (line: string) => {
    const parts = fields(line);
    const wide = ['member', 'setting', 'published', 'defacl'].includes(parts[0]);
    return parts.slice(0, wide ? 3 : 2).join('|');
  };
  const [had, have] = [new Set(source), new Set(restored)];
  const gone = new Map(source.filter((line) => !have.has(line)).map((line) => [keyOf(line), line]));
  const added = new Map(
    restored.filter((line) => !had.has(line)).map((line) => [keyOf(line), line]),
  );
  // The extensions both clusters have, at the same version.
  const extensions = new Set(
    source
      .filter((line) => line.startsWith('ext|') && have.has(line))
      .map((line) => fields(line)[1]),
  );
  const memberOf = (line: string) => /(?:^|[ |])ext=([^ |]+)$/.exec(line)?.[1];
  const words = (kind: string, text: string) => {
    const count = FINGERPRINT_FIELDS[kind]?.length ?? 1;
    const parts = text.split(' ');
    return [...parts.slice(0, count - 1), parts.slice(count - 1).join(' ')];
  };
  // The first word of the fourth field is the grants; then the body's hash, then the extension.
  const more = (text: string) => {
    const tokens = text.split(' ');
    return { grants: tokens[0], body: tokens.find((token) => token.startsWith('src=')) };
  };
  const known: string[] = [];
  const unknown: string[] = [];
  for (const [key, line] of gone) {
    const [kind, name, attributes, rest] = fields(line);
    const back = added.get(key);
    added.delete(key);
    const extension = memberOf(line);
    const member = extension !== undefined && extensions.has(extension);
    if (back === undefined) {
      if (member)
        known.push(
          `${extension}'s ${name}: made by an event trigger, not by its script, so not there`,
        );
      else unknown.push(`only in the source: ${line}`);
      continue;
    }
    const [, , attributesBack, restBack] = fields(back);
    if (member && memberOf(back) === extension) {
      const [was, is] = [words(kind, attributes), words(kind, attributesBack)];
      const [before, after] = [more(rest), more(restBack)];
      const changes = [
        ...(FINGERPRINT_FIELDS[kind] ?? ['attributes']).flatMap((label, n) =>
          was[n] === is[n] ? [] : [`${label} ${was[n]} → ${is[n]}`],
        ),
        ...(kind !== 'seq' && before.grants !== after.grants ? ['its grants'] : []),
        ...(before.body !== after.body ? ['its body'] : []),
      ];
      known.push(`${extension}'s ${name}: ${changes.join(', ')}`);
      continue;
    }
    const ownerOnly = `${attributes}=UC/${attributes}`;
    if (
      kind === 'schema' &&
      ['graphql', 'graphql_public'].includes(name) &&
      attributesBack === attributes &&
      restBack === ownerOnly &&
      rest.split(',').includes(ownerOnly)
    ) {
      known.push(`schema ${name}: only its owner's grant, not ${rest}`);
    } else {
      unknown.push(
        `${key}: ${[attributes, rest].join(' | ')} in the source, ${[attributesBack, restBack].join(' | ')} restored`,
      );
    }
  }
  for (const line of added.values()) unknown.push(`only in the restore: ${line}`);
  return { known, unknown };
}

/** A WAL file's name as basic_archive writes it: a segment, its .partial, a .backup file, a timeline's .history. */
export const WAL_FILE = String.raw`[0-9A-F]{24}(?:\.partial|\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history`;

/**
 * The parts of a WAL object's name as wal-ship.sh writes it (docs/DECISIONS.md VPS-43):
 * wal/<cluster>/<log id>/<walfile>.<signature>.zst.age, where the log id is the walfile's second 8
 * hex digits, or history/ for a timeline's history file; undefined for any other name.
 */
export function walObject(path: string) {
  const match = new RegExp(
    `^wal/(\\d{1,20})/([0-9A-F]{8}|history)/(${WAL_FILE})\\.([A-Za-z0-9_-]{86})\\.zst\\.age$`,
  ).exec(path);
  if (!match) return undefined;
  const [, cluster, folder, walfile, signature] = match;
  const own = walfile.endsWith('.history') ? 'history' : walfile.slice(8, 16);
  return folder === own ? { cluster, folder, walfile, signature } : undefined;
}

/** What a WAL object's name signs: its cluster, its WAL file and the sha256 of its bytes. */
export const walMessage = (cluster: string, walfile: string, sha256: string) =>
  `menumesh wal 1 ${cluster} ${walfile} ${sha256}\n`;

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
    // A throwaway basic-auth account for staging, hashed by the edge's own Caddy as the RUNBOOK
    // has the owner do it: without --plaintext, so the password is read, here from stdin, and is
    // in no process's arguments.
    const password = randomBytes(12).toString('base64url');
    const hash = docker(
      [
        'run',
        '--rm',
        '-i',
        '--name',
        `menumesh-kit-caddy-hash-${process.pid}`,
        '--network',
        'none',
        CADDY,
        'caddy',
        'hash-password',
      ],
      `${password}\n`,
    );
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

// --- WAL archiving and shipping (VPS-43): vps:rehearse steps 3 and 8, and vps:backup-test ---

/** The line config/db/pg_hba.conf adds to the image's own host rules: the backup's pg_basebackup. */
const REPLICATION_LINE = 'host replication supabase_admin samenet scram-sha-256';

/** A one-off of the backup service as the shipper runs, db's postgres (uid 100, gid 101): sh -c. */
const asShipper = (script: string) =>
  compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '--user',
    '100:101',
    '--entrypoint',
    'sh',
    'backup',
    '-c',
    script,
  ]);

/** The WAL files waiting in the spool and in the shipper's outbox, by name. */
function walWaiting(): { spool: string[]; outbox: string[] } {
  const run = asShipper(
    'ls -A /wal-spool && echo / && { ls -A /wal-spool/.ship/out 2>/dev/null || true; }',
  );
  if (run.status !== 0) fail(`Listing the WAL spool failed: ${run.stderr.trim()}`);
  const [spool, outbox] = run.stdout.split('/\n');
  const named = (text: string | undefined, suffix: string) =>
    lines(text ?? '').filter((name) => new RegExp(`^(?:${WAL_FILE})${suffix}$`).test(name));
  return { spool: named(spool, ''), outbox: named(outbox, String.raw`\.zst\.age`) };
}

/** The rehearsal db's system identifier, unsigned, as wal-ship.sh names its folder. */
const clusterId = () =>
  dbSql(
    'select case when system_identifier < 0 then (system_identifier::numeric + 18446744073709551616)::text else system_identifier::text end from pg_control_system()',
  )[0] ?? '';

/**
 * About 8 MiB of WAL without touching a table (non-transactional logical messages of random text),
 * then a switch to a new segment, which db archives at once: the segment the writes ended in.
 */
function writeWal(): string {
  const rows = dbSql(
    [
      "select count(pg_logical_emit_message(false, 'menumesh-rehearsal', (select string_agg(md5(random()::text || i || g), '') from generate_series(1, 32768) i))) from generate_series(1, 8) g;",
      'select pg_walfile_name(pg_current_wal_lsn());',
      'select pg_switch_wal();',
    ].join('\n'),
  );
  return rows[1] ?? fail(`No WAL file name from db: ${rows.join(' ')}`);
}

/** The bucket's WAL objects under wal/<cluster>/, as their full names. */
function walNames(cluster: string): string[] {
  const run = inBackup(`rclone lsf -R --files-only "backups:$BACKUP_BUCKET/wal/${cluster}/"`);
  if (run.status !== 0) fail(`Listing wal/${cluster}/ failed: ${run.stderr.trim()}`);
  return lines(run.stdout)
    .map((name) => `wal/${cluster}/${name}`)
    .sort();
}

/**
 * Each object downloaded in the backup's container: the sha256 and bytes of what is in the
 * bucket, and, decrypted with the rehearsal's age key, the WAL file's bytes and the system
 * identifier its header names (offset 24 of a segment). The files go in /var/tmp, on the
 * container's disk: its /tmp is a small tmpfs, for the scripts' own files.
 */
function walContents(paths: string[]) {
  const script = [
    'set -eu',
    'for path in "$@"; do',
    '  rclone cat "backups:$BACKUP_BUCKET/$path" >/var/tmp/object',
    '  age --decrypt --identity /run/age/identity.txt </var/tmp/object | zstd -dcq >/var/tmp/wal',
    `  printf '%s %s %s %s %s\\n' "$path" "$(sha256sum </var/tmp/object | cut -d ' ' -f 1)" "$(wc -c </var/tmp/object)" "$(wc -c </var/tmp/wal)" "$(od -An -tu8 -j24 -N8 /var/tmp/wal | tr -d ' ')"`,
    'done',
  ].join('\n');
  const run = compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '--volume',
    `${slash(join(MIRROR, 'age'))}:/run/age:ro`,
    '--entrypoint',
    'sh',
    'backup',
    '-c',
    script,
    'sh',
    ...paths,
  ]);
  if (run.status !== 0) fail(`Reading WAL objects failed: ${run.stderr.trim()}`);
  return lines(run.stdout).map((line) => {
    const [path, sha256, bytes, plain, sysid] = line.split(' ');
    return { path, sha256, bytes: Number(bytes), plain: Number(plain), sysid };
  });
}

/** Waits up to `limit` seconds for the bucket to hold each of the WAL files; the names it found. */
async function walShipped(cluster: string, walfiles: string[], limit: number) {
  const started = Date.now();
  for (;;) {
    const names = walNames(cluster);
    const found = walfiles.map((walfile) =>
      names.find((name) => walObject(name)?.walfile === walfile),
    );
    if (found.every((name) => name !== undefined) || seconds(started) >= limit) {
      return { names, found, took: seconds(started) };
    }
    await sleep(5000);
  }
}

/**
 * The checks of shipped WAL objects: each name parses, its signature checks out with Node's crypto
 * against the rehearsal's public key, and it decrypts to the WAL file it names, of the cluster its
 * folder names. One line for the check, with the sizes.
 */
function walSigned(checks: Checks, env: Record<string, string>, what: string, paths: string[]) {
  const read = walContents(paths);
  const bad = read.flatMap(({ path, sha256, bytes, plain, sysid }) => {
    const parts = walObject(path);
    if (!parts) return [`${path}: not a name wal-ship.sh writes`];
    const message = walMessage(parts.cluster, parts.walfile, sha256);
    return [
      ...(signedBy(env.BACKUP_SIGNING_PUBLIC_KEY, message, parts.signature)
        ? []
        : [`${path}: the signature does not check out`]),
      ...(/^[0-9A-F]{24}$/.test(parts.walfile) &&
      (plain !== 16 * 1048576 || sysid !== parts.cluster)
        ? [
            `${path}: ${plain} bytes of cluster ${sysid} decrypted, not a segment of ${parts.cluster}`,
          ]
        : []),
      ...(bytes > 0 ? [] : [`${path}: empty`]),
    ];
  });
  const kib = read.map(({ bytes }) => Math.round(bytes / 1024));
  checks.expect(
    `${what}: ${read.length} objects, each name as wal-ship.sh writes it, its Ed25519 signature checked by Node against BACKUP_SIGNING_PUBLIC_KEY, each decrypting (the rehearsal's age key, zstd) to the 16 MiB segment of the cluster its folder names; ${kib.join(', ')} KiB in the bucket`,
    read.length === paths.length && read.length > 0 && !bad.length,
    bad.join('\n'),
  );
  return read;
}

// Step 3, once db runs: what it archives, and its host rules.
function walArchiving(checks: Checks) {
  const settings = dbSql(
    [
      "select string_agg(name || '=' || setting, ' ' order by name) from pg_settings where name in ('archive_mode', 'archive_library', 'archive_timeout', 'hba_file', 'wal_level');",
      "select current_setting('basic_archive.archive_directory', true);",
    ].join('\n'),
  );
  const spool = compose(['exec', '-T', 'db', 'stat', '-c', '%u:%g %a', '/wal-spool']).stdout.trim();
  checks.expect(
    `db archives every WAL file into the spool: ${settings[0]}, basic_archive.archive_directory=${settings[1]}; /wal-spool ${spool} (uid:gid mode), made so by wal-spool.sh`,
    settings[0] ===
      'archive_library=basic_archive archive_mode=on archive_timeout=60 hba_file=/etc/postgresql-menumesh/pg_hba.conf wal_level=logical' &&
      settings[1] === '/wal-spool' &&
      spool === '100:101 700',
    settings.join('\n'),
  );
  // The image's own file, from the very image db runs, and the kit's: the same, but for one line.
  const image = compose(['exec', '-T', 'db', 'cat', '/etc/postgresql/pg_hba.conf']).stdout;
  const kit = read('config', 'db', 'pg_hba.conf');
  const rules = dbSql(
    "select count(*) filter (where 'replication' = any(database)), count(*) filter (where error is not null) from pg_hba_file_rules",
  )[0];
  const identify = compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '--entrypoint',
    'psql',
    'backup',
    '-X',
    '-At',
    '-d',
    'dbname=replication replication=true',
    '-c',
    'IDENTIFY_SYSTEM',
  ]);
  const [systemid] = identify.stdout.trim().split('|');
  checks.expect(
    `db's host rules are the image's /etc/postgresql/pg_hba.conf byte for byte, then "${REPLICATION_LINE}" (pg_hba_file_rules: ${rules.replace('\t', ' replication line, ')} errors); the backup service's replication connection is let in with the password (IDENTIFY_SYSTEM: system ${systemid})`,
    kit === `${image}${REPLICATION_LINE}\n` &&
      rules === '1\t0' &&
      identify.status === 0 &&
      systemid === clusterId(),
    `${identify.stdout}${identify.stderr}`,
  );
}

// Step 8: the backup service and the bucket's stand-in: db's WAL shipped, signed, from a quiet log.
async function walShipping(checks: Checks, env: Record<string, string>) {
  const s3 = compose(['up', '-d', '--wait', '--wait-timeout', '60', 's3']);
  if (s3.status !== 0) fail(`s3 did not start:\n${tail(s3.stderr)}`);
  const since = daemonNow();
  const started = Date.now();
  const running = () => {
    const id = containerOf('backup');
    const state = id && docker(['inspect', '--format', '{{.State.Running}}', id]).stdout.trim();
    return state === 'true' ? id : undefined;
  };
  const before = running();
  const backup = compose(['up', '-d', 'backup']);
  if (backup.status !== 0) fail(`backup did not start:\n${tail(backup.stderr)}`);
  const fresh = running() !== before;
  const cluster = clusterId();
  const walfile = writeWal();
  const shipped = await walShipped(cluster, [walfile], 200);
  const waiting = walWaiting();
  checks.expect(
    `the backup service ships db's WAL to the local S3: ${walfile}, archived by a switch after about 8 MiB of WAL, is under wal/${cluster}/ ${shipped.took} s after the switch (the service ${fresh ? 'just started' : 'already up'}; ${shipped.names.length} objects there); the spool holds ${waiting.spool.length} WAL files and the outbox ${waiting.outbox.length}`,
    shipped.found.every((name) => name !== undefined) &&
      !waiting.spool.includes(walfile) &&
      !waiting.outbox.includes(`${walfile}.zst.age`),
    `${shipped.names.join('\n')}\nspool: ${waiting.spool.join(' ')}\noutbox: ${waiting.outbox.join(' ')}`,
  );
  walSigned(checks, env, `the shipped WAL of ${cluster}`, shipped.names.slice(-5));
  // The image's base declares a volume for Postgres's data, which the service covers with a
  // tmpfs: else Docker gives it an anonymous volume, which outlives the container. Its /tmp is a
  // tmpfs too, so a full disk can't stop its scripts before they alert.
  const [mountsJson, tmpfsJson] = docker([
    'inspect',
    '--format',
    '{{json .Mounts}}\n{{json .HostConfig.Tmpfs}}',
    containerOf('backup') ?? fail('backup has no container'),
  ])
    .stdout.trim()
    .split('\n');
  const mounts = (JSON.parse(mountsJson || 'null') ?? []) as {
    Type: string;
    Name?: string;
    Destination: string;
  }[];
  const tmpfs = [
    ...Object.keys(JSON.parse(tmpfsJson || 'null') ?? {}),
    ...mounts.filter((mount) => mount.Type === 'tmpfs').map((mount) => mount.Destination),
  ];
  const volumes = mounts.filter((mount) => mount.Type === 'volume');
  const anonymous = volumes.filter((mount) => !mount.Name?.startsWith(`${PROJECT}_`));
  checks.expect(
    `the backup service's volumes are the project's own (${volumes.map((mount) => `${mount.Name} at ${mount.Destination}`).join(', ')}), and a tmpfs covers its image's /var/lib/postgresql/data: no anonymous volume; its /tmp is a tmpfs`,
    !anonymous.length && tmpfs.includes('/var/lib/postgresql/data') && tmpfs.includes('/tmp'),
    `${mountsJson}\n${tmpfsJson}`,
  );
  // Silent on success, db and the shipper alike: wait out three of the shipper's minutes.
  while (seconds(started) < 180) await sleep(5000);
  const db = logsSince(containerOf('db') ?? fail('db has no container'), since);
  const shipper = logsSince(containerOf('backup') ?? fail('backup has no container'), since);
  const memory = cgroupMemory(containerOf('backup') ?? '');
  checks.expect(
    `${seconds(started)} s of WAL shipping, every minute: db wrote ${db.length} log lines and the backup service ${shipper.length}; the service's memory peaked at ${memory?.peak ?? '?'} MiB of its ${value('backup', 'mem_limit')}`,
    !db.length && !shipper.length,
    [...db, ...shipper].join('\n'),
  );
}

/**
 * seal.sh in the backup image, with the rehearsal's signing pair from .env and a throwaway pair
 * made here: openssl signs as Node does (Ed25519 is deterministic, so the very signature), takes
 * what Node signed, and refuses a changed message, another key's signature and each other spelling
 * of a good one (one character changed, padding, the last character's unused bits set, one short).
 * With several public keys any one does, the first alone for the self-check; the private key is
 * out of the environment children get; 300 random signatures go to base64url and back through
 * BusyBox's base64 and tr; no file stays in /tmp. Nothing printed holds the private key.
 */
function sealProof(checks: Checks, env: Record<string, string>) {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const a = `menumesh wal 1 1 000000010000000000000001 ${sha('a')}\n`;
  const b = `menumesh wal 1 1 000000010000000000000002 ${sha('b')}\n`;
  const own = signedWith(env.BACKUP_SIGNING_KEY, a);
  const other = generateKeyPairSync('ed25519');
  const otherPublic = other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const otherSecret = other.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const swapAt = (text: string, at: number, char: string) =>
    `${text.slice(0, at)}${char}${text.slice(at + 1)}`;
  const given: Record<string, string> = {
    SIG_A: own,
    SIG_B: signedWith(env.BACKUP_SIGNING_KEY, b),
    SIG_OTHER: signedWith(otherSecret, a),
    BAD_MIDDLE: swapAt(own, 40, own[40] === 'A' ? 'B' : 'A'),
    BAD_PADDED: `${own}==`,
    BAD_UNUSED: swapAt(own, 85, alphabet[alphabet.indexOf(own[85]) ^ 1]),
    BAD_SHORT: own.slice(0, 85),
    OTHER_PUBLIC_KEY: otherPublic,
    MESSAGE_A: a.trimEnd(),
    MESSAGE_B: b.trimEnd(),
  };
  const script = [
    'set -eu',
    '. /usr/local/share/menumesh/seal.sh',
    'said() { if "$@" 2>/dev/null; then echo yes; else echo no; fi; }',
    `printf '%s\\n' "$MESSAGE_A" >/tmp/a`,
    `printf '%s\\n' "$MESSAGE_B" >/tmp/b`,
    'echo "signs-as-node $([ "$(seal_sign /tmp/a)" = "$SIG_A" ] && echo yes || echo no)"',
    'echo "own $(said seal_verify /tmp/a "$SIG_A")"',
    'echo "node $(said seal_verify /tmp/b "$SIG_B")"',
    'echo "changed-message $(said seal_verify /tmp/b "$SIG_A")"',
    'echo "other-key $(said seal_verify /tmp/a "$SIG_OTHER")"',
    'for bad in BAD_MIDDLE BAD_PADDED BAD_UNUSED BAD_SHORT; do eval "sig=\\$$bad"; echo "$bad $(said seal_verify /tmp/a "$sig")"; done',
    'echo "empty $(said seal_verify /tmp/a "")"',
    'echo "self-check $(said seal_self_check)"',
    'BACKUP_SIGNING_PUBLIC_KEY="$OTHER_PUBLIC_KEY $BACKUP_SIGNING_PUBLIC_KEY"',
    'echo "any-of-two $(said seal_verify /tmp/a "$SIG_A")"',
    'echo "other-listed $(said seal_verify /tmp/a "$SIG_OTHER")"',
    'echo "first-only $(said seal_verify_first /tmp/a "$SIG_A")"',
    'echo "self-check-other-first $(said seal_self_check)"',
    'echo "key-in-children $(env | grep -c "^BACKUP_SIGNING_KEY=" || true)"',
    'n=0; bad=0',
    'while [ "$n" -lt 300 ]; do',
    '  head -c 64 /dev/urandom >/tmp/r',
    '  enc=$(seal_b64url </tmp/r)',
    `  printf '%s==\\n' "$enc" | tr '_-' '/+' | base64 -d >/tmp/back`,
    '  cmp -s /tmp/r /tmp/back || bad=$((bad + 1))',
    '  case $enc in *[!A-Za-z0-9_-]*) bad=$((bad + 1)) ;; esac',
    '  [ "${#enc}" -eq 86 ] || bad=$((bad + 1))',
    '  n=$((n + 1))',
    'done',
    'echo "round-trips-bad $bad"',
    'echo "left-in-tmp $(ls -A /tmp | grep -c "^seal\\." || true)"',
  ].join('\n');
  const run = compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    ...Object.entries(given).flatMap(([name, text]) => ['-e', `${name}=${text}`]),
    '--entrypoint',
    'sh',
    'backup',
    '-c',
    script,
  ]);
  const said = Object.fromEntries(lines(run.stdout).map((line) => line.split(' ')));
  const expected: Record<string, string> = {
    'signs-as-node': 'yes',
    own: 'yes',
    node: 'yes',
    'changed-message': 'no',
    'other-key': 'no',
    BAD_MIDDLE: 'no',
    BAD_PADDED: 'no',
    BAD_UNUSED: 'no',
    BAD_SHORT: 'no',
    empty: 'no',
    'self-check': 'yes',
    'any-of-two': 'yes',
    'other-listed': 'yes',
    'first-only': 'no',
    'self-check-other-first': 'no',
    'key-in-children': '0',
    'round-trips-bad': '0',
    'left-in-tmp': '0',
  };
  const wrong = Object.entries(expected).filter(([name, answer]) => said[name] !== answer);
  const output = `${run.stdout}${run.stderr}`;
  checks.expect(
    `seal.sh in the backup image: openssl signs as Node does and takes Node's signature; a changed message, another key's signature, a changed character, padding, unused bits set, a short or an empty signature are refused; with two public keys either checks, the first alone for the self-check; the private key reaches no child; 300 random signatures to base64url and back in BusyBox; nothing left in /tmp`,
    run.status === 0 && !wrong.length && !output.includes(env.BACKUP_SIGNING_KEY),
    wrong.length
      ? wrong
          .map(([name, answer]) => `${name}: ${said[name] ?? 'nothing'}, not ${answer}`)
          .join('\n')
      : tail(output),
  );
}

/**
 * seal.sh's seal_open in the backup image against sealOf and signedBy here (VPS-43): a seal signed
 * with the rehearsal's key, one of a night without a base, and each way a text can fail to be one
 * (another key, a byte changed after signing, another night, a part twice or of another night or
 * database, a base line its parts don't match, a carriage return, a tab, a NUL, no last newline, an
 * empty file, one a byte too long, a padded signature, a wrong case), each given to both as the
 * same bytes: the shell's verdict must be Node's, word for word. For the good seal it also prints
 * what it read, which must be what was written.
 */
function sealOpenProof(checks: Checks, env: Record<string, string>) {
  const night = '2026-11-01T2030Z-0123abcd';
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
  const key = env.BACKUP_SIGNING_KEY;
  const good = sealText(night, base, parts, key);
  const signedBody = (body: string) => `${body}signature ${signedWith(key, body)}\n`;
  const bodyOf = (text: string) => text.slice(0, text.lastIndexOf('signature '));
  const noBase = parts.filter(({ name }) => !name.startsWith('base-'));
  const variants: Record<string, string> = {
    good,
    'base-none': sealText(night, undefined, noBase, key),
    'other-key': sealText(night, base, parts, otherSigningKey()),
    'changed-after': good.replace(' 7491 ', ' 7492 '),
    'other-night': sealText('2026-11-02T2030Z-0123abcd', base, parts, key),
    'part-twice': sealText(night, base, [...parts, parts[0]], key),
    'other-nights-part': sealText(
      night,
      base,
      [...parts, { ...parts[0], name: 'globals-2026-11-02T2030Z-0123abcd.sql.age' }],
      key,
    ),
    'template-dump': sealText(
      night,
      base,
      [...parts, { ...parts[3], name: `template1-${night}.dump.age` }],
      key,
    ),
    'base-without-part': sealText(night, base, noBase, key),
    'part-without-base': sealText(night, undefined, parts, key),
    'carriage-return': signedBody(bodyOf(good).replace('\n', '\r\n')),
    tab: signedBody(bodyOf(good).replace('part ', 'part\t')),
    nul: `${good.slice(0, 20)}\0${good.slice(21)}`,
    'no-last-newline': good.slice(0, -1),
    empty: '',
    'too-long': `${good}${'#'.repeat(SEAL_MAX + 1 - good.length)}`,
    'padded-signature': `${good.slice(0, -1)}==\n`,
    'upper-hex': signedBody(bodyOf(good).replace(parts[0].sha256, parts[0].sha256.toUpperCase())),
    'two-spaces': signedBody(bodyOf(good).replace('part ', 'part  ')),
    'no-signature': bodyOf(good),
  };
  const script = [
    'set -eu',
    '. /usr/local/share/menumesh/seal.sh',
    'mkdir -p /tmp/v',
    'while read -r name text; do printf %s "$text" | base64 -d >"/tmp/v/$name"; done',
    'for file in /tmp/v/*; do',
    '  if seal_open "$file" "$NIGHT"; then echo "${file##*/} ok"; else echo "${file##*/} $seal_problem"; fi',
    'done',
    'seal_open /tmp/v/good "$NIGHT"',
    'printf "read %s\\n" "$seal_base"',
    `printf '%s\\n' "$seal_parts" | sed 's/^/read /'`,
    'printf "part %s\\n" "$(seal_part "postgres-$NIGHT.dump.age")"',
    'printf "missing [%s]\\n" "$(seal_part "nothing-$NIGHT.dump.age")"',
    'echo "left-in-tmp $(ls -A /tmp | grep -c "^seal\\." || true)"',
  ].join('\n');
  const input = Object.entries(variants)
    .map(([name, text]) => `${name} ${Buffer.from(text, 'latin1').toString('base64')}`)
    .join('\n');
  const run = compose(
    [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '-e',
      `NIGHT=${night}`,
      '--entrypoint',
      'sh',
      'backup',
      '-c',
      script,
    ],
    `${input}\n`,
  );
  const said = new Map(
    lines(run.stdout)
      .filter((line) => !/^(read|part|missing|left-in-tmp) /.test(line))
      .map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]),
  );
  const wrong = Object.entries(variants).flatMap(([name, text]) => {
    const want = sealVerdict(text, night, env.BACKUP_SIGNING_PUBLIC_KEY);
    return said.get(name) === want
      ? []
      : [`${name}: the shell says "${said.get(name)}", Node "${want}"`];
  });
  const read = lines(run.stdout)
    .filter((line) => line.startsWith('read '))
    .map((line) => line.slice(5));
  const wantRead = [
    `${base.end} ${base.walfile} ${base.cluster}`,
    ...parts.map(({ sha256, bytes, name }) => `${sha256} ${bytes} ${name}`),
  ];
  const refused = [...said.values()].filter((verdict) => verdict !== 'ok').length;
  checks.expect(
    `seal.sh's seal_open in BusyBox gives Node's verdict on ${said.size} texts: the backup's seal and one without a base taken, and read back as written; ${refused} refused, each in the words sealOf uses (another key, a byte changed after signing, another night, a part twice or not a night's, a base line its parts don't match, a carriage return, a tab, a NUL, no last newline, empty, ${SEAL_MAX + 1} bytes, a padded signature, upper-case hex, two spaces, no signature line); nothing left in /tmp`,
    run.status === 0 &&
      !wrong.length &&
      said.size === Object.keys(variants).length &&
      said.get('good') === 'ok' &&
      said.get('base-none') === 'ok' &&
      refused === Object.keys(variants).length - 2 &&
      read.join('\n') === wantRead.join('\n') &&
      run.stdout.includes(`\npart ${parts[3].sha256} ${parts[3].bytes}\n`) &&
      run.stdout.includes('\nmissing []\n') &&
      run.stdout.includes('\nleft-in-tmp 0\n'),
    wrong.length ? wrong.join('\n') : tail(`${run.stdout}${run.stderr}`),
  );
}

/**
 * wal-ship.sh's ways of failing, apart from the rehearsal's own spool and bucket: the backup
 * image's script, run as crond runs it (uid 100, gid 101, no capability), against a Postgres 17 of
 * its own (the backup image's base), rclone's S3 server and a spool volume of its own, with the
 * rehearsal's throwaway keys and Telegram and the heartbeat in the sinkhole. Segments are 16 MiB
 * stand-ins whose long page header names a cluster; a file is made to look older to wait. Every
 * object carries the project's label, so vps:down removes what a run that stopped left.
 */
async function shipperPaths(checks: Checks, env: Record<string, string>) {
  const tag = `menumesh-rehearsal-walship-${process.pid}`;
  const [net, pg, s3, spool, tmp] = ['net', 'pg', 's3', 'spool', 'tmp'].map(
    (part) => `${tag}-${part}`,
  );
  const label = ['--label', `com.docker.compose.project=${PROJECT}`];
  const image = REHEARSAL_IMAGES.BACKUP_IMAGE;
  const postgres =
    /^FROM (postgres:\S+@sha256:[0-9a-f]{64})$/m.exec(read('backup', 'Dockerfile'))?.[1] ??
    fail("The backup image's Dockerfile has no pinned postgres base");
  const rclone =
    /^ {4}image: (rclone\/rclone:\S+)$/m.exec(readFileSync(OVERRIDE, 'utf8'))?.[1] ??
    fail('The rehearsal override has no rclone image');
  const password = randomBytes(12).toString('hex');
  const full = `${tag}-full`;
  const cleanup = () => {
    docker(['rm', '--force', pg, s3, `${tag}-lock`, full]);
    docker(['volume', 'rm', '--force', spool, tmp]);
    docker(['network', 'rm', net]);
  };
  // Postgres once its image's init is over: Postgres itself is then process 1. With an archive
  // command, it archives through it (/bin/true takes every file).
  const startPostgres = async (archive?: string) => {
    const run = docker(
      [
        'run',
        '--detach',
        '--name',
        pg,
        ...label,
        '--network',
        net,
        '--env',
        'POSTGRES_PASSWORD',
        postgres,
        ...(archive ? ['-c', 'archive_mode=on', '-c', `archive_command=${archive}`] : []),
      ],
      undefined,
      { POSTGRES_PASSWORD: password },
    );
    if (run.status !== 0) fail(`The shipper's test Postgres did not start: ${run.stderr.trim()}`);
    for (let tries = 0; tries < 60; tries++) {
      const ready = docker([
        'exec',
        pg,
        'sh',
        '-c',
        '[ "$(cat /proc/1/comm)" = postgres ] && psql -X -At -U postgres -c "select 1"',
      ]);
      if (ready.stdout.trim() === '1') break;
      await sleep(1000);
    }
    const id = docker([
      'exec',
      pg,
      'psql',
      '-X',
      '-At',
      '-U',
      'postgres',
      '-c',
      'select system_identifier from pg_control_system()',
    ]).stdout.trim();
    return /^\d+$/.test(id) ? id : fail(`The shipper's test Postgres has no identifier: ${id}`);
  };
  // The shipper's environment, its values handed to the docker client's own (never its arguments).
  const settings = (extra: Record<string, string> = {}) => ({
    PGHOST: pg,
    PGUSER: 'postgres',
    PGPASSWORD: password,
    BACKUP_AGE_RECIPIENT: env.BACKUP_AGE_RECIPIENT,
    BACKUP_BUCKET: env.BACKUP_BUCKET,
    RCLONE_CONFIG_BACKUPS_TYPE: 's3',
    RCLONE_CONFIG_BACKUPS_PROVIDER: 'Other',
    RCLONE_CONFIG_BACKUPS_ENDPOINT: 'http://s3:9000',
    RCLONE_CONFIG_BACKUPS_ACCESS_KEY_ID: env.BACKUP_S3_ACCESS_KEY_ID,
    RCLONE_CONFIG_BACKUPS_SECRET_ACCESS_KEY: env.BACKUP_S3_SECRET_ACCESS_KEY,
    RCLONE_CONFIG_BACKUPS_NO_CHECK_BUCKET: 'true',
    BACKUP_SIGNING_KEY: env.BACKUP_SIGNING_KEY,
    BACKUP_SIGNING_PUBLIC_KEY: env.BACKUP_SIGNING_PUBLIC_KEY,
    TELEGRAM_BOT_TOKEN: 'rehearsal',
    TELEGRAM_CHAT_ID: 'rehearsal',
    HEARTBEAT_WAL_URL: 'https://hc-ping.com/menumesh-rehearsal-wal',
    ...extra,
  });
  const named = (values: Record<string, string>) =>
    Object.keys(values).flatMap((name) => ['--env', name]);
  // One run of the shipper as crond starts it; /tmp is a volume, as the service's outlives a run.
  const ship = (extra: Record<string, string> = {}) => {
    const values = settings(extra);
    const run = docker(
      [
        'run',
        '--rm',
        ...label,
        '--network',
        net,
        '--user',
        '100:101',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--add-host',
        'api.telegram.org:0.0.0.0',
        '--add-host',
        'hc-ping.com:0.0.0.0',
        '--volume',
        `${spool}:/wal-spool`,
        '--volume',
        `${tmp}:/tmp`,
        ...named(values),
        '--entrypoint',
        '/usr/local/bin/wal-ship.sh',
        image,
      ],
      undefined,
      values,
    );
    return lines(`${run.stdout}${run.stderr}`);
  };
  // A script in the spool, with the shipper's /tmp, where its record goes while the spool can't
  // keep it.
  const inSpool = (script: string, user = '100:101') =>
    docker([
      'run',
      '--rm',
      ...label,
      '--user',
      user,
      '--volume',
      `${spool}:/wal-spool`,
      '--volume',
      `${tmp}:/tmp`,
      '--entrypoint',
      'sh',
      image,
      '-c',
      script,
    ]);
  // A segment's stand-in: 16 MiB whose long page header names the cluster (offset 24, as the
  // machine's uint64), the rest random; `ago` seconds old.
  const segment = (name: string, cluster: string, ago = 0) => {
    const header = Buffer.alloc(8);
    header.writeBigUInt64LE(BigInt(cluster));
    const octal = [...header].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('');
    const made = inSpool(
      `cd /wal-spool && { head -c 24 /dev/zero; printf '${octal}'; head -c ${16 * 1048576 - 32} /dev/urandom; } >.made && mv .made ${name} && touch -d @$(($(date +%s) - ${ago})) ${name}`,
    );
    if (made.status !== 0) fail(`Making the segment ${name} failed: ${made.stderr.trim()}`);
  };
  const objects = () =>
    lines(
      docker(
        [
          'run',
          '--rm',
          ...label,
          '--network',
          net,
          ...named(settings()),
          '--entrypoint',
          'sh',
          image,
          '-c',
          'rclone lsf -R --files-only "backups:$BACKUP_BUCKET/wal/"',
        ],
        undefined,
        settings(),
      ).stdout,
    );
  const shipped = (walfile: string) => objects().some((name) => name.includes(`/${walfile}.`));
  const listing = (folder: string) => lines(inSpool(`ls -A ${folder}`).stdout);
  const kept = () => inSpool('cat /wal-spool/.ship/system-identifier').stdout.trim();
  // As after a long quiet: no alert in the last hour and no heartbeat in the last 5 minutes, in
  // the spool and in /tmp, which the shipper reads too.
  const quiet = () =>
    inSpool(
      'for at in /wal-spool/.ship /tmp/wal-ship; do rm -f "$at/alert-sent" "$at/alerting" "$at/beat"; done',
    );
  const says = (log: string[], text: string) => log.some((line) => line.includes(text));
  const alerts = (log: string[]) =>
    log.filter((line) => line.startsWith('wal-ship: [menumesh] WAL is not reaching the bucket'));
  const heartbeat = 'notify: the heartbeat ping failed (curl exit 7)';
  const resumed = 'wal-ship: [menumesh] WAL shipping resumed';

  cleanup();
  try {
    docker(['network', 'create', ...label, net]);
    for (const volume of [spool, tmp]) docker(['volume', 'create', ...label, volume]);
    docker([
      'run',
      '--rm',
      ...label,
      '--volume',
      `${tmp}:/tmp`,
      '--entrypoint',
      'chmod',
      image,
      '1777',
      '/tmp',
    ]);
    const started = docker(
      [
        'run',
        '--detach',
        '--name',
        s3,
        ...label,
        '--network',
        net,
        '--network-alias',
        's3',
        '--env',
        'RCLONE_AUTH_KEY',
        '--entrypoint',
        'sh',
        rclone,
        '-c',
        `mkdir -p /data/${env.BACKUP_BUCKET} && exec rclone serve s3 /data --addr :9000`,
      ],
      undefined,
      {
        RCLONE_AUTH_KEY: `"${env.BACKUP_S3_ACCESS_KEY_ID},${env.BACKUP_S3_SECRET_ACCESS_KEY}"`,
      },
    );
    if (started.status !== 0) fail(`The shipper's test S3 did not start: ${started.stderr.trim()}`);
    const cluster = await startPostgres('/bin/true');

    // A spool still root's and 0755, as Docker makes a volume, then made postgres's as db's
    // wal-spool.sh makes it.
    const broken = ship();
    inSpool('chown 100:101 /wal-spool && chmod 0700 /wal-spool', '0:0');
    segment('000000010000000000000001', cluster);
    const fixed = ship();
    const healthy = ship();
    checks.expect(
      `the shipper on a spool that is not yet postgres's: one alert at once ("${alerts(broken)[0]?.slice(10) ?? ''}"); made postgres's, the next run ships, says it resumed and pings the heartbeat; a healthy run prints nothing`,
      alerts(broken).length === 1 &&
        says(broken, "is not db's postgres's to write") &&
        shipped('000000010000000000000001') &&
        says(fixed, resumed) &&
        fixed.includes(heartbeat) &&
        !healthy.length,
      [...broken, '--', ...fixed, '--', ...healthy].join('\n'),
    );

    // Another run while one holds the lock.
    const lock = docker([
      'run',
      '--detach',
      '--name',
      `${tag}-lock`,
      ...label,
      '--user',
      '100:101',
      '--volume',
      `${spool}:/wal-spool`,
      '--entrypoint',
      'sh',
      image,
      '-c',
      'exec 9>>/wal-spool/.ship/lock && flock 9 && sleep 60',
    ]);
    await sleep(2000);
    segment('000000010000000000000002', cluster);
    const locked = ship();
    const waited = listing('/wal-spool').includes('000000010000000000000002');
    docker(['rm', '--force', `${tag}-lock`]);
    checks.expect(
      'a run while another holds the spool leaves at once, silently, and ships nothing',
      lock.status === 0 && !locked.length && waited && !shipped('000000010000000000000002'),
      locked.join('\n'),
    );
    ship();

    // A private key that is not the pair of the first public key: no wait mends it, so the alert
    // comes at once, with the file just archived.
    const other = generateKeyPairSync('ed25519')
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64');
    const wrong = { BACKUP_SIGNING_PUBLIC_KEY: `${other} ${env.BACKUP_SIGNING_PUBLIC_KEY}` };
    quiet();
    segment('000000010000000000000003', cluster);
    const refused = ship(wrong);
    const outbox = listing('/wal-spool/.ship/out');
    const again = ship(wrong);
    const right = ship();
    const after = ship();
    checks.expect(
      `a signing key that is not the pair of BACKUP_SIGNING_PUBLIC_KEY's first key: nothing uploaded, the file kept in the outbox, one alert at once ("${alerts(refused)[0]?.split(': ').slice(2).join(': ') ?? ''}") and none more within the hour; with the right key it ships and says it resumed, and the next run prints nothing`,
      alerts(refused).length === 1 &&
        says(
          refused,
          "BACKUP_SIGNING_KEY does not sign what BACKUP_SIGNING_PUBLIC_KEY's first key checks",
        ) &&
        !says(refused, 'waited') &&
        outbox.includes('000000010000000000000003.zst.age') &&
        !again.length &&
        says(right, resumed) &&
        shipped('000000010000000000000003') &&
        !after.length,
      [...refused, '--', ...again, '--', ...right, '--', ...after].join('\n'),
    );

    // The bucket out of reach.
    docker(['stop', s3]);
    quiet();
    segment('000000010000000000000004', cluster, 12 * 60);
    const begun = Date.now();
    const unreachable = ship();
    const took = seconds(begun);
    const held = listing('/wal-spool/.ship/out').includes('000000010000000000000004.zst.age');
    const raw = listing('/wal-spool').includes('000000010000000000000004');
    docker(['start', s3]);
    await sleep(3000);
    ship();
    const back = ship();
    checks.expect(
      `the bucket out of reach, with a file 12 minutes old: the raw file still goes to the outbox, and one alert with rclone's first lines, control characters dropped (the run took ${took} s); back, it ships, then says it resumed`,
      alerts(unreachable).length === 1 &&
        says(unreachable, 'the oldest WAL file waited 12 minutes') &&
        says(unreachable, 'the upload of 000000010000000000000004 to the bucket failed (rclone)') &&
        unreachable.some((line) => line.startsWith('wal-ship: | ')) &&
        held &&
        !raw &&
        shipped('000000010000000000000004') &&
        says(back, resumed),
      [...unreachable, '--', ...back].join('\n'),
    );

    // A segment of another cluster in the spool, just archived.
    quiet();
    segment('000000010000000000000005', '7000000000000000001');
    const foreign = ship();
    checks.expect(
      'a segment whose header names another cluster: nothing more ships, and one alert at once, naming both',
      alerts(foreign).length === 1 &&
        says(
          foreign,
          `the WAL file 000000010000000000000005 names the cluster 7000000000000000001, not ${cluster}`,
        ) &&
        !says(foreign, 'waited') &&
        !shipped('000000010000000000000005'),
      foreign.join('\n'),
    );
    inSpool('rm -f /wal-spool/000000010000000000000005');
    ship();

    // A kept identifier of another cluster, as after a recovery onto the old spool.
    quiet();
    inSpool("printf '7000000000000000001\\n' >/wal-spool/.ship/system-identifier");
    segment('000000010000000000000006', cluster);
    const changed = ship();
    const keptThen = kept();
    inSpool('rm -f /wal-spool/000000010000000000000006');
    const taken = ship();
    checks.expect(
      `a kept identifier of another cluster while a file waits: nothing ships, and one alert at once ("…${alerts(changed)[0]?.split('): ').slice(1).join('): ').slice(0, 70) ?? ''}…"); with nothing waiting the new identifier is taken, and the run says it resumed`,
      alerts(changed).length === 1 &&
        says(
          changed,
          `db's system identifier is now ${cluster}, not the 7000000000000000001 kept, and 1 WAL files wait`,
        ) &&
        !says(changed, 'waited') &&
        keptThen === '7000000000000000001' &&
        !shipped('000000010000000000000006') &&
        kept() === cluster &&
        says(taken, resumed),
      [...changed, '--', ...taken].join('\n'),
    );

    // Names basic_archive never writes, an old temporary copy of its own, and a history file.
    inSpool(
      "cd /wal-spool && echo x >notes.txt && echo x >000000010000000000000007.tmp && echo x >archtemp.000000010000000000000007.1.2 && touch -d @$(($(date +%s) - 7200)) archtemp.000000010000000000000007.1.2 && printf '1\\t0/3000000\\tno recovery target specified\\n' >00000002.history",
    );
    const others = ship();
    const left = listing('/wal-spool');
    const names = objects();
    checks.expect(
      'names basic_archive never writes stay in the spool and never ship; its temporary copy over an hour old goes; a history file ships under wal/<cluster>/history/',
      !others.length &&
        left.includes('notes.txt') &&
        left.includes('000000010000000000000007.tmp') &&
        !left.includes('archtemp.000000010000000000000007.1.2') &&
        !left.includes('00000002.history') &&
        names.some((name) => name.startsWith(`${cluster}/history/00000002.history.`)) &&
        !names.some((name) => /notes|\.tmp\./.test(name)),
      [...others, '--', ...left, '--', ...names].join('\n'),
    );

    // A db that archives nothing, then no db at all.
    docker(['rm', '--force', pg]);
    const second = await startPostgres();
    quiet();
    const idle = ship();
    docker(['stop', pg]);
    segment('000000010000000000000008', second);
    quiet();
    const down = ship();
    checks.expect(
      'a db that archives nothing (archive_mode off): one alert at once and no heartbeat; with db down, a segment of the kept cluster still ships under it, silently',
      alerts(idle).length === 1 &&
        says(idle, 'db archives no WAL (archive_mode is off)') &&
        !idle.includes(heartbeat) &&
        kept() === second &&
        objects().some((name) => name.startsWith(`${second}/00000000/000000010000000000000008.`)) &&
        !down.length,
      [...idle, '--', ...down].join('\n'),
    );

    // A disk too full for the shipper's record (Stop C's review, finding C3): the spool a tmpfs of
    // 1 MiB filled to its last page, in a container that stays up as the service's does, each run
    // started in it as crond starts one, with /tmp as compose.yml gives the backup service; db's
    // archiver fails every file (its command fails until a file is there, as a full disk fails
    // basic_archive's copy). The run keeps its record in /tmp instead of stopping at its first
    // write; once db's archiver has failed for 10 minutes (its first failure made 15 minutes old)
    // it alerts once, and the next run stays quiet within the hour; with room again, and db
    // archiving, it says it resumed.
    docker(['rm', '--force', pg]);
    const third = await startPostgres('test -f /tmp/menumesh-archive-ok');
    const sql = (...statements: string[]) =>
      docker([
        'exec',
        pg,
        'psql',
        '-X',
        '-At',
        '-U',
        'postgres',
        ...statements.flatMap((statement) => ['-c', statement]),
      ]).stdout.trim();
    sql('create table rehearsal_full (x int)', 'insert into rehearsal_full values (1)');
    sql('select pg_switch_wal()');
    for (let tries = 0; tries < 30; tries++) {
      if (sql('select failed_count > 0 from pg_stat_archiver') === 't') break;
      await sleep(1000);
    }
    const tmpOptions = /'\/tmp:([^']+)'/.exec(value('backup', 'tmpfs'))?.[1];
    const fullSettings = settings();
    const holder = docker(
      [
        'run',
        '--detach',
        '--name',
        full,
        ...label,
        '--network',
        net,
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--add-host',
        'api.telegram.org:0.0.0.0',
        '--add-host',
        'hc-ping.com:0.0.0.0',
        '--tmpfs',
        '/wal-spool:size=1m,uid=100,gid=101,mode=0700',
        ...(tmpOptions ? ['--tmpfs', `/tmp:${tmpOptions}`] : []),
        ...named(fullSettings),
        '--entrypoint',
        'sleep',
        image,
        '900',
      ],
      undefined,
      fullSettings,
    );
    if (holder.status !== 0) fail(`The full disk's container did not start: ${holder.stderr}`);
    const inFull = (script: string) =>
      docker(['exec', '--user', '100:101', full, 'sh', '-c', script]);
    const shipFull = () => {
      const run = docker(['exec', '--user', '100:101', full, '/usr/local/bin/wal-ship.sh']);
      return lines(`${run.stdout}${run.stderr}`);
    };
    // The spool as the shipper left it before the disk filled: its cluster kept, its lock there.
    const filled = inFull(
      `mkdir -p /wal-spool/.ship/out && printf '%s\\n' ${third} >/wal-spool/.ship/system-identifier && printf '' >/wal-spool/.ship/lock && { head -c 2097152 /dev/zero >/wal-spool/.fill 2>/dev/null || true; } && if printf x >/wal-spool/.probe 2>/dev/null; then echo room; else echo full; fi`,
    ).stdout.trim();
    const fullFirst = shipFull();
    const spared = inFull('cat /tmp/wal-ship/archiver-failing').stdout.trim();
    inFull(`printf '%s\\n' "$(($(date +%s) - 900))" >/tmp/wal-ship/archiver-failing`);
    const fullAlert = shipFull();
    const fullQuiet = shipFull();
    inFull('rm -f /wal-spool/.fill /wal-spool/.probe');
    docker(['exec', pg, 'touch', '/tmp/menumesh-archive-ok']);
    sql('insert into rehearsal_full values (2)', 'select pg_switch_wal()');
    for (let tries = 0; tries < 90; tries++) {
      if (
        sql(
          'select coalesce(last_archived_time > last_failed_time, false) from pg_stat_archiver',
        ) === 't'
      )
        break;
      await sleep(1000);
    }
    const fullResumed = shipFull();
    const ownError = (log: string[]) => says(log, 'stopped by an error of its own');
    checks.expect(
      `a disk too full for the shipper's record (the spool a 1 MiB tmpfs ${filled === 'full' ? 'filled to its last page' : 'not filled'}, /tmp ${tmpOptions ? `a tmpfs as compose.yml gives the backup service (${tmpOptions})` : 'the container’s own'}), db's archiver failing: the run goes on, its record in /tmp (${fullFirst.join(' / ') || 'nothing printed'}); 15 minutes into the failure one alert ("${alerts(fullAlert)[0]?.split(': ').slice(2).join(': ') ?? ''}"), and the next run quiet; with room again and db archiving, it says it resumed`,
      filled === 'full' &&
        !ownError(fullFirst) &&
        !alerts(fullFirst).length &&
        /^\d+$/.test(spared) &&
        alerts(fullAlert).length === 1 &&
        fullAlert.some((line) =>
          /db's archiver has failed for 1[56] minutes \(pg_stat_archiver\)$/.test(line),
        ) &&
        !ownError(fullAlert) &&
        !fullQuiet.length &&
        says(fullResumed, resumed) &&
        !ownError(fullResumed),
      [filled, ...fullFirst, '--', ...fullAlert, '--', ...fullQuiet, '--', ...fullResumed].join(
        '\n',
      ),
    );
  } finally {
    cleanup();
  }
}

/**
 * vps:backup-test's WAL: written, switched and shipped by the running service, every name signed
 * and every object the segment it names; then the service stopped and started again: the spool
 * grows while it is down, its files are made to look 15 minutes old, as after such an outage, and
 * once the service runs again, with its alert and heartbeat sent into the sinkhole, its first run
 * alerts and ships them, the next says it resumed and pings the heartbeat.
 */
async function walProof(checks: Checks, env: Record<string, string>) {
  // The service on the image just built, as app-deploy would bring it.
  const up = compose(['up', '-d', 'backup']);
  if (up.status !== 0) fail(`backup did not start:\n${tail(up.stderr)}`);
  const cluster = clusterId();
  const first = writeWal();
  const second = writeWal();
  const shipped = await walShipped(cluster, [first, second], 200);
  const waiting = walWaiting();
  checks.expect(
    `db's WAL in the bucket: ${first} and ${second}, each archived after about 8 MiB of WAL and a switch, under wal/${cluster}/ within ${shipped.took} s; neither waits in the spool or the outbox (${waiting.spool.length} and ${waiting.outbox.length} files there)`,
    shipped.found.every((name) => name !== undefined) &&
      [first, second].every(
        (walfile) =>
          !waiting.spool.includes(walfile) && !waiting.outbox.includes(`${walfile}.zst.age`),
      ),
    `${shipped.names.join('\n')}\nspool: ${waiting.spool.join(' ')}\noutbox: ${waiting.outbox.join(' ')}`,
  );
  const names = shipped.found.filter((name): name is string => name !== undefined);
  walSigned(checks, env, `the WAL files ${first} and ${second}`, names);
  const others = walNames(cluster).filter((name) => !walObject(name));
  checks.expect(
    `every object under wal/${cluster}/ is named as wal-ship.sh names one (${walNames(cluster).length} objects)`,
    !others.length,
    others.join('\n'),
  );

  // The outage: the service stopped, WAL written, the spool's files made 15 minutes old, and the
  // shipper's record as after such an outage, its last heartbeat and any alert (an earlier run's)
  // long gone.
  compose(['stop', 'backup']);
  const walfile = writeWal();
  let spooled = walWaiting().spool;
  for (let tries = 0; tries < 30 && !spooled.includes(walfile); tries++) {
    await sleep(1000);
    spooled = walWaiting().spool;
  }
  const ago = Math.floor(Date.parse(daemonNow()) / 1000) - 15 * 60;
  const aged = asShipper(
    `cd /wal-spool && touch -d @${ago} ${spooled.join(' ')} && rm -f .ship/beat .ship/alert-sent .ship/alerting`,
  );
  if (!spooled.includes(walfile) || aged.status !== 0) {
    fail(`The spool did not grow with the service stopped: ${spooled.join(' ')} ${aged.stderr}`);
  }
  const started = Date.now();
  const sunk = docker(composeArgs(['up', '-d', 'backup']), undefined, {
    TELEGRAM_BOT_TOKEN: 'rehearsal',
    TELEGRAM_CHAT_ID: 'rehearsal',
    HEARTBEAT_WAL_URL: 'https://hc-ping.com/menumesh-rehearsal-wal',
  });
  if (sunk.status !== 0) fail(`backup did not start again:\n${tail(sunk.stderr)}`);
  const id = containerOf('backup') ?? fail('backup has no container');
  let log: string[] = [];
  while (seconds(started) < 200) {
    log = lines(logsOf(id));
    if (log.some((line) => line.startsWith('notify: the heartbeat ping failed'))) break;
    await sleep(5000);
  }
  const kinds = log.map((line) =>
    line.startsWith('wal-ship: [menumesh] WAL is not reaching the bucket')
      ? 'alert'
      : line.startsWith('wal-ship: [menumesh] WAL shipping resumed')
        ? 'resumed'
        : line === 'notify: the Telegram alert failed (curl exit 7)'
          ? 'telegram'
          : line === 'notify: the heartbeat ping failed (curl exit 7)'
            ? 'heartbeat'
            : line,
  );
  const drained = walWaiting();
  const there = walNames(cluster).some((name) => walObject(name)?.walfile === walfile);
  checks.expect(
    `with the service stopped the spool grew (${spooled.join(', ')}); started again ${seconds(started)} s ago with Telegram and HEARTBEAT_WAL_URL in the sinkhole, it alerted once ("${log.find((line) => line.includes('not reaching')) ?? ''}"), shipped them (${walfile} ${there ? 'in the bucket' : 'not in the bucket'}, ${drained.spool.length + drained.outbox.length} waiting), said it resumed, then pinged the heartbeat: ${kinds.join(', ')}`,
    kinds.join(' ') === 'alert telegram resumed telegram heartbeat' &&
      /waited 1[5-9] minutes/.test(log[0] ?? '') &&
      there &&
      spooled.every(
        (name) => !drained.spool.includes(name) && !drained.outbox.includes(`${name}.zst.age`),
      ),
    log.join('\n'),
  );
  const memory = cgroupMemory(id);
  console.log(
    `    · the backup service's memory after these runs: at most ${memory?.peak ?? '?'} MiB of its ${value('backup', 'mem_limit')} (docker stats: ${memory?.stats ?? '?'} MiB)`,
  );
  // Back to its own settings, which send nothing.
  compose(['up', '-d', 'backup']);
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
  walArchiving(checks);
  console.log('4. Migrations, as app-deploy runs them');
  await migrations(checks);
  console.log('5. The pre-deploy dump');
  await predeployDump(checks, env);
  console.log('6. The seed, web and the scheduler');
  await seedAndStart(checks);
  console.log('7. The gateway');
  await gateway(checks, env);
  console.log('8. The WAL shipper: the backup service, with the local S3 for its bucket');
  await walShipping(checks, env);
  removeOldBuilds();
  console.log(
    `\nThe rehearsal stays up: the app on http://localhost:3300, Supabase on http://127.0.0.1:8300, the backup service shipping db's WAL to the local S3 (project ${PROJECT}, folder ${shown(MIRROR)}/). pnpm vps:down removes it.`,
  );
  console.log(`\nvps:rehearse: ${checks.passed + checks.failed} checks, ${checks.failed} failed`);
  if (checks.failed) process.exit(1);
}

// --- vps:backup-test (J.4 step 12; plan H) ---

/**
 * What a restore must give back, read the same way from a cluster and from its restore, one
 * "kind|name|attributes|more" line each: the roles with their memberships and settings; the
 * databases, schemas, relations, functions and types with their owners and grants (none written
 * means the owner's default); which extension each relation, function, type and sequence belongs
 * to; the extensions, event triggers, publications and their tables, policies, triggers and
 * constraints; every sequence's value; then every table's rows, as a hash of the rows sorted as
 * text. With an empty search_path every name is written in full.
 */
const FINGERPRINT = `
set search_path = '';
select 'role', rolname::text, concat(rolsuper::int, rolinherit::int, rolcreaterole::int, rolcreatedb::int, rolcanlogin::int, rolreplication::int, rolbypassrls::int), concat_ws(' ', rolconnlimit, coalesce(rolvaliduntil::text, '-'))
  from pg_roles where rolname !~ '^pg_'
union all
select 'member', r.rolname::text, m.rolname::text, concat(a.admin_option::int, a.inherit_option::int, a.set_option::int)
  from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member
union all
select 'setting', coalesce(d.datname::text, '*'), coalesce(r.rolname::text, '*'), array_to_string(s.setconfig, ',')
  from pg_db_role_setting s left join pg_database d on d.oid = s.setdatabase left join pg_roles r on r.oid = s.setrole
union all
select 'database', datname::text, concat_ws(' ', datdba::regrole, pg_encoding_to_char(encoding), datlocprovider, datcollate, datctype, coalesce(datlocale, '-')),
       (select string_agg(a::text, ',' order by a::text) from unnest(coalesce(datacl, acldefault('d', datdba))) a)
  from pg_database
union all
select 'schema', nspname::text, nspowner::regrole::text, (select string_agg(a::text, ',' order by a::text) from unnest(coalesce(nspacl, acldefault('n', nspowner))) a)
  from pg_namespace where nspname !~ '^pg_(toast_)?temp_'
union all
select 'ext', extname::text, extversion::text, extnamespace::regnamespace::text from pg_extension
union all
select 'evt', evtname::text, concat_ws(' ', evtevent, evtfoid::regproc, coalesce(array_to_string(evttags, ','), '-')), concat_ws(' ', evtenabled, evtowner::regrole)
  from pg_event_trigger
union all
select 'publication', pubname::text, concat(puballtables::int, pubinsert::int, pubupdate::int, pubdelete::int, pubtruncate::int, pubviaroot::int), pubowner::regrole::text
  from pg_publication
union all
select 'published', pubname::text, schemaname || '.' || tablename, '' from pg_publication_tables
union all
select 'policy', schemaname || '.' || tablename || ' ' || policyname, concat_ws(' ', permissive, cmd, array_to_string(roles, ',')), left(md5(concat_ws('|', qual, with_check)), 12)
  from pg_policies
union all
select 'trigger', tgrelid::regclass::text || ' ' || tgname, concat_ws(' ', tgfoid::regproc, tgtype, tgenabled), ''
  from pg_trigger where not tgisinternal
union all
select 'constraint', conrelid::regclass::text || ' ' || conname, concat_ws(' ', contype, convalidated::int, condeferrable::int), ''
  from pg_constraint c join pg_namespace n on n.oid = c.connamespace
 where n.nspname not in ('pg_catalog', 'information_schema') and conrelid <> 0
union all
select 'rel', c.oid::regclass::text, concat_ws(' ', c.relkind, c.relowner::regrole, c.relrowsecurity::int, c.relforcerowsecurity::int, c.relpersistence, c.relreplident),
       concat_ws(' ', (select string_agg(a::text, ',' order by a::text) from unnest(coalesce(c.relacl, acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char", c.relowner))) a),
                 'ext=' || coalesce((select e.extname from pg_depend d join pg_extension e on e.oid = d.refobjid
                                      where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e'), '-'))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and n.nspname !~ '^pg_(toast_)?temp_'
union all
select 'seq', c.oid::regclass::text, coalesce(pg_sequence_last_value(c.oid)::text, '-'),
       'ext=' || coalesce((select e.extname from pg_depend d join pg_extension e on e.oid = d.refobjid
                            where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e'), '-')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'S' and n.nspname not in ('pg_catalog', 'information_schema')
union all
select 'proc', p.oid::regprocedure::text, concat_ws(' ', p.proowner::regrole, p.prosecdef::int, p.provolatile, coalesce(array_to_string(p.proconfig, ','), '-')),
       concat_ws(' ', (select string_agg(a::text, ',' order by a::text) from unnest(coalesce(p.proacl, acldefault('f', p.proowner))) a),
                 'src=' || left(md5(p.prosrc), 12),
                 'ext=' || coalesce((select e.extname from pg_depend d join pg_extension e on e.oid = d.refobjid
                                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e'), '-'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname not in ('pg_catalog', 'information_schema')
union all
select 'type', t.oid::regtype::text, concat_ws(' ', t.typtype, t.typowner::regrole),
       concat_ws(' ', (select string_agg(a::text, ',' order by a::text) from unnest(coalesce(t.typacl, acldefault('T', t.typowner))) a),
                 'ext=' || coalesce((select e.extname from pg_depend d join pg_extension e on e.oid = d.refobjid
                                      where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e'), '-'))
  from pg_type t join pg_namespace n on n.oid = t.typnamespace
 where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and t.typrelid = 0 and t.typelem = 0
union all
select 'defacl', concat_ws(' ', d.defaclrole::regrole, coalesce(d.defaclnamespace::regnamespace::text, '*')), d.defaclobjtype::text, (select string_agg(a::text, ',' order by a::text) from unnest(d.defaclacl) a)
  from pg_default_acl d
order by 1, 2, 3, 4;
select format('select %L || ''|'' || count(*) || ''|'' || coalesce(md5(string_agg(t::text, E''\\n'' order by t::text)), ''-'') from %I.%I t',
              'rows|' || schemaname || '.' || tablename, schemaname, tablename)
  from pg_tables
 where schemaname not in ('pg_catalog', 'information_schema')
 order by schemaname, tablename
\\gexec
`;

/** The FINGERPRINT of the cluster a service runs (db, restore-db), as supabase_admin on 127.0.0.1. */
function fingerprint(service: string, profile?: string): string[] {
  const run = compose(
    [
      ...(profile ? ['--profile', profile] : []),
      'exec',
      '-T',
      service,
      'psql',
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'supabase_admin',
      ...LOCAL_DB,
    ],
    FINGERPRINT,
  );
  if (run.status !== 0) fail(`psql in ${service}: ${run.stderr.trim()}`);
  return lines(run.stdout);
}

/** One query in a service's cluster as supabase_admin, without failing: its exit, output and error. */
function sqlIn(service: string, query: string, profile?: string) {
  return compose(
    [
      ...(profile ? ['--profile', profile] : []),
      'exec',
      '-T',
      service,
      ...PSQL,
      '-U',
      'supabase_admin',
      ...LOCAL_DB,
    ],
    query,
  );
}

/**
 * The Storage files of one of the rehearsal's volumes, one line each, sorted: the path, the bytes,
 * the sha256 and every user.* xattr with its value (where Storage keeps an object's content type
 * and cache control), read with Storage's own fs-xattr in a throwaway container of its image.
 */
function storageFiles(volume: string): string[] {
  const script = [
    "import { getAttributeSync, listAttributesSync } from 'fs-xattr';",
    "import { createHash } from 'node:crypto';",
    "import { readdirSync, readFileSync } from 'node:fs';",
    "for (const entry of readdirSync('/files', { recursive: true, withFileTypes: true })) {",
    '  if (!entry.isFile()) continue;',
    "  const file = entry.parentPath + '/' + entry.name;",
    '  const body = readFileSync(file);',
    "  const xattrs = listAttributesSync(file).filter((name) => name.startsWith('user.')).sort();",
    "  const values = xattrs.map((name) => name + '=' + getAttributeSync(file, name).toString());",
    "  const sum = createHash('sha256').update(body).digest('hex');",
    "  console.log([file.slice('/files/'.length), body.length, sum, ...values].join(' '));",
    '}',
  ].join('\n');
  const run = docker(
    [
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--name',
      `${PROJECT}-files-${process.pid}`,
      '--mount',
      `type=volume,source=${PROJECT}_${volume},target=/files,readonly`,
      '--workdir',
      '/app',
      '--entrypoint',
      'node',
      value('storage', 'image'),
      '--input-type=module',
      '-',
    ],
    script,
  );
  if (run.status !== 0) fail(`Reading ${volume}'s files failed:\n${tail(run.stderr)}`);
  return lines(run.stdout).sort();
}

/** How many files a storageFiles() list holds, and their bytes. */
const fileTotals = (files: string[]) =>
  `${files.length} files, ${files.reduce((sum, line) => sum + Number(line.split(' ')[1]), 0)} bytes`;

/** backup.sh's stamp (date -u +%Y-%m-%dT%H%MZ) for a time of the daemon's clock. */
const stampOf = (time: string) => `${new Date(time).toISOString().slice(0, 16).replace(':', '')}Z`;

/**
 * A container's memory as its cgroup counts it: the high-water mark (memory.peak, page cache
 * included, which is what the limit holds), and what docker stats shows (memory.current less the
 * inactive file cache). In MiB; undefined if the container doesn't run.
 */
function cgroupMemory(container: string, profile?: string, service = false) {
  const read =
    'cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.current; grep "^inactive_file " /sys/fs/cgroup/memory.stat';
  const run = service
    ? compose([
        ...(profile ? ['--profile', profile] : []),
        'exec',
        '-T',
        container,
        'sh',
        '-c',
        read,
      ])
    : docker(['exec', container, 'sh', '-c', read]);
  const [peak, current, inactive] = lines(run.stdout).map((line) => Number(line.split(' ').pop()));
  if (run.status !== 0 || [peak, current, inactive].some((n) => !Number.isFinite(n)))
    return undefined;
  const mib = (bytes: number) => Math.round(bytes / 1048576);
  return { peak: mib(peak), stats: mib(current - inactive) };
}

/**
 * `compose run --rm` of a one-off under a known name, as the server runs it, with how long it took
 * and its memory: the cgroup's high-water mark and the most docker stats would have shown, read
 * every quarter second while it runs, when `watch`, if given, also runs.
 */
async function measured(name: string, args: string[], profile?: string, watch?: () => void) {
  const started = Date.now();
  const child = spawn(
    'docker',
    composeArgs([
      ...(profile ? ['--profile', profile] : []),
      'run',
      '--rm',
      '--name',
      name,
      ...args,
    ]),
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
  let status: number | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      status = code ?? 1;
      resolve();
    });
  });
  let peakMib = 0;
  let statsMib = 0;
  while (status === undefined) {
    const now = cgroupMemory(name);
    if (now) {
      peakMib = Math.max(peakMib, now.peak);
      statsMib = Math.max(statsMib, now.stats);
    }
    watch?.();
    await sleep(250);
  }
  await closed;
  return {
    status: status ?? 1,
    stdout,
    stderr: lines(stderr)
      .filter((line) => !/^ ?(Container|Network|Volume) /.test(line.trim()))
      .join('\n'),
    took: seconds(started),
    peakMib,
    statsMib,
  };
}

/** A measured run's memory and time against its service's limit, for a check line. */
const usage = (run: { took: number; peakMib: number; statsMib: number }, service: string) =>
  `${run.took} s, memory at most ${run.peakMib} MiB of its ${value(service, 'mem_limit')} (docker stats: ${run.statsMib} MiB)`;

/**
 * The night's objects the backup must leave: every part, the base if it was made, the settings
 * archive if it was fresh, and the seal.
 */
const nightParts = (night: string, config: boolean, base = true) =>
  [
    `globals-${night}.sql.age`,
    `manifest-${night}.txt.age`,
    `postgres-${night}.dump.age`,
    `storage-${night}.tar.age`,
    `seal-${night}.txt`,
    ...(base ? [`base-${night}.tar.zst.age`] : []),
    ...(config ? [`config-${night}.tar.age`] : []),
  ].sort();

/** A night's id as backup.sh makes one: its stamp, a dash and 8 random hex characters. */
const NIGHT_ID = /^\d{4}-\d\d-\d\dT\d{4}Z-[0-9a-f]{8}$/;

/** A night id of the test's own making, for a stamp, as a token holder could make one. */
const idOf = (stamp: string) => `${stamp}-${randomBytes(4).toString('hex')}`;

/** The stamp a night's id begins with. */
const stampPart = (night: string) => night.slice(0, 16);

/** Runs sh in a one-off of the backup service (its environment and networks), without its deps. */
const inBackup = (script: string, input?: string) =>
  compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'backup', '-c', script], input);

/** The names of the bucket's objects in one folder (daily, monthly, or '' for its top), sorted. */
const bucketNames = (folder: string) => {
  const run = inBackup(`rclone lsf --files-only "backups:$BACKUP_BUCKET/${folder}"`);
  if (run.status !== 0)
    fail(`Listing the bucket's ${folder || 'top'} failed: ${run.stderr.trim()}`);
  return lines(run.stdout).sort();
};

/** Puts a text in the bucket at a path under it, as whoever holds the bucket's token could. */
function putObject(path: string, text: string) {
  const run = inBackup(`rclone rcat "backups:$BACKUP_BUCKET/${path}"`, text);
  if (run.status !== 0) fail(`Putting ${path} in the bucket failed: ${run.stderr.trim()}`);
}

/** The parts a planted night's script printed, one "<sha256> <bytes> <name>" line each. */
const plantedParts = (stdout: string): SealPart[] =>
  lines(stdout).map((line) => {
    const [sha256, bytes, name] = line.split(' ');
    return { sha256, bytes: Number(bytes), name };
  });

/**
 * A planted night under daily/, under an id of the planter's making, as whoever holds the bucket's
 * token and the public key could upload one (review finding S1): a manifest that passes
 * restore.sh's rules, the given roles file, a stand-in for the dump, a Storage archive of one file,
 * or of one file and a link to /proc/self/environ (review finding N6), and a settings archive, each
 * encrypted to the rehearsal's key. With a key, a seal of those parts signed by it: the rehearsal's
 * own signing key stands for one that leaked, behind which the restore's other guards must still
 * hold (VPS-43), and any other key for someone without it. Its parts, as the seal lists them.
 */
function plantNight(
  night: string,
  roles: string,
  key: string | undefined,
  storage: 'file' | 'link' = 'file',
) {
  // Encrypts stdin to the rehearsal's key into a file of the outbox below.
  const encrypt = (name: string) =>
    `age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" >"/tmp/planted/out/${name}"`;
  const manifest = `menumesh backup ${night}\\ndatabase postgres\\nstorage files 1\\nstorage bytes 8\\n`;
  const run = inBackup(
    [
      'set -e',
      'mkdir -p /tmp/planted/out /tmp/planted/files/stub/b /tmp/planted/config',
      `printf '${manifest}' | ${encrypt(`manifest-${night}.txt.age`)}`,
      encrypt(`globals-${night}.sql.age`),
      `printf 'planted\\n' | ${encrypt(`postgres-${night}.dump.age`)}`,
      "printf 'planted\\n' >/tmp/planted/files/stub/b/a.txt",
      ...(storage === 'link' ? ['ln -s /proc/self/environ /tmp/planted/files/stub/b/env'] : []),
      `tar --create --file=- --directory=/tmp/planted/files . | ${encrypt(`storage-${night}.tar.age`)}`,
      "printf 'POSTGRES_PASSWORD=planted\\n' >/tmp/planted/config/.env",
      `tar --create --file=- --directory=/tmp/planted/config . | ${encrypt(`config-${night}.tar.age`)}`,
      'cd /tmp/planted/out',
      'for name in *; do',
      '  rclone copyto "$name" "backups:$BACKUP_BUCKET/daily/$name" </dev/null',
      `  printf '%s %s %s\\n' "$(sha256sum <"$name" | cut -d ' ' -f 1)" "$(wc -c <"$name")" "$name"`,
      'done',
    ].join('\n'),
    roles,
  );
  if (run.status !== 0) fail(`Planting the night ${night} failed: ${run.stderr.trim()}`);
  const parts = plantedParts(run.stdout);
  if (key) putObject(`daily/seal-${night}.txt`, sealText(night, undefined, parts, key));
  return parts;
}

/**
 * A whole-looking month's copy planted in monthly/ under a night id of the planter's making: each
 * part a night has, of random bytes past its floor, and a seal that lists them at their sha256
 * and size, with a base line, signed by the given key. Its names.
 */
function plantCopy(night: string, key: string): string[] {
  const names = [
    `globals-${night}.sql.age`,
    `storage-${night}.tar.age`,
    `manifest-${night}.txt.age`,
    `postgres-${night}.dump.age`,
    `base-${night}.tar.zst.age`,
    `config-${night}.tar.age`,
  ];
  const run = inBackup(
    [
      'set -e',
      'mkdir -p /tmp/planted',
      'cd /tmp/planted',
      `for name in ${names.join(' ')}; do`,
      '  head -c 4096 /dev/urandom >"$name"',
      '  rclone copyto "$name" "backups:$BACKUP_BUCKET/monthly/$name" </dev/null',
      `  printf '%s %s %s\\n' "$(sha256sum <"$name" | cut -d ' ' -f 1)" "$(wc -c <"$name")" "$name"`,
      'done',
    ].join('\n'),
  );
  if (run.status !== 0) fail(`Planting a copy in monthly/ failed: ${run.stderr.trim()}`);
  const base = {
    end: `${night.slice(0, 10)}T20:33:07Z`,
    walfile: '000000010000000000000007',
    cluster: '7',
  };
  putObject(`monthly/seal-${night}.txt`, sealText(night, base, plantedParts(run.stdout), key));
  return [...names, `seal-${night}.txt`];
}

/** A throwaway Ed25519 private key, base64 PKCS #8 DER: someone else's, not the backup's. */
const otherSigningKey = () =>
  generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'der', type: 'pkcs8' })
    .toString('base64');

/**
 * What the bucket holds of nights, each in a folder: the seal's bytes (latin1), and the sha256 and
 * size of every object named with the night's id, read in the backup's container (into /var/tmp:
 * its /tmp is a small tmpfs).
 */
function nightsInBucket(nights: readonly (readonly [string, string])[]) {
  const script = [
    'set -eu',
    'while read -r folder night; do',
    '  echo "night $folder $night"',
    `  printf 'seal %s\\n' "$(rclone cat --no-traverse "backups:$BACKUP_BUCKET/$folder/seal-$night.txt" </dev/null | base64 -w 0)"`,
    '  rclone lsf --files-only --include "*-$night.*" "backups:$BACKUP_BUCKET/$folder/" </dev/null | while read -r name; do',
    '    rclone cat --no-traverse "backups:$BACKUP_BUCKET/$folder/$name" </dev/null >/var/tmp/object',
    `    printf 'object %s %s %s\\n' "$name" "$(sha256sum </var/tmp/object | cut -d ' ' -f 1)" "$(wc -c </var/tmp/object)"`,
    '  done',
    'done',
  ].join('\n');
  const run = inBackup(
    script,
    `${nights.map(([folder, night]) => `${folder} ${night}`).join('\n')}\n`,
  );
  if (run.status !== 0) fail(`Reading the nights in the bucket failed: ${run.stderr.trim()}`);
  const found = new Map<string, { seal: string; objects: Map<string, SealPart> }>();
  let current: { seal: string; objects: Map<string, SealPart> } | undefined;
  for (const line of lines(run.stdout)) {
    const [kind, ...rest] = line.split(' ');
    if (kind === 'night') found.set(rest.join(' '), (current = { seal: '', objects: new Map() }));
    else if (kind === 'seal' && current) {
      current.seal = Buffer.from(rest[0] ?? '', 'base64').toString('latin1');
    } else if (kind === 'object' && current) {
      const [name, sha256, bytes] = rest;
      current.objects.set(name, { sha256, bytes: Number(bytes), name });
    }
  }
  return found;
}

/**
 * Each night's seal as a restore reads it, here with Node's crypto (VPS-43): seal.sh's grammar,
 * signed by a key of BACKUP_SIGNING_PUBLIC_KEY, with the parts a night has (the base and the
 * settings archive as given), the base line there exactly when the base part is, and each part in
 * the folder at the sha256 and size the seal gives. The night's other objects there are its seal
 * and, after a base that failed, what of the base went up, which the seal doesn't list.
 */
function sealsChecked(
  checks: Checks,
  env: Record<string, string>,
  nights: { folder: string; night: string; config: boolean; base: boolean }[],
) {
  const found = nightsInBucket(nights.map(({ folder, night }) => [folder, night] as const));
  const bad: string[] = [];
  const said: string[] = [];
  for (const { folder, night, config, base } of nights) {
    const at = `${folder}/ ${night}`;
    const held = found.get(`${folder} ${night}`);
    const seal = held ? sealOf(held.seal, night) : 'was not read';
    const verdict = held ? sealVerdict(held.seal, night, env.BACKUP_SIGNING_PUBLIC_KEY) : seal;
    if (!held || typeof seal === 'string' || verdict !== 'ok') {
      bad.push(`${at}: its seal ${verdict}`);
      continue;
    }
    const listed = seal.parts.map(({ name }) => name).sort();
    const want = nightParts(night, config, base).filter((name) => !name.startsWith('seal-'));
    if (listed.join(' ') !== want.join(' ')) bad.push(`${at}: the seal lists ${listed.join(', ')}`);
    if (Boolean(seal.base) !== base) bad.push(`${at}: its base line is not as the night was`);
    for (const part of seal.parts) {
      const object = held.objects.get(part.name);
      if (object?.sha256 !== part.sha256 || object.bytes !== part.bytes) {
        bad.push(`${at}: ${part.name} is not in the folder as the seal gives it`);
      }
    }
    const others = [...held.objects.keys()].filter(
      (name) =>
        name !== `seal-${night}.txt` &&
        !listed.includes(name) &&
        !(!base && name === `base-${night}.tar.zst.age`),
    );
    if (others.length) bad.push(`${at}: also ${others.join(', ')}`);
    said.push(
      `${at}: ${seal.parts.length} parts, ${seal.base ? `base from ${seal.base.walfile}` : 'base none'}`,
    );
  }
  checks.expect(
    `each night's seal, read with Node's crypto as restore.sh reads it: in seal.sh's lines, signed by BACKUP_SIGNING_PUBLIC_KEY's key, and listing each of the night's parts at the sha256 and size the bucket holds (${said.join('; ')})`,
    !bad.length && said.length === nights.length,
    bad.join('\n'),
  );
  return found;
}

/**
 * A night's base backup, decrypted (the rehearsal's age key) and decompressed in a one-off of the
 * backup service, into /var/tmp (its /tmp is a small tmpfs): its tar's names, backup_label's lines
 * and the system identifier of its backup_manifest.
 */
function baseOf(night: string) {
  const script = [
    'set -eu',
    `rclone cat --no-traverse "backups:$BACKUP_BUCKET/daily/base-${night}.tar.zst.age" >/var/tmp/base.zst.age`,
    'age --decrypt --identity /run/age/identity.txt </var/tmp/base.zst.age | zstd -dcq >/var/tmp/base.tar',
    'tar -tf /var/tmp/base.tar | sed "s/^/name /"',
    'tar -xOf /var/tmp/base.tar backup_label | sed "s/^/label /"',
    `tar -xOf /var/tmp/base.tar backup_manifest | sed -n 's/^"System-Identifier": \\([0-9]*\\),$/system \\1/p'`,
    'echo "bytes $(wc -c </var/tmp/base.tar)"',
  ].join('\n');
  const run = compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '--volume',
    `${slash(join(MIRROR, 'age'))}:/run/age:ro`,
    '--entrypoint',
    'sh',
    'backup',
    '-c',
    script,
  ]);
  if (run.status !== 0) fail(`Reading the base backup of ${night} failed: ${run.stderr.trim()}`);
  const of = (kind: string) =>
    lines(run.stdout)
      .filter((line) => line.startsWith(`${kind} `))
      .map((line) => line.slice(kind.length + 1));
  return {
    names: of('name'),
    label: of('label'),
    system: of('system')[0] ?? '',
    bytes: Number(of('bytes')[0]),
  };
}

/**
 * Commands run in a running service's container with docker exec, at once, as crond runs its
 * jobs there, with how long they took, the most memory the container's cgroup held meanwhile
 * (memory.current, page cache included) and the most its /tmp held (df's used KiB), each read
 * every quarter second.
 */
async function inService(container: string, runs: { user?: string; command: string[] }[]) {
  const started = Date.now();
  const children = runs.map(({ user, command }) => {
    const child = spawn(
      'docker',
      ['exec', ...(user ? ['--user', user] : []), container, ...command],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const out = { status: undefined as number | undefined, stdout: '', stderr: '' };
    child.stdout.on('data', (chunk: Buffer) => (out.stdout += chunk));
    child.stderr.on('data', (chunk: Buffer) => (out.stderr += chunk));
    const closed = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        out.status = code ?? 1;
        resolve();
      });
    });
    return { out, closed };
  });
  let peakMib = 0;
  let tmpKib = 0;
  while (children.some(({ out }) => out.status === undefined)) {
    const [current, , df] = lines(
      docker(['exec', container, 'sh', '-c', 'cat /sys/fs/cgroup/memory.current && df -Pk /tmp'])
        .stdout,
    );
    const bytes = Number(current);
    if (Number.isFinite(bytes)) peakMib = Math.max(peakMib, Math.round(bytes / 1048576));
    const used = Number(df?.trim().split(/\s+/)[2]);
    if (Number.isFinite(used)) tmpKib = Math.max(tmpKib, used);
    await sleep(250);
  }
  await Promise.all(children.map(({ closed }) => closed));
  return { runs: children.map(({ out }) => out), peakMib, tmpKib, took: seconds(started) };
}

/**
 * What a restore of a planted night whose Storage archive holds a link prints first, when the
 * rehearsal's own key sealed it: the night's line, the seal's, then the refusal, before the roles.
 */
const sealedThenLink = (night: string, host: string) =>
  new RegExp(
    `^restore: the night of ${night}, from daily/, into ${host}\\nrestore: its seal is signed by the backup's key, and the \\d+ parts read match it \\(\\d+ bytes\\)\\nrestore: the Storage archive of ${night} holds links or special files \\(1\\), which Storage never writes: nothing was restored\\n`,
  );

/**
 * A planted night's restore that must be refused before anything is restored: the run, its whole
 * output, and whether restore-db is still bare after it (no role but its superuser, no database
 * but initdb's).
 */
async function refusedRestore(night: string, age: string[]) {
  const run = await measured(
    `${PROJECT}-restore-test-${process.pid}`,
    ['-T', '-e', `RESTORE_STAMP=${night}`, ...age, 'restore-test'],
    'restore-test',
  );
  const left = sqlIn(
    'restore-db',
    "select (select count(*) from pg_roles where rolname !~ '^pg_' and rolname <> current_user) + (select count(*) from pg_database where datname not in ('template0', 'template1', 'postgres'))",
    'restore-test',
  );
  compose(['--profile', 'restore-test', 'rm', '--stop', '--force', 'restore-db']);
  return {
    run,
    output: `${run.stdout}${run.stderr}`,
    bare: left.status === 0 && left.stdout.trim() === '0',
  };
}

/**
 * The roles file of a planted night, shaped like pg_dumpall's (SQL between its own \restrict and
 * \unrestrict lines, which let the old restore lift psql's restricted mode), then psql commands
 * that, run, would read the owner's key (`\i`) or copy it into the bucket (`\!`, with the
 * container's own rclone and token). With a notice, its SQL also has psql print that text after
 * escape sequences that, on a terminal, would erase the restore's own line and put the text in its
 * place (review finding N4).
 */
const plantedRoles = (first: 'read' | 'copy', notice?: string) => {
  const read = String.raw`\i /run/age/identity.txt`;
  const copy = String.raw`\! rclone copyto /run/age/identity.txt "backups:$BACKUP_BUCKET/stolen.txt"`;
  return [
    String.raw`\restrict planted`,
    "SET client_encoding = 'UTF8';",
    'CREATE ROLE planted;',
    'ALTER ROLE planted WITH NOSUPERUSER NOINHERIT NOLOGIN;',
    ...(notice
      ? [String.raw`DO $$BEGIN RAISE NOTICE E'\r\033[2K\033[1A\033[2K` + `${notice}'; END$$;`]
      : []),
    String.raw`\unrestrict planted`,
    ...(first === 'read' ? [read, copy] : [copy, read]),
    '',
  ].join('\n');
};

/** Whether text holds a byte that moves a terminal's cursor or rewrites a line: ESC, CR or BEL. */
const terminalControls = (text: string) => /[\u001b\r\u0007]/.test(text);

/**
 * A stand-in for date that answers backup.sh's stamp (`date -u +%Y-%m-%dT%H%MZ`) with FAKE_STAMP,
 * so that a night can be stamped the 1st on another day; every other call is BusyBox's own date.
 */
const DATE_STAND_IN = [
  '#!/bin/sh',
  `if [ -n "\${FAKE_STAMP:-}" ] && [ "$*" = '-u +%Y-%m-%dT%H%MZ' ]; then echo "$FAKE_STAMP"; exit 0; fi`,
  'exec busybox date "$@"',
  '',
].join('\n');

/**
 * A stand-in for od that answers backup.sh's random part (`od -An -tx1 -N4 /dev/urandom`) with
 * FAKE_HEX, as od prints it, so that the test knows a night's id before the night runs, as nobody
 * else can; every other call is BusyBox's own od.
 */
const OD_STAND_IN = [
  '#!/bin/sh',
  `if [ -n "\${FAKE_HEX:-}" ] && [ "$*" = '-An -tx1 -N4 /dev/urandom' ]; then printf '%s\\n' "$FAKE_HEX" | sed 's/\\(..\\)/ \\1/g'; exit 0; fi`,
  'exec busybox od "$@"',
  '',
].join('\n');

/**
 * A stand-in for pg_basebackup. With FAKE_BASE=fail it fails as a base backup can, after a few
 * bytes of its stream, which backup.sh still uploads. With FAKE_BASE=slow it is the image's own at
 * 4 MB/s, while db writes about 2 MB of WAL, switches to a new WAL file and is made to checkpoint 3 s
 * in: db may then remove every WAL file archived before, the one the base starts in among them,
 * which pg_basebackup -X fetch reads only at its end (VPS-43). That job is this shell's child, not
 * pg_basebackup's, whose SIGCHLD handler would take any child's end for its WAL streamer's. Every
 * other run is the image's own.
 */
const BASE_STAND_IN = [
  '#!/bin/sh',
  `if [ "\${FAKE_BASE:-}" = fail ]; then printf 'a base backup cut short\\n'; echo 'pg_basebackup: error: the stand-in failed' >&2; exit 1; fi`,
  'if [ "${FAKE_BASE:-}" = slow ]; then',
  '  (',
  '    sleep 3',
  `    psql -X -q -At -d postgres -c "select pg_logical_emit_message(false, 'menumesh-rehearsal', repeat('x', 2000000)) is not null" -c "select pg_switch_wal() is not null" -c checkpoint`,
  '  ) >/dev/null 2>&1 </dev/null &',
  '  /usr/local/bin/pg_basebackup --max-rate=4M "$@"',
  '  status=$?',
  '  wait',
  '  exit "$status"',
  'fi',
  'exec /usr/local/bin/pg_basebackup "$@"',
  '',
].join('\n');

/**
 * The arguments of `compose run` for a one-off of the backup service running backup.sh with the
 * stand-ins date, od and pg_basebackup, copied to /var/tmp/bin: the service's /tmp is a tmpfs,
 * which runs nothing.
 */
const standInArgs = (fakes: Record<string, string>) => [
  '--no-deps',
  '-T',
  '--volume',
  `${slash(join(MIRROR, 'test-bin'))}:/opt/menumesh-rehearsal:ro`,
  ...Object.entries(fakes).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
  '--entrypoint',
  'sh',
  'backup',
  '-c',
  'mkdir -p /var/tmp/bin && cd /opt/menumesh-rehearsal && cp date od pg_basebackup /var/tmp/bin/ && chmod 755 /var/tmp/bin/date /var/tmp/bin/od /var/tmp/bin/pg_basebackup && PATH=/var/tmp/bin:$PATH exec /usr/local/bin/backup.sh',
];

/** A one-off of the backup service running backup.sh with the stand-ins date, od and pg_basebackup. */
const standInBackup = (fakes: Record<string, string>) =>
  compose(['run', '--rm', ...standInArgs(fakes)]);

/** What a restore printed that only a read of the owner's key file could print. */
const keyShown = (output: string) => /AGE-SECRET-KEY|# created:|# public key:/.test(output);

/** The month before a stamp's, as YYYY-MM. */
const monthBefore = (stamp: string) => {
  const date = new Date(`${stamp.slice(0, 7)}-01T00:00:00Z`);
  date.setUTCDate(0);
  return date.toISOString().slice(0, 7);
};

/** A planted night's stamp that always sorts last. */
const FUTURE = '9999-12-31T2359Z';

/** The vault secret the test makes in the source: its value is no secret. */
const VAULT_NAME = 'menumesh-rehearsal';
const VAULT_VALUE = 'rehearsal-only';

async function backupTest() {
  const checks = new Checks();
  if (!containerOf('db') || !existsSync(join(MIRROR, '.env')))
    fail('The rehearsal is not up: pnpm vps:rehearse first.');
  const env = parseEnv(readFileSync(join(MIRROR, '.env'), 'utf8')) as Record<string, string>;
  // A bare cluster left by a run that stopped would hold that run's restore: start without one.
  compose(['--profile', '*', 'rm', '--stop', '--force', 'restore-db', 'recover-db']);
  // The working tree's compose file, bare-postgres.sh and backup image, as vps:rehearse would
  // install and build them; and the stand-ins date and od, for a night stamped the 1st on another
  // day and one whose id the test knows before it runs.
  mirror(checks);
  mkdirSync(join(MIRROR, 'test-bin'), { recursive: true });
  writeFileSync(join(MIRROR, 'test-bin', 'date'), DATE_STAND_IN, { mode: 0o755 });
  writeFileSync(join(MIRROR, 'test-bin', 'od'), OD_STAND_IN, { mode: 0o755 });
  writeFileSync(join(MIRROR, 'test-bin', 'pg_basebackup'), BASE_STAND_IN, { mode: 0o755 });
  const backupImage = REHEARSAL_IMAGES.BACKUP_IMAGE;
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  const built = build(backupImage, ['--build-arg', `REVISION=${sha}`, join(KIT, 'backup')]);
  checks.ok(`${backupImage} built in ${built} s from the working tree`);

  // The extensions the image ships and preloads beyond the kit's (pg_net, supabase_vault), as a
  // project turns them on (as postgres, through supautils); a pg_cron job (a no-op once a year)
  // and a vault secret: the restore must bring them back too. The secret is made again each run:
  // after a recovery, an earlier one no longer decrypts.
  dbSql(
    [
      'create extension if not exists pg_cron with schema pg_catalog;',
      'create extension if not exists pgsodium;',
      'create extension if not exists pg_graphql;',
      "select cron.schedule('menumesh-rehearsal-noop', '0 0 1 1 *', 'select 1');",
      `delete from vault.secrets where name = '${VAULT_NAME}';`,
      `select vault.create_secret('${VAULT_VALUE}', '${VAULT_NAME}');`,
    ].join('\n'),
    'postgres',
  );
  const extensions = dbSql('select extname from pg_extension order by 1');
  const secret = vaultSecret('db');
  checks.expect(
    `the rehearsal's db holds ${extensions.join(', ')}; a pg_cron job, and a vault secret that decrypts (${secret === VAULT_VALUE ? 'it does' : secret})`,
    ['pg_cron', 'pg_graphql', 'pg_net', 'pgsodium', 'supabase_vault'].every((name) =>
      extensions.includes(name),
    ) && secret === VAULT_VALUE,
  );

  // The bucket's stand-in: rclone's S3 server, on the internal bucket network only.
  const s3 = compose(['up', '-d', '--wait', '--wait-timeout', '60', 's3']);
  if (s3.status !== 0) fail(`s3 did not start:\n${tail(s3.stderr)}`);
  // The heartbeat and the alert are sent below, to hosts the sinkhole must answer in the
  // container, so that nothing leaves this machine.
  const hosts = inBackup('cat /etc/hosts');
  const sunk = ['hc-ping.com', 'api.telegram.org'].filter((host) =>
    new RegExp(`^0\\.0\\.0\\.0\\s+${host.replaceAll('.', '\\.')}\\s*$`, 'm').test(hosts.stdout),
  );
  if (sunk.length !== 2)
    fail(`The backup container's /etc/hosts lacks the sinkhole:\n${hosts.stdout}${hosts.stderr}`);
  checks.ok(
    `the local S3 (rclone serve s3) is up, bucket ${env.BACKUP_BUCKET}; in the backup container ${sunk.join(' and ')} resolve to the sinkhole (0.0.0.0)`,
  );
  sealProof(checks, env);
  sealOpenProof(checks, env);
  await walProof(checks, env);
  await shipperPaths(checks, env);

  // Storage files of two types to back up, as the app writes them (a support screenshot, an
  // export ZIP): a fresh rehearsal has none. The same names each run, never written over, so no
  // old version is removed while the night is taken.
  const stored = [
    { bucket: 'support-screenshots', name: 'rehearsal/backup-test.png', type: 'image/png' },
    { bucket: 'restaurant-exports', name: 'rehearsal/backup-test.zip', type: 'application/zip' },
  ];
  const put = inWeb<{ status: number; body: string }[]>(
    [
      'const out = [];',
      'for (const { bucket, name, type } of input) {',
      "  const res = await fetch(gw + '/storage/v1/object/' + bucket + '/' + name, { method: 'POST', headers: { apikey: key, 'Content-Type': type, 'Cache-Control': 'max-age=3600' }, body: Buffer.from('menumesh rehearsal: ' + name) });",
      '  out.push({ status: res.status, body: (await res.text()).slice(0, 200) });',
      '}',
      'console.log(JSON.stringify(out));',
    ].join('\n'),
    stored,
  );
  checks.expect(
    `Storage objects of two types put in through the gateway, as the app does: ${put.map((answer, n) => `${stored[n].type} ${answer.status === 200 ? 200 : 'there already'}`).join(', ')}`,
    put.length === stored.length &&
      put.every((answer) => answer.status === 200 || /"statusCode":"409"/.test(answer.body)),
    JSON.stringify(put),
  );

  // The source: nothing writes while the night is taken and compared (web and the scheduler stop;
  // the recovery at the end starts them again, or the finally below if the run stops before it).
  compose(['stop', 'web', 'scheduler']);
  let handedOver = false;
  try {
    const source = fingerprint('db');
    const files = storageFiles('storage-data');
    const tables = source.filter((line) => line.startsWith('rows|')).length;
    checks.ok(
      `the source, with web and the scheduler stopped: ${source.length - tables} catalog lines, ${tables} tables hashed; ${fileTotals(files)} in storage-data`,
    );

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
        backupImage,
        'sh',
        '-c',
        `mkdir -p /tmp/s/env && cd /tmp/s && printf 'POSTGRES_PASSWORD=stand-in\\n' >.env && printf 'WEB_IMAGE=x:none\\n' >images.env && printf 'X=1\\n' >env/web.env && tar -cf - .env images.env env | age -r "$1" >/out/config-${stamp}.tar.age`,
        'archive',
        env.BACKUP_AGE_RECIPIENT,
      ]);
      if (made.status !== 0) fail(`The stand-in settings archive failed: ${made.stderr}`);
      return file;
    };
    // The bucket's objects under daily/ as "<bytes> <name>".
    const daily = () =>
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
          '--files-only',
          '--format',
          'sp',
          '--separator',
          ' ',
          `backups:${env.BACKUP_BUCKET}/daily/`,
        ]).stdout,
      );
    const nightOf = (stamp: string) =>
      daily()
        .map((line) => line.split(' ')[1])
        .filter((name) => name.includes(`-${stamp}.`))
        .sort();

    // The bucket from empty but for wal/, where the backup service keeps shipping db's WAL: earlier
    // runs' nights, planted ones and anything at its top go. Then monthly/ as before a month's
    // first whole night: another month's copy, and names a token holder could plant for this month
    // and for a 1st two months back, a stray name and a manifest alone, named as backup.sh names
    // one, which must stop no copy (review finding N2).
    const today = stampOf(daemonNow());
    const earlier = monthBefore(today);
    const otherNight = idOf(`${earlier}-28T2030Z`);
    const otherMonth = `manifest-${otherNight}.txt.age`;
    const oldFirst = `${monthBefore(`${earlier}-01T0000Z`)}-01T2030Z`;
    const junk = [today, oldFirst].flatMap((stamp) => [
      `manifest-${stamp.slice(0, 7)}-zz`,
      `manifest-${idOf(`${stamp.slice(0, 7)}-05T0101Z`)}.txt.age`,
    ]);
    const cleared = inBackup(
      [
        'set -e',
        `rclone delete --exclude '/wal/**' "backups:$BACKUP_BUCKET/"`,
        ...[otherMonth, ...junk].map(
          (name) =>
            `printf 'menumesh backup ${otherNight}\\n' | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" | rclone rcat "backups:$BACKUP_BUCKET/monthly/${name}"`,
        ),
      ].join('\n'),
    );
    if (cleared.status !== 0) fail(`Setting monthly/ up failed: ${cleared.stderr.trim()}`);
    // And a whole-looking copy of this month, each part a night has at the size its seal gives,
    // the seal signed by a key not the backup's: a token holder's copy, which must stop no copy
    // either (VPS-43).
    const forger = otherSigningKey();
    const forgedCopy = plantCopy(idOf(`${today.slice(0, 7)}-05T0102Z`), forger);
    const planted0 = [otherMonth, ...junk, ...forgedCopy].sort();

    // The month's first night here fails on a settings archive three hours old, after its other
    // uploads, with the alert to a Telegram bot in the sinkhole; such a night is never the month's
    // copy (review finding N3).
    const stale = archive(today);
    const hoursAgo = new Date(Date.now() - 3 * 3600 * 1000);
    utimesSync(stale, hoursAgo, hoursAgo);
    const old = await measured(`${PROJECT}-backup-${process.pid}`, [
      '--no-deps',
      '-T',
      '-e',
      'TELEGRAM_BOT_TOKEN=rehearsal',
      '-e',
      'TELEGRAM_CHAT_ID=rehearsal',
      'backup',
      '/usr/local/bin/backup.sh',
    ]);
    const failedNight = /backup failed \(exit \d+\) at (\S+):/.exec(old.stderr)?.[1] ?? '';
    const failedParts = failedNight ? nightOf(failedNight) : [];
    checks.expect(
      `backup.sh with the archive three hours old: exit ${old.status} after its ${failedParts.length} uploads (no settings archive), "${lines(old.stderr).find((line) => line.startsWith('[menumesh]')) ?? ''}", and the alert sent, into the sinkhole ("${tail(old.stderr, 1)}")`,
      old.status === 1 &&
        failedParts.join(' ') === nightParts(failedNight, false).join(' ') &&
        /is more than 2 hours old/.test(old.stderr) &&
        /notify: the Telegram alert failed \(curl exit 7\)/.test(old.stderr),
      `${old.stdout}${old.stderr}`,
    );
    const monthlyFailed = bucketNames('monthly');
    checks.expect(
      `a night whose settings archive failed is not the month's copy: monthly/ still holds only its ${monthlyFailed.length} planted objects, none of ${failedNight || 'the failed night'}`,
      failedNight !== '' && monthlyFailed.join(' ') === planted0.join(' '),
      monthlyFailed.join('\n'),
    );
    // That night's own seal, the backup's but of a night without a settings archive, copied into
    // monthly/ alone, as a token holder can from daily/: no whole copy either.
    const copied = inBackup(
      `rclone copyto "backups:$BACKUP_BUCKET/daily/seal-${failedNight}.txt" "backups:$BACKUP_BUCKET/monthly/seal-${failedNight}.txt"`,
    );
    if (copied.status !== 0)
      fail(`Copying the failed night's seal failed: ${copied.stderr.trim()}`);
    const plantedMonthly = [...planted0, `seal-${failedNight}.txt`].sort();
    // rclone serve s3 lists a folder from a cache of 5 s: wait until monthly/ shows it.
    for (let tries = 0; tries < 20; tries++) {
      if (bucketNames('monthly').includes(`seal-${failedNight}.txt`)) break;
      await sleep(1000);
    }

    // The next night as the service runs it, with a fresh settings archive and a heartbeat URL in
    // the sinkhole: the ping is the last step, after every upload was checked.
    while (stampOf(daemonNow()) === stampPart(failedNight)) await sleep(1000);
    archive(stampOf(daemonNow()));
    const good = await measured(`${PROJECT}-backup-${process.pid}`, [
      '--no-deps',
      '-T',
      '-e',
      'HEARTBEAT_URL=https://hc-ping.com/menumesh-rehearsal',
      'backup',
      '/usr/local/bin/backup.sh',
    ]);
    const summary = /^backup (\S+): (.*)$/m.exec(good.stdout);
    const night = summary?.[1] ?? '';
    const objects = night ? nightOf(night) : [];
    checks.expect(
      `backup.sh as the service runs it, with a fresh settings archive: exit ${good.status} in ${usage(good, 'backup')}; "${summary?.[0] ?? tail(good.stdout, 1)}", the night's ${objects.length} objects in the bucket; the heartbeat last, into the sinkhole ("${tail(good.stderr, 1)}")`,
      good.status === 0 &&
        NIGHT_ID.test(night) &&
        objects.join(' ') === nightParts(night, true).join(' ') &&
        /notify: the heartbeat ping failed \(curl exit 7\)/.test(good.stderr),
      `${good.stdout}${good.stderr}\n${objects.join('\n')}`,
    );
    // The month's first whole night is its copy, whatever its day, past the names planted for the
    // month (review findings B4, N2 and N3), the whole-looking copy another key sealed and the
    // failed night's own seal (VPS-43).
    const monthly = bucketNames('monthly');
    checks.expect(
      `the month's first whole night, stamped on day ${night.slice(8, 10)}, kept whole in monthly/ as the month's copy, seal last, past the names planted for its month (${junk.slice(0, 2).join(', ')}), a whole-looking copy whose seal another key signed (${forgedCopy.at(-1)}) and the failed night's own seal alone: ${monthly.length} objects`,
      night !== '' &&
        /, kept in monthly\/ as the month's copy$/.test(summary?.[0] ?? '') &&
        monthly.join(' ') === [...plantedMonthly, ...nightParts(night, true)].sort().join(' '),
      monthly.join('\n'),
    );
    // Each part is age's: its first line is age's header, nothing of the data in plain text. The
    // seal alone is plain text.
    const encrypted = objects.filter((name) => !name.startsWith('seal-'));
    const headers = lines(
      inBackup(
        `for name in ${encrypted.join(' ')}; do printf '%s ' "$name"; rclone cat --head 21 "backups:$BACKUP_BUCKET/daily/$name"; echo; done`,
      ).stdout,
    );
    checks.expect(
      `each of the night's parts starts with age's header (${headers.filter((line) => line.endsWith(' age-encryption.org/v1')).length} of ${encrypted.length}); its seal is the one plain text`,
      encrypted.length === objects.length - 1 &&
        headers.length === encrypted.length &&
        headers.every((line) => line.endsWith(' age-encryption.org/v1')),
      headers.join('\n'),
    );

    // A later whole night of the month makes no second copy.
    while (stampOf(daemonNow()) === stampPart(night)) await sleep(1000);
    archive(stampOf(daemonNow()));
    const next = await measured(`${PROJECT}-backup-${process.pid}`, [
      '--no-deps',
      '-T',
      'backup',
      '/usr/local/bin/backup.sh',
    ]);
    const nextLine = /^backup (\S+): .*$/m.exec(next.stdout);
    const nextSummary = nextLine?.[0] ?? tail(next.stdout, 1);
    const nextNight = nextLine?.[1] ?? night;
    const monthlyNext = bucketNames('monthly');
    checks.expect(
      `a later whole night of the month makes no second copy: exit ${next.status}, "${nextSummary}", monthly/ still ${monthlyNext.length} objects`,
      next.status === 0 &&
        nextSummary.startsWith('backup ') &&
        !nextSummary.includes('kept in monthly') &&
        monthlyNext.join(' ') === monthly.join(' '),
      `${next.stdout}${next.stderr}\n${monthlyNext.join('\n')}`,
    );

    // A night in the running backup service, as its crond runs one, with its WAL shipper at work
    // at once (db's WAL written just before): what the two take of the service's memory together,
    // the base backup included (VPS-43). A whole night of the month, so no copy either.
    while (stampOf(daemonNow()) === stampPart(nextNight)) await sleep(1000);
    archive(stampOf(daemonNow()));
    const service = containerOf('backup') ?? fail('backup has no container');
    writeWal();
    const both = await inService(service, [
      { command: ['/usr/local/bin/backup.sh'] },
      { user: '100:101', command: ['/usr/local/bin/wal-ship.sh'] },
    ]);
    const serviceLine = /^backup (\S+): .*$/m.exec(both.runs[0].stdout);
    const serviceNight = serviceLine?.[1] ?? nextNight;
    const limitMib = Number(value('backup', 'mem_limit').replace(/m$/, ''));
    // The scripts' small files go in /tmp, a tmpfs that counts in that memory (compose.yml): the
    // most it held, which must leave three quarters of its size free.
    const tmpMib = Number(/'\/tmp:size=(\d+)m[,']/.exec(value('backup', 'tmpfs'))?.[1]);
    checks.expect(
      `a night in the backup service itself, as its crond runs one, with wal-ship.sh at once: exits ${both.runs.map((run) => run.status).join(' and ')} in ${both.took} s, "${serviceLine?.[0] ?? tail(both.runs[0].stdout, 1)}"; the service's memory at most ${both.peakMib} MiB of its ${value('backup', 'mem_limit')} (memory.current, page cache included), its /tmp at most ${both.tmpKib} KiB of its ${tmpMib} MiB tmpfs`,
      both.runs.every((run) => run.status === 0) &&
        serviceLine !== null &&
        serviceNight !== nextNight &&
        !serviceLine[0].includes('kept in monthly') &&
        both.peakMib > 0 &&
        both.peakMib < limitMib &&
        tmpMib > 0 &&
        both.tmpKib < (tmpMib * 1024) / 4,
      both.runs.map((run) => `${run.stdout}${run.stderr}`).join('\n'),
    );

    // A base that a checkpoint overtakes: the stand-in pg_basebackup at 4 MB/s, with db made to
    // switch WAL files and checkpoint 3 s in. db then removes what it archived before, and without
    // a slot the WAL file the base starts in is gone when pg_basebackup -X fetch reads it at its
    // end ("requested WAL segment ... has already been removed", tried by hand). The night's
    // temporary slot, menumesh_base_<hex>, keeps it until the base ends, as db shows while the
    // night runs, and goes with the night (VPS-43). The test knows the hex (the stand-in od).
    while (stampOf(daemonNow()) === stampPart(serviceNight)) await sleep(1000);
    archive(stampOf(daemonNow()));
    const slowHex = randomBytes(4).toString('hex');
    const slot = `menumesh_base_${slowHex}`;
    // The slot as db shows it: temporary, the WAL file it keeps from, the WAL file of the latest
    // checkpoint's redo, and whether the kept file is still in pg_wal.
    const watched: string[][] = [];
    const slow = await measured(
      `${PROJECT}-backup-${process.pid}`,
      standInArgs({ FAKE_BASE: 'slow', FAKE_HEX: slowHex }),
      undefined,
      () => {
        for (const row of dbSql(
          `select s.temporary, pg_walfile_name(s.restart_lsn), (select pg_walfile_name(redo_lsn) from pg_control_checkpoint()), (select count(*) from pg_ls_waldir() w where w.name = pg_walfile_name(s.restart_lsn)) from pg_replication_slots s where s.slot_name = '${slot}'`,
        ))
          watched.push(row.split('\t'));
      },
    );
    const slowLine = /^backup (\S+): .*$/m.exec(slow.stdout);
    const slowNight = slowLine?.[1] ?? '';
    // A row taken after the checkpoint: its redo past the file the slot keeps, which is still there.
    const carried = watched.find(
      ([temporary, kept, redo, there]) => temporary === 't' && redo > kept && there === '1',
    );
    const slotsLeft = dbSql(
      "select count(*) from pg_replication_slots where left(slot_name, 14) = 'menumesh_base_'",
    )[0];
    checks.expect(
      `a base that a checkpoint overtakes (the stand-in pg_basebackup at 4 MB/s, db's WAL switched and a checkpoint 3 s in): exit ${slow.status} in ${slow.took} s, "${slowLine?.[0] ?? tail(slow.stdout, 1)}"; while it ran db's slot ${slot} (temporary) kept ${carried?.[1] ?? 'nothing'} in pg_wal past a checkpoint whose redo is in ${carried?.[2] ?? '?'} (${watched.length} looks); after it, ${slotsLeft} slots of a base`,
      slow.status === 0 &&
        slowNight === `${stampPart(slowNight)}-${slowHex}` &&
        carried !== undefined &&
        slotsLeft === '0',
      `${slow.stdout}${slow.stderr}\n${watched.map((row) => row.join(' ')).join('\n')}`,
    );

    // A whole 1st two months back, its stamp from a stand-in date (nothing else is faked): copied
    // whatever monthly/ holds for its month (review finding N2). Then its daily copy goes, as the
    // job removes one after 30 days, so that monthly/ alone holds the night.
    const first = standInBackup({ FAKE_STAMP: oldFirst });
    const firstLine = /^backup (\S+): .*$/m.exec(first.stdout);
    const firstSummary = firstLine?.[0] ?? tail(first.stdout, 1);
    // Its id: the stamp the stand-in gave, and the random part backup.sh drew.
    const oldFirstId = firstLine?.[1] ?? '';
    const firstKept = bucketNames('monthly').filter((name) => name.includes(`-${oldFirstId}.`));
    checks.expect(
      `a whole 1st (${oldFirstId || oldFirst}, stamped by a stand-in date) with names planted for its month in monthly/ (${junk.slice(2).join(', ')}): exit ${first.status}, "${firstSummary}", its ${firstKept.length} parts in monthly/`,
      first.status === 0 &&
        NIGHT_ID.test(oldFirstId) &&
        stampPart(oldFirstId) === oldFirst &&
        firstSummary.endsWith(", kept in monthly/ as the month's copy") &&
        firstKept.join(' ') === nightParts(oldFirstId, true).join(' '),
      `${first.stdout}${first.stderr}`,
    );
    const aged = inBackup(
      `rclone delete --include '*-${oldFirstId}.*' "backups:$BACKUP_BUCKET/daily/"`,
    );
    if (aged.status !== 0) fail(`Removing ${oldFirstId} from daily/ failed: ${aged.stderr.trim()}`);

    // A 1st whose base backup fails, three months back (the stand-ins date and pg_basebackup, which
    // stops after a few bytes): the other parts and the settings archive still go up and are
    // sealed, the seal says "base none" and lists no base, the night fails at the end with the
    // alert, and, a 1st as it is, it is no month's copy (VPS-43).
    const baseFirst = `${monthBefore(`${oldFirst.slice(0, 7)}-01T0000Z`)}-01T2030Z`;
    archive(stampOf(daemonNow()));
    const baseless = standInBackup({ FAKE_STAMP: baseFirst, FAKE_BASE: 'fail' });
    const baselessLine = lines(baseless.stderr).find((line) => line.startsWith('[menumesh]')) ?? '';
    const baselessId =
      /^\[menumesh\] backup failed \(exit \d+\) at (\S+):/.exec(baselessLine)?.[1] ?? '';
    const baselessParts = baselessId ? nightOf(baselessId) : [];
    checks.expect(
      `a 1st whose base backup fails (${baselessId || baseFirst}, a stand-in pg_basebackup that stops early): exit ${baseless.status}, "${baselessLine}", with pg_basebackup's line "${lines(baseless.stderr).find((line) => line.startsWith('backup: | ')) ?? ''}"; the other parts, the settings archive and the seal in daily/ all the same (${baselessParts.length} objects), nothing of it in monthly/`,
      baseless.status === 1 &&
        stampPart(baselessId) === baseFirst &&
        baselessLine ===
          `[menumesh] backup failed (exit 1) at ${baselessId}: the base backup failed or ran past 2 hours (pg_basebackup, zstd, age or rclone)` &&
        baseless.stderr.includes('backup: | pg_basebackup: error: the stand-in failed') &&
        nightParts(baselessId, true, false).every((name) => baselessParts.includes(name)) &&
        !bucketNames('monthly').some((name) => name.includes(`-${baselessId}.`)),
      `${baseless.stdout}${baseless.stderr}\n${baselessParts.join('\n')}`,
    );

    // A month whose copy is gone from monthly/, as if it had never gone up, four months back (the
    // stand-in date): its first whole night, on the 2nd, made it; then its parts and seal go, and a
    // token holder puts that night's real seal back, copied from daily/, beside an object named
    // after each part it lists, a space and an x, at the size it gives. monthly/'s listing quotes no
    // name, so those read as the parts' own lines; looked up by their exact names, the parts are
    // not there, and the month's next whole night is still its copy (Stop C's review, finding S2).
    const absent = monthBefore(`${baseFirst.slice(0, 7)}-01T0000Z`);
    archive(stampOf(daemonNow()));
    const absentFirst = standInBackup({ FAKE_STAMP: `${absent}-02T2030Z` });
    const absentFirstId =
      /^backup (\S+): .*, kept in monthly\/ as the month's copy$/m.exec(absentFirst.stdout)?.[1] ??
      fail(
        `The first night of ${absent} made no month's copy:\n${absentFirst.stdout}${absentFirst.stderr}`,
      );
    const lookalike = inBackup(
      [
        'set -e',
        `rclone delete --include '*-${absentFirstId}.*' "backups:$BACKUP_BUCKET/monthly/"`,
        `rclone copyto "backups:$BACKUP_BUCKET/daily/seal-${absentFirstId}.txt" "backups:$BACKUP_BUCKET/monthly/seal-${absentFirstId}.txt"`,
        `rclone cat "backups:$BACKUP_BUCKET/daily/seal-${absentFirstId}.txt" | sed -n 's/^part [0-9a-f]* \\([0-9]*\\) \\(.*\\)$/\\1 \\2/p' >/tmp/sealed`,
        'while read -r bytes name; do',
        '  head -c "$bytes" /dev/urandom | rclone rcat "backups:$BACKUP_BUCKET/monthly/$name x"',
        '  echo "$name x"',
        'done </tmp/sealed',
      ].join('\n'),
    );
    const lookalikes = lines(lookalike.stdout);
    if (
      lookalike.status !== 0 ||
      lookalikes.length !== nightParts(absentFirstId, true).length - 1
    ) {
      fail(
        `Planting look-alikes of ${absentFirstId} failed: ${lookalike.stdout}${lookalike.stderr}`,
      );
    }
    // rclone serve s3 lists a folder from a cache of 5 s: wait until monthly/ shows them.
    for (let tries = 0; tries < 20; tries++) {
      const listed = bucketNames('monthly');
      if (
        listed.includes(`seal-${absentFirstId}.txt`) &&
        lookalikes.every((name) => listed.includes(name)) &&
        !listed.includes(`base-${absentFirstId}.tar.zst.age`)
      )
        break;
      await sleep(1000);
    }
    const absentNext = standInBackup({ FAKE_STAMP: `${absent}-03T2030Z` });
    const absentNextLine = /^backup (\S+): .*$/m.exec(absentNext.stdout);
    const absentNextId = absentNextLine?.[1] ?? '';
    const monthlyAbsent = bucketNames('monthly').filter((name) => name.includes(`-${absent}-`));
    checks.expect(
      `a month whose copy is gone from monthly/ (${absent}, stand-in stamps), its first night's real seal put back there beside ${lookalikes.length} objects named after the parts it lists, a space and an x, at its sizes ("${lookalikes.find((name) => name.startsWith('base-')) ?? ''}"): the month's next whole night is still its copy, each part looked up by its name: exit ${absentNext.status}, "${absentNextLine?.[0] ?? tail(absentNext.stdout, 1)}", its ${monthlyAbsent.filter((name) => name.includes(`-${absentNextId}.`)).length} objects in monthly/`,
      absentNext.status === 0 &&
        stampPart(absentNextId) === `${absent}-03T2030Z` &&
        (absentNextLine?.[0] ?? '').endsWith(", kept in monthly/ as the month's copy") &&
        monthlyAbsent.filter((name) => name.includes(`-${absentNextId}.`)).join(' ') ===
          nightParts(absentNextId, true).join(' ') &&
        lookalikes.every((name) => monthlyAbsent.includes(name)),
      `${absentNext.stdout}${absentNext.stderr}\n${monthlyAbsent.join('\n')}`,
    );
    const unlooked = inBackup(
      `rclone delete --include '*-${absentFirstId}.*' "backups:$BACKUP_BUCKET/monthly/"`,
    );
    if (unlooked.status !== 0)
      fail(`Removing the look-alikes of ${absentFirstId} failed: ${unlooked.stderr.trim()}`);

    // Every night above as a restore reads it, with Node's crypto: its seal signed by the backup's
    // key, and each part it lists in its folder as it went up; the month's copies too.
    const nights = sealsChecked(checks, env, [
      { folder: 'daily', night: failedNight, config: false, base: true },
      { folder: 'daily', night, config: true, base: true },
      { folder: 'monthly', night, config: true, base: true },
      { folder: 'daily', night: nextNight, config: true, base: true },
      { folder: 'daily', night: serviceNight, config: true, base: true },
      { folder: 'daily', night: slowNight, config: true, base: true },
      { folder: 'monthly', night: oldFirstId, config: true, base: true },
      { folder: 'daily', night: baselessId, config: true, base: false },
      { folder: 'monthly', night: absentNextId, config: true, base: true },
    ]);
    const unbased = inBackup(
      `rclone delete --include '*-${baselessId}.*' "backups:$BACKUP_BUCKET/daily/"`,
    );
    if (unbased.status !== 0)
      fail(`Removing ${baselessId} from daily/ failed: ${unbased.stderr.trim()}`);

    // The night's base backup, as a point-in-time recovery reads it: a tar with backup_label,
    // backup_manifest and, under pg_wal/, the WAL it needs from the file its seal names, of the
    // cluster its seal names, which is db's, named by the night; started before the seal's end.
    const nightSeal = sealOf(nights.get(`daily ${night}`)?.seal ?? '', night);
    const sealedBase = typeof nightSeal === 'string' ? undefined : nightSeal.base;
    const based = baseOf(night);
    const labelled = (name: string) =>
      based.label.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? '';
    const startFile = /\(file ([0-9A-F]{24})\)$/.exec(labelled('START WAL LOCATION'))?.[1] ?? '';
    const startTime = Date.parse(labelled('START TIME').replace(' ', 'T').replace(' UTC', 'Z'));
    checks.expect(
      `the night's base backup, decrypted and unpacked: a ${Math.round(based.bytes / 1048576)} MiB tar of ${based.names.length} members with backup_label, backup_manifest and pg_wal/${startFile}; backup_label starts in ${startFile} on "${labelled('LABEL')}", the manifest's system ${based.system}: the seal's base line "${sealedBase ? `${sealedBase.end} ${sealedBase.walfile} ${sealedBase.cluster}` : 'none'}", db's cluster`,
      sealedBase !== undefined &&
        ['backup_label', 'backup_manifest', `pg_wal/${sealedBase.walfile}`].every((name) =>
          based.names.includes(name),
        ) &&
        startFile === sealedBase.walfile &&
        labelled('LABEL') === `menumesh ${night}` &&
        based.system === sealedBase.cluster &&
        based.system === clusterId() &&
        startTime <= Date.parse(sealedBase.end),
      `${based.names.slice(0, 20).join('\n')}\n${based.label.join('\n')}\nsystem ${based.system}`,
    );

    // A name of a night's id that someone else wrote first. Nobody can know an id before its night
    // runs; the stand-in od gives backup.sh the random part the test chose, so the test plays one
    // who could. The night stops before its first upload, saying someone else wrote to the
    // bucket, and uploads nothing (review finding F1: a planted name had the bucket's locks refuse
    // the night's own uploads).
    const knownStamp = `${earlier}-15T2030Z`;
    const knownHex = randomBytes(4).toString('hex');
    const knownId = `${knownStamp}-${knownHex}`;
    const knownName = `storage-${knownId}.tar.age`;
    const plantKnown = inBackup(
      `printf 'planted, not age\\n' | rclone rcat "backups:$BACKUP_BUCKET/daily/${knownName}"`,
    );
    if (plantKnown.status !== 0)
      fail(`Planting ${knownName} in daily/ failed: ${plantKnown.stderr.trim()}`);
    // rclone serve s3 lists a folder from a cache of 5 s: wait until daily/ shows it.
    for (let tries = 0; tries < 20; tries++) {
      if (bucketNames('daily').includes(knownName)) break;
      await sleep(1000);
    }
    const monthlyKnown = bucketNames('monthly');
    const known = standInBackup({ FAKE_STAMP: knownStamp, FAKE_HEX: knownHex });
    const knownLine = lines(known.stderr).find((line) => line.startsWith('[menumesh]')) ?? '';
    const knownParts = nightOf(knownId);
    checks.expect(
      `a night whose id someone else wrote a name of first (${knownName}, the id from the stand-ins): exit ${known.status}, "${knownLine}"; of that id daily/ still holds only ${knownParts.join(', ') || 'nothing'}, monthly/ unchanged`,
      known.status === 1 &&
        knownLine ===
          `[menumesh] backup failed (exit 1) at ${knownId}: someone else wrote to the bucket: daily/ holds ${knownName} before tonight's first upload` &&
        knownParts.join(' ') === knownName &&
        bucketNames('monthly').join(' ') === monthlyKnown.join(' '),
      `${known.stdout}${known.stderr}\n${knownParts.join('\n')}`,
    );
    const unplanted = inBackup(
      `rclone delete --include '*-${knownId}.*' "backups:$BACKUP_BUCKET/daily/"`,
    );
    if (unplanted.status !== 0)
      fail(`Removing ${knownName} from daily/ failed: ${unplanted.stderr.trim()}`);

    // The monthly restore test into restore-db, with the rehearsal's throwaway key on /run/age, of
    // the month's copy by name: younger than 29 days, it is read from daily/ alone, though monthly/
    // holds it too (review finding RV1).
    const age = ['--volume', `${slash(join(MIRROR, 'age'))}:/run/age:ro`];
    const test = await measured(
      `${PROJECT}-restore-test-${process.pid}`,
      ['-T', '-e', 'RESTORE_EXACT=1', '-e', `RESTORE_STAMP=${night}`, ...age, 'restore-test'],
      'restore-test',
    );
    const restoreDb = cgroupMemory('restore-db', 'restore-test', true);
    const restoredMb = Math.round(
      Number(
        compose([
          '--profile',
          'restore-test',
          'exec',
          '-T',
          'restore-db',
          'du',
          '-sk',
          '/var/lib/postgresql/data',
        ]).stdout.split('\t')[0],
      ) / 1024,
    );
    const said = lines(test.stdout).filter((line) => line.startsWith('restore'));
    checks.expect(
      `the restore test (restore-db, RESTORE_EXACT=1, the night ${night}): exit ${test.status} in ${usage(test, 'restore-test')}; restore-db at most ${restoreDb?.peak ?? '?'} MiB of its ${value('restore-db', 'mem_limit')}, the cluster ${restoredMb} MB of its 1g tmpfs. Each part downloaded, held to its seal, then decrypted from there into pg_restore's pipe. ${said.join(' / ')}`,
      test.status === 0 &&
        test.stdout.includes(`restore: the night of ${night}, from daily/, into restore-db\n`) &&
        /^restore: its seal is signed by the backup's key, and the 5 parts read match it \(\d+ bytes\)$/m.test(
          test.stdout,
        ) &&
        /^restore: postgres has its \d+ tables as the manifest counted them$/m.test(test.stdout) &&
        /^restore: Storage holds \d+ files as the manifest counted$/m.test(test.stdout) &&
        test.stdout.endsWith(`restore test passed: the night of ${night}, from daily/\n`),
      tail(`${test.stdout}${test.stderr}`),
    );
    if (test.status === 0) {
      compareRestore(checks, 'restore-db', source, fingerprint('restore-db', 'restore-test'));
      vault(checks, 'restore-db', 'restore-test');
    }
    compose(['--profile', 'restore-test', 'rm', '--stop', '--force', 'restore-db']);
    // restore.sh compared the night's Storage archive (files and bytes) with its manifest; nothing
    // has written to storage-data since the night, so the volume holds that many files.
    const counted = /^restore: Storage holds (\d+) files as the manifest counted$/m.exec(
      test.stdout,
    )?.[1];
    checks.expect(
      `the night's Storage archive holds ${counted ?? '?'} files, as storage-data does (${fileTotals(files)})`,
      counted !== undefined && Number(counted) === files.length,
      test.stdout,
    );

    // A manifest a token holder put in monthly/ under the later night, which daily/ alone holds,
    // and not even age's, with a seal another key signed: a night younger than 29 days is read
    // from daily/ only, so they stop nothing (review finding RV1: the two folders' manifests were
    // compared, and the restore test and the recovery of that night stopped).
    if (nextNight === night) fail('The later night of the month did not run.');
    const stray = `manifest-${nextNight}.txt.age`;
    putObject(`monthly/${stray}`, 'planted, not age\n');
    const straySeal = `seal-${nextNight}.txt`;
    putObject(
      `monthly/${straySeal}`,
      sealText(nextNight, undefined, [{ sha256: '0'.repeat(64), bytes: 17, name: stray }], forger),
    );
    // rclone serve s3 lists a folder from a cache of 5 s: wait until monthly/ shows them.
    for (let tries = 0; tries < 20; tries++) {
      const listed = bucketNames('monthly');
      if (listed.includes(stray) && listed.includes(straySeal)) break;
      await sleep(1000);
    }
    const beside = await measured(
      `${PROJECT}-restore-test-${process.pid}`,
      ['-T', '-e', 'RESTORE_EXACT=1', '-e', `RESTORE_STAMP=${nextNight}`, ...age, 'restore-test'],
      'restore-test',
    );
    compose(['--profile', 'restore-test', 'rm', '--stop', '--force', 'restore-db']);
    const strayListed = bucketNames('monthly').includes(stray);
    checks.expect(
      `a manifest, not even age's, and a seal another key signed, planted in monthly/ under ${nextNight}, a night of daily/ alone (${strayListed ? 'listed there' : 'not listed'}): the night's restore test by RESTORE_STAMP exit ${beside.status}, "${lines(beside.stdout).find((line) => line.startsWith('restore: the night')) ?? ''}", "${tail(beside.stdout, 1)}"`,
      beside.status === 0 &&
        strayListed &&
        beside.stdout.includes(
          `restore: the night of ${nextNight}, from daily/, into restore-db\n`,
        ) &&
        beside.stdout.endsWith(`restore test passed: the night of ${nextNight}, from daily/\n`),
      tail(`${beside.stdout}${beside.stderr}`),
    );

    // Planted nights, as whoever holds the bucket's token and the public key could upload them,
    // these sealed with the rehearsal's own signing key, as if it had leaked: the restore's guards
    // behind the seal must still hold (VPS-40, VPS-43). One stamped 9999-12-31 sorts last and is
    // never taken unasked; one of this minute, the newest by name, is, and its roles file has psql
    // print a notice made to erase the night's line and put the good night's in its place (N4),
    // then reads the owner's key with \i; one named by RESTORE_STAMP would copy the key into the
    // bucket with \! first (S1). Each must stop at the roles with nothing run: no object at the
    // bucket's top, no line of the key, no escape. One has a link in its Storage archive (N6), and
    // one is a copy in daily/ of the 1st two months back, past 29 days and so read from monthly/
    // alone (RV2). Two more, read further below, have a seal another key signed, or none.
    while (stampOf(daemonNow()) <= stampPart(slowNight || serviceNight)) await sleep(1000);
    const future = idOf(FUTURE);
    const planted = idOf(stampOf(daemonNow()));
    const daysAgo = (days: number) =>
      idOf(stampOf(new Date(Date.parse(daemonNow()) - days * 86_400_000).toISOString()));
    const older = daysAgo(3);
    const linked = daysAgo(4);
    const forgedNight = daysAgo(5);
    const unsealed = daysAgo(6);
    const fake = `restore: the night of ${night}, from daily/, into restore-db`;
    const leaked = env.BACKUP_SIGNING_KEY;
    plantNight(future, plantedRoles('copy'), leaked);
    plantNight(planted, plantedRoles('read', fake), leaked);
    plantNight(older, plantedRoles('copy'), leaked);
    plantNight(linked, 'CREATE ROLE planted_link;\n', leaked, 'link');
    plantNight(oldFirstId, plantedRoles('copy'), leaked);
    plantNight(forgedNight, plantedRoles('copy'), forger);
    plantNight(unsealed, plantedRoles('copy'), undefined);
    // rclone serve s3 lists a folder from a cache of 5 s: wait until daily/ shows all seven, each
    // with the five parts of a night without a base, and the seals.
    const plantedNames = [
      future,
      planted,
      older,
      linked,
      oldFirstId,
      forgedNight,
      unsealed,
    ].flatMap((id) =>
      nightParts(id, true, false).filter((name) => id !== unsealed || !name.startsWith('seal-')),
    );
    for (let tries = 0; tries < 20; tries++) {
      const listed = bucketNames('daily');
      if (plantedNames.every((name) => listed.includes(name))) break;
      await sleep(1000);
    }
    const cases: [string, string[], string][] = [
      ['unasked: the newest id', [], planted],
      ['named by RESTORE_STAMP', ['-e', `RESTORE_STAMP=${older}`], older],
    ];
    for (const [how, extra, want] of cases) {
      const run = await measured(
        `${PROJECT}-restore-test-${process.pid}`,
        ['-T', ...extra, ...age, 'restore-test'],
        'restore-test',
      );
      compose(['--profile', 'restore-test', 'rm', '--stop', '--force', 'restore-db']);
      const output = `${run.stdout}\n${run.stderr}`;
      const top = bucketNames('');
      const refused = lines(output).find((line) => line.includes('restricted')) ?? '';
      const notice = lines(output).find((line) => line.startsWith('NOTICE:')) ?? '';
      checks.expect(
        `a planted night ${how} (${want}${extra.length ? '' : `, ${future} not taken`}): exit ${run.status} at the roles, "${refused.trim()}"; the bucket's top ${top.length ? `holds ${top.join(', ')}` : 'empty'}, no line of the key printed${extra.length ? '' : `, and its notice without its escapes: "${notice}"`}`,
        run.status === 1 &&
          (extra.length > 0 || output.includes(`restore: not taking the night of ${future},`)) &&
          lines(output).find((line) => line.startsWith('restore: the night of ')) ===
            `restore: the night of ${want}, from daily/, into restore-db` &&
          refused.includes('backslash commands are restricted') &&
          output.includes(
            `restore: the roles of ${want} (globals-${want}.sql.age in daily/) did not restore (see above)`,
          ) &&
          (extra.length > 0 || (notice.endsWith(fake) && notice !== fake)) &&
          !terminalControls(output) &&
          !keyShown(output) &&
          top.length === 0,
        tail(output),
      );
    }
    // The Storage archive with a link, refused before anything is restored (N6).
    const link = await measured(
      `${PROJECT}-restore-test-${process.pid}`,
      ['-T', '-e', `RESTORE_STAMP=${linked}`, ...age, 'restore-test'],
      'restore-test',
    );
    const linkRole = sqlIn(
      'restore-db',
      "select count(*) from pg_roles where rolname = 'planted_link'",
      'restore-test',
    ).stdout.trim();
    compose(['--profile', 'restore-test', 'rm', '--stop', '--force', 'restore-db']);
    const linkOutput = `${link.stdout}\n${link.stderr}`;
    checks.expect(
      `a planted night whose Storage archive holds a link, restore test (${linked}): exit ${link.status}, "${lines(linkOutput).find((line) => line.includes('links or special files')) ?? ''}"; nothing restored: no roles step, restore-db without its role (${linkRole})`,
      link.status === 1 &&
        sealedThenLink(linked, 'restore-db').test(link.stdout) &&
        !/^restore: roles$/m.test(linkOutput) &&
        linkRole === '0',
      tail(linkOutput),
    );

    // Nights the backup's key did not seal, and parts not as it sealed them, are refused before
    // anything of the night is read or restored, saying so (VPS-43): a planted night whose seal
    // another key signed, and one with no seal; a part of a real night replaced after its seal,
    // as many bytes, one of them changed (the rehearsal's S3 takes overwrites, which the
    // recommended locks refuse); and a part the seal doesn't list, a settings archive planted for
    // the night whose own was stale, not even age's, which is never read.
    const forgedRun = await refusedRestore(forgedNight, age);
    checks.expect(
      `a planted night sealed by another key, restore test (${forgedNight}): exit ${forgedRun.run.status}, "${tail(forgedRun.run.stdout, 1)}", and nothing else; restore-db ${forgedRun.bare ? 'still bare' : 'not bare'}`,
      forgedRun.run.status === 1 &&
        forgedRun.bare &&
        forgedRun.run.stdout ===
          `restore: the night of ${forgedNight} is not signed by the backup's key: its seal (seal-${forgedNight}.txt in daily/) is signed by none of BACKUP_SIGNING_PUBLIC_KEY's keys, so someone else wrote to the bucket, and nothing of the night was read\n`,
      tail(forgedRun.output),
    );
    const unsealedRun = await refusedRestore(unsealed, age);
    checks.expect(
      `a planted night with no seal, restore test (${unsealed}): exit ${unsealedRun.run.status}, "${tail(unsealedRun.run.stdout, 1)}", and nothing else; restore-db ${unsealedRun.bare ? 'still bare' : 'not bare'}`,
      unsealedRun.run.status === 1 &&
        unsealedRun.bare &&
        unsealedRun.run.stdout ===
          `restore: the night of ${unsealed} is younger than 29 days, so only daily/ is read for it: daily/ keeps every night of the last 29 days under its lock; this one has no seal there, so it is not signed by the backup's key: a backup that stopped before its seal, or someone else wrote to the bucket (the backup's journal names the nights it sealed)\n`,
      tail(unsealedRun.output),
    );
    const victim = `postgres-${nextNight}.dump.age`;
    const flipped = inBackup(
      [
        'set -e',
        `rclone cat --no-traverse "backups:$BACKUP_BUCKET/daily/${victim}" >/tmp/part`,
        'before=$(sha256sum </tmp/part | cut -d " " -f 1)',
        'size=$(wc -c </tmp/part)',
        'at=$((size / 2))',
        'byte=$(od -An -tu1 -j"$at" -N1 /tmp/part | tr -d " ")',
        `printf "$(printf '\\\\%03o' "$(( (byte + 1) % 256 ))")" | dd of=/tmp/part bs=1 seek="$at" conv=notrunc 2>/dev/null`,
        `rclone copyto /tmp/part "backups:$BACKUP_BUCKET/daily/${victim}"`,
        'echo "$size $(wc -c </tmp/part) $before $(sha256sum </tmp/part | cut -d " " -f 1)"',
      ].join('\n'),
    );
    const [sizeBefore, sizeAfter, sumBefore, sumAfter] = flipped.stdout.trim().split(' ');
    if (flipped.status !== 0 || sizeBefore !== sizeAfter || sumBefore === sumAfter) {
      fail(`Changing a byte of ${victim} failed: ${flipped.stdout}${flipped.stderr}`);
    }
    const replacedRun = await refusedRestore(nextNight, age);
    checks.expect(
      `${victim}, replaced after the seal by as many bytes with one changed: the restore test of ${nextNight} exit ${replacedRun.run.status}, "${tail(replacedRun.run.stdout, 1)}", right after the night's line; no roles step, restore-db ${replacedRun.bare ? 'still bare' : 'not bare'}`,
      replacedRun.run.status === 1 &&
        replacedRun.bare &&
        replacedRun.run.stdout ===
          `restore: the night of ${nextNight}, from daily/, into restore-db\nrestore: ${victim} in daily/ is not the part the backup sealed (its sha256 is not the seal's): someone else wrote to the bucket, and nothing of the night was restored\n`,
      tail(replacedRun.output),
    );
    // A part made longer after its seal, by 1 MiB: read no further than a byte past the size the
    // seal gives, and refused for it.
    const longer = `storage-${serviceNight}.tar.age`;
    const serviceSeal = sealOf(nights.get(`daily ${serviceNight}`)?.seal ?? '', serviceNight);
    const sealedBytes =
      typeof serviceSeal === 'string'
        ? 0
        : (serviceSeal.parts.find(({ name }) => name === longer)?.bytes ?? 0);
    const grown = inBackup(
      [
        'set -e',
        `rclone cat --no-traverse "backups:$BACKUP_BUCKET/daily/${longer}" >/tmp/part`,
        'head -c 1048576 /dev/zero >>/tmp/part',
        `rclone copyto /tmp/part "backups:$BACKUP_BUCKET/daily/${longer}"`,
      ].join('\n'),
    );
    if (grown.status !== 0 || !sealedBytes) fail(`Making ${longer} longer failed: ${grown.stderr}`);
    const longerRun = await refusedRestore(serviceNight, age);
    checks.expect(
      `${longer}, 1 MiB longer than its seal gives: the restore test of ${serviceNight} exit ${longerRun.run.status}, "${tail(longerRun.run.stdout, 1)}" (read to a byte past the seal's ${sealedBytes}); no roles step, restore-db ${longerRun.bare ? 'still bare' : 'not bare'}`,
      longerRun.run.status === 1 &&
        longerRun.bare &&
        longerRun.run.stdout ===
          `restore: the night of ${serviceNight}, from daily/, into restore-db\nrestore: ${longer} in daily/ is not the part the backup sealed (${sealedBytes + 1} bytes, not ${sealedBytes}): someone else wrote to the bucket, and nothing of the night was restored\n`,
      tail(longerRun.output),
    );
    // A night whose seal gives a part more bytes than this disk has free (signed with the
    // rehearsal's own key, as a backup's seal of a night too big for a new server's disk): refused
    // before any of its parts but the manifest is downloaded.
    const huge = daysAgo(7);
    const hugeParts = plantNight(huge, plantedRoles('copy'), undefined).map((part) =>
      part.name.startsWith('storage-') ? { ...part, bytes: 999_999_999_999_999 } : part,
    );
    putObject(`daily/seal-${huge}.txt`, sealText(huge, undefined, hugeParts, leaked));
    for (let tries = 0; tries < 20; tries++) {
      if (bucketNames('daily').includes(`seal-${huge}.txt`)) break;
      await sleep(1000);
    }
    const hugeRun = await refusedRestore(huge, age);
    checks.expect(
      `a night whose seal gives its Storage archive 999,999,999,999,999 bytes: its restore test exit ${hugeRun.run.status}, "${tail(hugeRun.run.stdout, 1)}", and nothing else; restore-db ${hugeRun.bare ? 'still bare' : 'not bare'}`,
      hugeRun.run.status === 1 &&
        hugeRun.bare &&
        new RegExp(
          `^restore: the parts of ${huge} need \\d+ MiB in this container's files, 1 GiB to spare included, and \\d+ MiB are free\\n$`,
        ).test(hugeRun.run.stdout),
      tail(hugeRun.output),
    );
    const unlisted = `config-${failedNight}.tar.age`;
    putObject(`daily/${unlisted}`, 'planted, not age\n');
    for (let tries = 0; tries < 20; tries++) {
      if (bucketNames('daily').includes(unlisted)) break;
      await sleep(1000);
    }
    const unlistedRun = await refusedRestore(failedNight, age);
    checks.expect(
      `a settings archive planted for ${failedNight}, whose seal lists none: its restore test exit ${unlistedRun.run.status}, "${tail(unlistedRun.run.stdout, 1)}", and nothing else (age never read the planted part); restore-db ${unlistedRun.bare ? 'still bare' : 'not bare'}`,
      unlistedRun.run.status === 1 &&
        unlistedRun.bare &&
        unlistedRun.run.stdout ===
          `restore: the night of ${failedNight} has no settings archive in its seal (${unlisted}): its backup had none fresh enough, so a test of it can't pass, and nothing of it was read\n`,
      tail(unlistedRun.output),
    );
    // The 1st two months back, with the planted copy in daily/ under its id: past 29 days, read
    // from monthly/ alone, and daily/ never looked in (RV2).
    const past = await measured(
      `${PROJECT}-restore-test-${process.pid}`,
      ['-T', '-e', 'RESTORE_EXACT=1', '-e', `RESTORE_STAMP=${oldFirstId}`, ...age, 'restore-test'],
      'restore-test',
    );
    compose(['--profile', 'restore-test', 'rm', '--stop', '--force', 'restore-db']);
    const pastOutput = `${past.stdout}\n${past.stderr}`;
    const pastTop = bucketNames('');
    checks.expect(
      `a night 29 days old or more (${oldFirstId}), held by monthly/ and planted in daily/ under its id: exit ${past.status}, "${lines(past.stdout).find((line) => line.startsWith('restore: the night')) ?? ''}", "${tail(past.stdout, 1)}"; daily/ never named, the planted copy never read (no psql command refused), the bucket's top ${pastTop.length ? `holds ${pastTop.join(', ')}` : 'empty'}`,
      past.status === 0 &&
        past.stdout.includes(
          `restore: the night of ${oldFirstId}, from monthly/, into restore-db\n`,
        ) &&
        past.stdout.endsWith(`restore test passed: the night of ${oldFirstId}, from monthly/\n`) &&
        !pastOutput.includes('daily/') &&
        !pastOutput.includes('restricted') &&
        pastTop.length === 0,
      tail(pastOutput),
    );

    // The planted nights go but the one with a link, which the recovery is given first, and the
    // copy of the 1st two months back, which the recovery must not read. So does the good night's
    // daily copy: younger than 29 days, it is read from daily/ alone, so with only its monthly/
    // copy left its restore test is refused, saying why (review findings B1 and RV1).
    const removed = inBackup(
      `rclone delete --include '*-${future}.*' --include '*-${planted}.*' --include '*-${older}.*' --include '*-${forgedNight}.*' --include '*-${unsealed}.*' --include '*-${huge}.*' --include '*-${night}.*' "backups:$BACKUP_BUCKET/daily/"`,
    );
    if (removed.status !== 0) fail(`Removing nights from daily/ failed: ${removed.stderr.trim()}`);
    // rclone serve s3 lists a folder from a cache of 5 s: wait until daily/ no longer shows them.
    for (let tries = 0; tries < 20; tries++) {
      if (!bucketNames('daily').some((name) => name.includes(night))) break;
      await sleep(1000);
    }
    const youngOnly = await measured(
      `${PROJECT}-restore-test-${process.pid}`,
      ['-T', '-e', `RESTORE_STAMP=${night}`, ...age, 'restore-test'],
      'restore-test',
    );
    compose(['--profile', 'restore-test', 'rm', '--stop', '--force', 'restore-db']);
    checks.expect(
      `the restore test of ${night}, younger than 29 days, by RESTORE_STAMP with only its monthly/ copy left: exit ${youngOnly.status}, "${tail(youngOnly.stdout, 1)}"`,
      youngOnly.status === 1 &&
        youngOnly.stdout ===
          `restore: the night of ${night} is younger than 29 days, so only daily/ is read for it: daily/ keeps every night of the last 29 days under its lock; this one has no seal there, so it is not signed by the backup's key: a backup that stopped before its seal, or someone else wrote to the bucket (the backup's journal names the nights it sealed)\n`,
      tail(`${youngOnly.stdout}${youngOnly.stderr}`),
    );

    handedOver = true;
    await recovery(checks, env, oldFirstId, source, files, age, linked);
    await pitrProof(checks, env, age);
  } finally {
    if (!handedOver) compose(['up', '-d', '--no-deps', 'web', 'scheduler', 'backup']);
  }
  // The local S3 stays, as the backup service ships db's WAL to it while the rehearsal runs.
  removeOldBuilds();
  console.log(
    `\nvps:backup-test: ${checks.passed + checks.failed} checks, ${checks.failed} failed`,
  );
  if (checks.failed) process.exit(1);
}

/**
 * A restore against the source's FINGERPRINT: the same catalog and rows, but for what a dump can't
 * carry (restoreDifferences), listed under the check.
 */
function compareRestore(checks: Checks, what: string, source: string[], restored: string[]) {
  const { known, unknown } = restoreDifferences(source, restored);
  const of = (kind: string) => restored.filter((line) => line.startsWith(`${kind}|`));
  const rows = of('rows').reduce((sum, line) => sum + Number(line.split('|')[2]), 0);
  const names = of('ext').map((line) => line.split('|')[1]);
  checks.expect(
    `${what} against the source: the same ${of('role').length} roles (${of('member').length} memberships, ${of('setting').length} settings), ${of('ext').length} extensions (${names.join(', ')}), ${of('evt').length} event triggers, ${of('publication').length} publications (${of('published').length} tables); ${of('schema').length} schemas, ${of('rel').length} relations, ${of('proc').length} functions and ${of('type').length} types with their owners and grants, ${of('constraint').length} constraints, ${of('policy').length} policies, ${of('trigger').length} triggers, ${of('seq').length} sequences; ${of('rows').length} tables with the same ${rows} rows. Not carried by a dump: ${known.length}`,
    restored.length > 0 && !unknown.length,
    unknown.join('\n'),
  );
  for (const line of known) console.log(`    · ${line}`);
}

/** The vault secret, decrypted: its value, or psql's error. */
function vaultSecret(service: string, profile?: string) {
  const read = sqlIn(
    service,
    `select decrypted_secret from vault.decrypted_secrets where name = '${VAULT_NAME}'`,
    profile,
  );
  return read.status === 0
    ? read.stdout.trim()
    : (/ERROR: +(.*)/.exec(read.stderr)?.[1] ?? read.stderr.trim());
}

/**
 * The vault secret in a restored cluster: its row is back, but it decrypts only with the source's
 * root key (pgsodium_root.key on db-config), which no part of the backup holds. MenuMesh keeps
 * nothing in vault.
 */
function vault(checks: Checks, service: string, profile?: string) {
  const count = sqlIn(
    service,
    `select count(*) from vault.secrets where name = '${VAULT_NAME}'`,
    profile,
  );
  const read = vaultSecret(service, profile);
  checks.expect(
    `vault in ${service}: the secret's row is back (${count.stdout.trim()}), and it doesn't decrypt without db's first root key, which no part of the backup holds ("${read}")`,
    count.stdout.trim() === '1' && read !== VAULT_VALUE,
    `${count.stdout}${count.stderr}${read}`,
  );
}

// --- the disaster recovery (plan H.6), on the rehearsal's own volumes ---

/**
 * Through the gateway on 127.0.0.1:8300, as a browser: the seed's owner signs in, PostgREST gives
 * the owner's restaurant with that token, and Realtime takes the WebSocket upgrade. What a check
 * line says, whether it all worked, and the answers when not.
 */
async function ownerThroughGateway(env: Record<string, string>) {
  const apikey = { apikey: env.SUPABASE_PUBLISHABLE_KEY };
  const owner = await local(8300, '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { ...apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@local.test', password: 'Password123!' }),
  });
  let token = '';
  try {
    token = String((JSON.parse(owner.body) as Record<string, unknown>).access_token ?? '');
  } catch {
    // Not JSON: the check shows the answer.
  }
  const slugs = await local(8300, '/rest/v1/restaurants?select=slug&order=slug', {
    headers: { ...apikey, Authorization: `Bearer ${token}` },
  });
  const realtime = await local(
    8300,
    `/realtime/v1/websocket?apikey=${env.SUPABASE_PUBLISHABLE_KEY}&vsn=1.0.0`,
    { headers: websocket },
  );
  return {
    said: `the seed's owner signs in (${token ? jwtHeader(token).alg : owner.status}), rest ${slugs.status} with the owner's restaurant, realtime ${realtime.status}`,
    ok:
      owner.status === 200 &&
      token !== '' &&
      jwtHeader(token).alg === 'ES256' &&
      slugs.status === 200 &&
      slugs.body.includes('"slug":"demo"') &&
      realtime.status === 101,
    detail: `sign-in ${owner.status} ${owner.body.slice(0, 200)}; rest ${slugs.status} ${slugs.body.slice(0, 200)}`,
  };
}

/**
 * docs/RUNBOOK.md's disaster recovery, on the rehearsal: the recover one-off restores a night into
 * new db-data, db-config and storage-data volumes, as on a new server, through recover-db's bare
 * cluster; then db starts on them, finds a cluster and skips its init, migrate finds nothing to
 * apply, and the rest follows. On the way, recover is refused while db runs, onto db's cluster once
 * it stopped, and onto Storage's old files; without RESTORE_STAMP it refuses to run (review finding
 * F4); and given a planted night whose Storage archive holds a link (`linked`), it stops before it
 * writes anything (review finding N6), so the same new volumes then take the real night. That night, the 1st two months back, must be the source's: past 29
 * days, it is read from its monthly copy alone, past the planted copy in daily/ under its name
 * (review finding RV2).
 */
async function recovery(
  checks: Checks,
  env: Record<string, string>,
  night: string,
  source: string[],
  files: string[],
  age: string[],
  linked: string,
) {
  // Always a named night, the source's but for the planted one: a refusal that failed would
  // restore that one, not a newer one.
  const recover = (extra: string[] = [], stamp = night) =>
    measured(
      `${PROJECT}-recover-${process.pid}`,
      ['-T', '-e', `RESTORE_STAMP=${stamp}`, ...extra, ...age, 'recover'],
      'recover',
    );
  const recoverDbLog = () => logsOf(containerOf('recover-db') ?? '');
  const dropRecoverDb = () =>
    compose(['--profile', 'recover', 'rm', '--stop', '--force', 'recover-db']);
  const [dbData, dbConfig, storageData] = ['db-data', 'db-config', 'storage-data'].map(
    (name) => `${PROJECT}_${name}`,
  );
  const removeVolumes = (...names: string[]) => {
    const removed = docker(['volume', 'rm', ...names]);
    if (removed.status !== 0) fail(`docker volume rm ${names.join(' ')}: ${removed.stderr.trim()}`);
  };
  const said = (run: Run, pattern: RegExp) =>
    lines(`${run.stdout}\n${run.stderr}`).find((line) => pattern.test(line)) ?? tail(run.stderr, 1);

  // With db running, recover-db must not start a second server on db's files.
  const db = containerOf('db') ?? fail('db has no container');
  const since = daemonNow();
  let run: Run & { took: number; peakMib: number; statsMib: number } = await recover();
  const refusal = /bare-postgres: .*not shut down cleanly.*/.exec(recoverDbLog())?.[0] ?? '';
  dropRecoverDb();
  const dbHealth = docker(['inspect', '--format', '{{.State.Health.Status}}', db]).stdout.trim();
  const dbWrote = logsSince(db, since);
  checks.expect(
    `recover with db still running: exit ${run.status}, recover-db refused at once ("${refusal}"); db ${dbHealth}, ${dbWrote.length} lines in its log since`,
    run.status !== 0 && refusal !== '' && dbHealth === 'healthy' && !dbWrote.length,
    `${run.stdout}${run.stderr}\n${recoverDbLog()}\n${dbWrote.join('\n')}`,
  );

  // The disaster: everything stops, db shut down cleanly with its cluster still on db-data. The
  // cluster's WAL, shipped until the backup service stopped, stays under its own identifier.
  const oldCluster = clusterId();
  compose([
    'stop',
    'backup',
    'web',
    'scheduler',
    'api-gw',
    'auth',
    'rest',
    'realtime',
    'storage',
    'db',
  ]);
  const oldWal = walNames(oldCluster);
  run = await recover();
  dropRecoverDb();
  checks.expect(
    `recover onto db's own cluster, db stopped: exit ${run.status}, "${said(run, /^restore: .*not a bare cluster/)}"`,
    run.status === 1 && /is not a bare cluster/.test(`${run.stdout}${run.stderr}`),
    `${run.stdout}${run.stderr}`,
  );
  // The backup service goes with them: it mounts storage-data and the WAL spool.
  compose(['rm', '--force', 'db', 'storage', 'backup']);
  removeVolumes(dbData, dbConfig);
  run = await recover();
  dropRecoverDb();
  checks.expect(
    `recover onto new db volumes with Storage's old files still there: exit ${run.status}, "${said(run, /^restore: \/storage is not empty/)}"`,
    run.status === 1 && /\/storage is not empty/.test(`${run.stdout}${run.stderr}`),
    `${run.stdout}${run.stderr}`,
  );

  // A new server's volumes: all three new, and the WAL spool, which held the old cluster's WAL
  // (VPS-43). A recovery without RESTORE_STAMP refuses to run at all, as it would take the newest
  // name in the bucket (review finding F4); a night whose Storage archive holds a link is refused
  // before the roles. So the same volumes stay as they were and take the real night next.
  removeVolumes(dbData, dbConfig, storageData, `${PROJECT}_wal-spool`);
  run = await measured(
    `${PROJECT}-recover-${process.pid}`,
    ['-T', '-e', 'RESTORE_STAMP=', ...age, 'recover'],
    'recover',
  );
  dropRecoverDb();
  checks.expect(
    `recover without RESTORE_STAMP, into the new volumes: exit ${run.status}, "${tail(run.stdout, 1)}", and nothing else`,
    run.status === 1 &&
      run.stdout ===
        "restore: a recovery needs RESTORE_STAMP, the id of the night to recover as the backup's own records name it (docs/RUNBOOK.md, Disaster recovery): it never takes the newest name in the bucket\n",
    `${run.stdout}${run.stderr}`,
  );
  run = await recover([], linked);
  dropRecoverDb();
  checks.expect(
    `recover of a planted night whose Storage archive holds a link (${linked}), into the new volumes: exit ${run.status}, "${said(run, /links or special files/)}", and no roles step`,
    run.status === 1 &&
      sealedThenLink(linked, 'recover-db').test(run.stdout) &&
      !/^restore: roles$/m.test(`${run.stdout}${run.stderr}`),
    `${run.stdout}${run.stderr}`,
  );
  run = await recover(['-e', 'RESTORE_EXACT=1']);
  const recoverDb = cgroupMemory('recover-db', 'recover', true);
  dropRecoverDb();
  checks.expect(
    `recover from monthly/ into new db-data, db-config and storage-data (RESTORE_EXACT=1): exit ${run.status} in ${usage(run, 'recover')}; recover-db at most ${recoverDb?.peak ?? '?'} MiB of its ${value('recover-db', 'mem_limit')}. ${lines(
      run.stdout,
    )
      .filter((line) => line.startsWith('restore:') && !line.startsWith('restore: the night'))
      .join(' / ')}; "${said(run, /^recovery of /).split(':')[0]}"`,
    run.status === 0 &&
      run.stdout.includes(`restore: the night of ${night}, from monthly/, into recover-db\n`) &&
      /^restore: postgres has its \d+ tables as the manifest counted them$/m.test(run.stdout) &&
      /^restore: Storage holds \d+ files as the manifest counted$/m.test(run.stdout) &&
      /^recovery of \S+ done/m.test(run.stdout),
    tail(`${run.stdout}${run.stderr}`),
  );
  if (run.status !== 0) {
    fail('The recovery failed. pnpm vps:rehearse --fresh starts the rehearsal over.');
  }

  // db on them as `up -d db` starts it: the image finds a cluster and skips its init.
  let started = Date.now();
  const up = compose(['up', '-d', '--wait', '--wait-timeout', '180', 'db']);
  const dbLog = logsOf(containerOf('db') ?? '');
  checks.expect(
    `db started on the recovered volumes in ${seconds(started)} s: "${/[^\n]*Skipping initialization/.exec(dbLog)?.[0].trim() ?? 'no "Skipping initialization"'}"`,
    up.status === 0 && /Skipping initialization/.test(dbLog),
    tail(`${up.stderr}\n${dbLog}`),
  );
  compareRestore(checks, 'the recovered db', source, fingerprint('db'));
  const recovered = storageFiles('storage-data');
  const types = [
    ...new Set(files.map((line) => /user\.supabase\.content-type=(\S+)/.exec(line)?.[1])),
  ].filter((type): type is string => type !== undefined);
  checks.expect(
    `storage-data recovered: ${fileTotals(recovered)}, each with the source's bytes, sha256 and user.* xattrs (content types ${types.join(', ')})`,
    recovered.join('\n') === files.join('\n'),
    [
      ...files
        .filter((line) => !recovered.includes(line))
        .map((line) => `not as in the source: ${line}`),
      ...recovered.filter((line) => !files.includes(line)).map((line) => `only recovered: ${line}`),
    ].join('\n'),
  );
  // What app-deploy runs first: the migrations, which the restored history makes a no-op.
  const migrate = compose(['run', '--rm', '--no-deps', '-T', 'migrate']);
  const migrated = lines(migrate.stdout).filter((line) => line.startsWith('migrate:'));
  checks.expect(
    `migrate on the recovered db, as app-deploy runs it: exit ${migrate.status}, "${migrated.at(-1)}"`,
    migrate.status === 0 && /nothing to apply/.test(migrated.join('\n')),
    tail(`${migrate.stdout}${migrate.stderr}`),
  );

  // The rest of the stack, then the app's data through the gateway.
  started = Date.now();
  const services = ['auth', 'rest', 'realtime', 'storage', 'api-gw'];
  const rest = compose(['up', '-d', '--wait', '--wait-timeout', '180', ...services]);
  if (rest.status !== 0) fail(`The Supabase services did not turn healthy:\n${tail(rest.stderr)}`);
  const apps = compose(['up', '-d', '--no-deps', 'web', 'scheduler']);
  if (apps.status !== 0) fail(`web and the scheduler did not start:\n${tail(apps.stderr)}`);
  const [web, scheduler] = await Promise.all([
    waitHealthy('web', 180, started),
    waitHealthy('scheduler', 180, started),
  ]);
  checks.ok(
    `${services.join(', ')}, then web and the scheduler, healthy on the recovered data (web in ${web} s, scheduler in ${scheduler} s)`,
  );
  const through = await ownerThroughGateway(env);
  checks.expect(`through 127.0.0.1:8300: ${through.said}`, through.ok, through.detail);
  // One object of each content type, downloaded the server's way: its type, cache control and
  // bytes. Then a new upload next to one, and its removal: the recovered files are Storage's own.
  const objects = types.map((type) => {
    const line = files.find((file) => file.includes(`content-type=${type}`)) ?? '';
    const [path, bytes, sum] = line.split(' ');
    const [, , bucket, ...name] = path.split('/');
    return {
      bucket,
      name: name.slice(0, -1).join('/'),
      bytes: Number(bytes),
      sum,
      type,
      cache: /cache-control=(\S+)/.exec(line)?.[1],
    };
  });
  const fetched = inWeb<
    { status: number; type: string; cache: string; sum: string; put: number; gone: number }[]
  >(
    [
      "const { createHash } = await import('node:crypto');",
      'const out = [];',
      'const path = (bucket, name) => [bucket, ...name.split("/")].map(encodeURIComponent).join("/");',
      'for (const { bucket, name, type } of input) {',
      "  const res = await fetch(gw + '/storage/v1/object/' + path(bucket, name), { headers: { apikey: key } });",
      '  const body = Buffer.from(await res.arrayBuffer());',
      "  const copy = path(bucket, name.replace(/[^/]*$/, 'rehearsal-recovered-' + Date.now() + '$&'));",
      "  const put = await fetch(gw + '/storage/v1/object/' + copy, { method: 'POST', headers: { apikey: key, 'Content-Type': type }, body });",
      "  const gone = await fetch(gw + '/storage/v1/object/' + copy, { method: 'DELETE', headers: { apikey: key } });",
      "  out.push({ status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), sum: createHash('sha256').update(body).digest('hex'), put: put.status, gone: gone.status });",
      '}',
      'console.log(JSON.stringify(out));',
    ].join('\n'),
    objects.map(({ bucket, name, type }) => ({ bucket, name, type })),
  );
  checks.expect(
    `recovered objects through http://api-gw:8000: ${fetched.map((got) => `${got.status} ${got.type}, ${got.cache}`).join('; ')}, the source's bytes; a new upload beside each ${fetched.map((got) => got.put).join(', ')}, removed ${fetched.map((got) => got.gone).join(', ')}`,
    fetched.length === objects.length &&
      fetched.length > 0 &&
      fetched.every(
        (got, n) =>
          got.status === 200 &&
          got.type === objects[n].type &&
          got.cache === objects[n].cache &&
          got.sum === objects[n].sum &&
          got.put === 200 &&
          got.gone === 200,
      ),
    JSON.stringify(fetched),
  );
  vault(checks, 'db');

  // The backup service again, on a new WAL spool. The recovered cluster is a new one, made by
  // recover-db's initdb: its WAL goes under its own identifier, and the old cluster's stays as it
  // was, never mixed with it (VPS-43).
  const backup = compose(['up', '-d', 'backup']);
  if (backup.status !== 0)
    fail(`backup did not start on the recovered stack:\n${tail(backup.stderr)}`);
  const newCluster = clusterId();
  const walfile = writeWal();
  const shipped = await walShipped(newCluster, [walfile], 200);
  const oldNow = walNames(oldCluster);
  checks.expect(
    `the backup service on the recovered cluster and a new spool: a new system identifier (${newCluster}; the old one ${oldCluster}), its WAL under wal/${newCluster}/ (${walfile} within ${shipped.took} s); the old cluster's ${oldNow.length} objects as they were`,
    newCluster !== oldCluster &&
      shipped.found.every((name) => name !== undefined) &&
      oldWal.length > 0 &&
      oldNow.join('\n') === oldWal.join('\n'),
    `${shipped.names.join('\n')}\nold: ${oldNow.length} of ${oldWal.length}`,
  );
}

// --- point-in-time recovery (VPS-43), on the recovered rehearsal ---

/** counts.sql, as backup.sh, restore.sh and pitr.sh run it, in the rehearsal's db: its lines, sorted. */
const dbCounts = () => dbSql(read('backup', 'counts.sql')).sort();

/**
 * What pitr.sh --test printed of the rows at the point, as counts.sql's lines ("table
 * <schema>.<table> <rows>", "migration <version>"), sorted: the database's name and the night's
 * column left out, and a table not there at the point not counted.
 */
const pitrCounts = (output: string) =>
  lines(output)
    .flatMap((line) => {
      const row =
        /^ {2}(table|migration) postgres( \S+)?: \S+ at the night, (\S+) at the point$/.exec(line);
      return row && row[3] !== 'none' ? [`${row[1]}${row[2] ?? ''} ${row[3]}`] : [];
    })
    .sort();

/** A badly signed WAL object's signature: 64 random bytes, as base64url, as a planter could make. */
const badSignature = () => randomBytes(64).toString('base64url');

/**
 * Point-in-time recovery (VPS-43) on the rehearsal, which recovery() left running on a cluster of
 * its own with the backup service shipping its WAL. A night of that cluster first, with its base
 * backup; then the drill: rows A, a time T, rows B and a dropped table, with web and the scheduler
 * stopped so that nothing else writes, and the WAL shipped. Under the name of the WAL file that
 * rows B go to, and in the history folder, objects someone else could plant (age's encryption,
 * not the backup's signature) go up first. pitr-test to T holds A, not B, and the table, row for
 * row as the source held them at T; to latest it holds B and not the table, its last transaction
 * the drill's own; with a byte of the real WAL file of rows B changed, the drill fails, saying the
 * chain is cut there and the backup's WAL goes on after it. Then recover-pitr refuses db's own
 * db-data and a run without PITR_TARGET, and, into a new db-data and a new wal-spool (db-config and
 * storage-data stay, as on a rewind of the server), recovers to T: db starts on it, its counts are
 * the source's at T, the stack and a sign-in work, and db archives the new timeline's history file,
 * which the shipper signs into wal/<cluster>/history/.
 */
async function pitrProof(checks: Checks, env: Record<string, string>, age: string[]) {
  const cluster = clusterId();
  // A night of this cluster, as backup.sh makes one: its base starts after the recovery.
  const out = join(MIRROR, 'backup-out');
  for (const old of readdirSync(out)) rmSync(join(out, old), { force: true });
  const stamp = stampOf(daemonNow());
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
  const nightRun = await measured(`${PROJECT}-backup-${process.pid}`, [
    '--no-deps',
    '-T',
    'backup',
    '/usr/local/bin/backup.sh',
  ]);
  const night = /^backup (\S+): /m.exec(nightRun.stdout)?.[1] ?? '';
  const sealed = sealOf(
    nightsInBucket([['daily', night]]).get(`daily ${night}`)?.seal ?? '',
    night,
  );
  const base = typeof sealed === 'string' ? undefined : sealed.base;
  checks.expect(
    `a night of the recovered cluster for point-in-time recovery: backup.sh exit ${nightRun.status} in ${nightRun.took} s, ${night || 'no night'}, its seal's base line "${base ? `${base.end} ${base.walfile} ${base.cluster}` : 'none'}"`,
    nightRun.status === 0 && NIGHT_ID.test(night) && base?.cluster === cluster,
    `${nightRun.stdout}${nightRun.stderr}`,
  );

  // The drill's writes, with nothing else writing: rows A, then the WAL switched, so that rows B
  // go to the next WAL file, whose name the planted object takes; T; rows B; the table dropped.
  compose(['stop', 'web', 'scheduler']);
  let restarted = false;
  const restart = () => {
    if (!restarted) compose(['up', '-d', '--no-deps', 'web', 'scheduler']);
    restarted = true;
  };
  try {
    dbSql(
      [
        'drop table if exists public.rehearsal_pitr_rows, public.rehearsal_pitr_dropped;',
        'create table public.rehearsal_pitr_rows (n int);',
        'create table public.rehearsal_pitr_dropped (n int);',
        'insert into public.rehearsal_pitr_dropped values (1), (2);',
        'insert into public.rehearsal_pitr_rows select generate_series(1, 3);',
      ].join('\n'),
    );
    const atT = dbCounts();
    const pending =
      dbSql(
        'select pg_switch_wal() is not null;\nselect pg_walfile_name(pg_current_wal_lsn());',
      ).at(-1) ?? '';
    const plantedSegment = `wal/${cluster}/${pending.slice(8, 16)}/${pending}.${badSignature()}.zst.age`;
    const plantedHistory = `wal/${cluster}/history/00000009.history.${badSignature()}.zst.age`;
    const planted = inBackup(
      [
        'set -e',
        'head -c 16777216 /dev/zero | zstd -3 -q -c | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" >/tmp/segment',
        `rclone copyto /tmp/segment "backups:$BACKUP_BUCKET/${plantedSegment}"`,
        String.raw`printf '1\t0/1000000\tno recovery target specified\n' | zstd -3 -q -c | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" >/tmp/history`,
        `rclone copyto /tmp/history "backups:$BACKUP_BUCKET/${plantedHistory}"`,
      ].join('\n'),
    );
    if (planted.status !== 0) fail(`Planting WAL objects failed: ${planted.stderr.trim()}`);
    const said = dbSql(
      [
        'select pg_sleep(1.2);',
        `select 'T ' || to_char((date_trunc('second', clock_timestamp()) + interval '1 second') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');`,
        'select pg_sleep(2.5);',
        'insert into public.rehearsal_pitr_rows select generate_series(4, 10);',
        "select 'B ' || pg_walfile_name(pg_current_wal_lsn());",
        'select pg_switch_wal() is not null;',
        'drop table public.rehearsal_pitr_dropped;',
        "select 'D ' || pg_walfile_name(pg_current_wal_lsn()) || ' ' || to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"');",
        'select pg_switch_wal() is not null;',
      ].join('\n'),
    );
    const of = (label: string) =>
      said.find((line) => line.startsWith(`${label} `))?.slice(label.length + 1) ?? '';
    const point = of('T');
    const [dropped, droppedAt] = of('D').split(' ');
    if (of('B') !== pending || !point || !dropped) {
      fail(`The drill's writes did not land as planned: ${said.join(' / ')}; pending ${pending}`);
    }
    // The shipper's next runs: rows B's WAL file beside the planted one, and the drop's.
    const started = Date.now();
    let names: string[] = [];
    for (;;) {
      names = walNames(cluster);
      const has = (walfile: string) =>
        names.filter((name) => walObject(name)?.walfile === walfile).length;
      if ((has(pending) >= 2 && has(dropped) >= 1) || seconds(started) >= 240) break;
      await sleep(5000);
    }
    const pendingObjects = names.filter((name) => walObject(name)?.walfile === pending);
    const signedOnes = walContents(pendingObjects).map(({ path, sha256 }) => {
      const parts = walObject(path);
      return parts
        ? signedBy(
            env.BACKUP_SIGNING_PUBLIC_KEY,
            walMessage(parts.cluster, parts.walfile, sha256),
            parts.signature,
          )
        : false;
    });
    const realPending = pendingObjects[signedOnes.indexOf(true)] ?? '';
    checks.expect(
      `the drill: rows A in rehearsal_pitr_rows, T ${point}, rows B in ${pending}, rehearsal_pitr_dropped dropped in ${dropped} at ${droppedAt}, web and the scheduler stopped; ${seconds(started)} s later the bucket holds ${pendingObjects.length} objects named ${pending}, of which Node's crypto takes ${signedOnes.filter(Boolean).length} as the backup's (one planted first, encrypted to the owner's key but signed by none), and ${dropped}`,
      pendingObjects.length === 2 &&
        signedOnes.filter(Boolean).length === 1 &&
        pendingObjects.includes(plantedSegment) &&
        realPending !== plantedSegment &&
        names.some((name) => walObject(name)?.walfile === dropped),
      names.slice(-8).join('\n'),
    );

    // The drill as the server runs it: pitr-test, measured, its tmpfs's use read as it runs.
    const drill = async (target: string) => {
      const name = `${PROJECT}-pitr-test-${process.pid}`;
      let tmpfsKib = 0;
      const run = await measured(
        name,
        ['-T', '-e', `PITR_TARGET=${target}`, ...age, 'pitr-test'],
        'pitr-test',
        () => {
          const df = docker(['exec', name, 'df', '-Pk', '/var/lib/postgresql/data']);
          const used = Number(lines(df.stdout)[1]?.split(/\s+/)[2]);
          if (Number.isFinite(used)) tmpfsKib = Math.max(tmpfsKib, used);
        },
      );
      return { ...run, tmpfsMib: Math.round(tmpfsKib / 1024) };
    };
    const kept = (output: string) =>
      /^pitr: the WAL after it, from wal\/\d+\/: (\d+) WAL files and (\d+) timeline histories checked and kept \((\d+) bytes\), through \S+; (\d+) objects passed over, not the backup's$/m.exec(
        output,
      );
    const toT = await drill(point);
    const keptT = kept(toT.stdout);
    const countsT = pitrCounts(toT.stdout);
    checks.expect(
      `pitr-test to T (${point}): exit ${toT.status} in ${usage(toT, 'pitr-test')}, its tmpfs at most ${toT.tmpfsMib} MiB of 1g; from the night ${night}, ${keptT?.[1] ?? '?'} WAL files and ${keptT?.[2] ?? '?'} history files kept, ${keptT?.[4] ?? '?'} objects passed over; "${lines(toT.stdout).find((line) => line.startsWith('pitr: | recovery stopping')) ?? ''}"; rows A and the table there (${countsT.find((line) => line.startsWith('table public.rehearsal_pitr_rows ')) ?? 'no rows'}, ${countsT.find((line) => line.startsWith('table public.rehearsal_pitr_dropped ')) ?? 'no table'}), and all ${countsT.length} counts the source's at T`,
      toT.status === 0 &&
        toT.stdout.includes(`pitr: to ${point}, from the night of ${night}: `) &&
        Number(keptT?.[4]) >= 2 &&
        countsT.includes('table public.rehearsal_pitr_rows 3') &&
        countsT.includes('table public.rehearsal_pitr_dropped 2') &&
        countsT.join('\n') === atT.join('\n') &&
        toT.stdout.endsWith(
          `pitr test passed: the night of ${night} and the WAL after it, replayed to ${point}${/, its last transaction at \S+\n$/.exec(toT.stdout)?.[0] ?? '\n'}`,
        ),
      `${tail(toT.stdout, 40)}\n${toT.stderr}\nsource at T:\n${atT.join('\n')}`,
    );
    const latest = await drill('latest');
    const keptLatest = kept(latest.stdout);
    const countsLatest = pitrCounts(latest.stdout);
    const lastAt = /, its last transaction at (\S+)\n$/.exec(latest.stdout)?.[1] ?? '';
    checks.expect(
      `pitr-test to latest: exit ${latest.status} in ${usage(latest, 'pitr-test')}, its tmpfs at most ${latest.tmpfsMib} MiB; ${keptLatest?.[1] ?? '?'} WAL files kept, ${keptLatest?.[4] ?? '?'} passed over; rows B there and not the table (${countsLatest.find((line) => line.startsWith('table public.rehearsal_pitr_rows ')) ?? 'no rows'}, ${countsLatest.some((line) => line.includes('rehearsal_pitr_dropped')) ? 'the table' : 'no table'}), its last transaction at ${lastAt || '?'}, the drop's ${droppedAt}`,
      latest.status === 0 &&
        Number(keptLatest?.[4]) >= 2 &&
        countsLatest.includes('table public.rehearsal_pitr_rows 10') &&
        !countsLatest.some((line) => line.includes('rehearsal_pitr_dropped')) &&
        lastAt !== '' &&
        Date.parse(lastAt) >= Date.parse(droppedAt) - 1000,
      `${tail(latest.stdout, 40)}\n${latest.stderr}`,
    );

    // A byte changed in the real WAL file of rows B: no object of that name is the backup's now.
    const original = inBackup(
      `rclone cat --no-traverse "backups:$BACKUP_BUCKET/${realPending}" | base64 -w 0`,
    ).stdout.trim();
    const flipped = inBackup(
      [
        'set -e',
        `rclone cat --no-traverse "backups:$BACKUP_BUCKET/${realPending}" >/tmp/part`,
        'at=$(($(wc -c </tmp/part) / 2))',
        'byte=$(od -An -tu1 -j"$at" -N1 /tmp/part | tr -d " ")',
        `printf "$(printf '\\\\%03o' "$(( (byte + 1) % 256 ))")" | dd of=/tmp/part bs=1 seek="$at" conv=notrunc 2>/dev/null`,
        `rclone copyto /tmp/part "backups:$BACKUP_BUCKET/${realPending}"`,
      ].join('\n'),
    );
    if (flipped.status !== 0 || !original) {
      fail(`Changing a byte of ${realPending} failed: ${flipped.stderr.trim()}`);
    }
    const cut = await drill('latest');
    const cutLine =
      lines(cut.stdout).find((line) => line.startsWith('pitr: the chain of WAL files is cut at')) ??
      '';
    checks.expect(
      `pitr-test to latest with a byte of ${pending}'s object changed: exit ${cut.status}, "${cutLine}", then "${tail(cut.stdout, 1)}"`,
      cut.status === 1 &&
        cutLine ===
          `pitr: the chain of WAL files is cut at ${pending}: none of the 2 objects in the bucket named ${pending} is the backup's (their signatures do not check out): someone else wrote to the bucket. The backup's WAL goes on after it, from ${dropped}, and the replay can't reach past the cut` &&
        cut.stdout.endsWith(
          `pitr: the chain of WAL files is cut at ${pending}, with the backup's WAL after it: the drill fails\n`,
        ),
      `${tail(cut.stdout, 40)}\n${cut.stderr}`,
    );
    const put = inBackup(
      `base64 -d | rclone rcat "backups:$BACKUP_BUCKET/${realPending}" && rclone cat --no-traverse "backups:$BACKUP_BUCKET/${realPending}" | base64 -w 0`,
      original,
    );
    if (put.status !== 0 || put.stdout.trim() !== original) {
      fail(`Putting ${realPending} back failed: ${put.stderr.trim()}`);
    }

    // recover-pitr refuses db's own db-data, and a run without the point.
    const recoverPitr = (target: string) =>
      measured(
        `${PROJECT}-recover-pitr-${process.pid}`,
        ['-T', '-e', `PITR_TARGET=${target}`, ...age, 'recover-pitr'],
        'recover',
      );
    let run = await recoverPitr(point);
    checks.expect(
      `recover-pitr with db running on db-data: exit ${run.status}, "${tail(run.stdout, 1)}", and nothing else`,
      run.status === 1 &&
        run.stdout ===
          'pitr: /var/lib/postgresql/data, the db-data volume, is not empty: recover only into a new db-data volume (docs/RUNBOOK.md, Disaster recovery)\n',
      `${run.stdout}${run.stderr}`,
    );
    run = await recoverPitr('');
    checks.expect(
      `recover-pitr without PITR_TARGET: exit ${run.status}, "${tail(run.stdout, 1)}", and nothing else`,
      run.status === 1 &&
        run.stdout ===
          'pitr: a recovery needs PITR_TARGET, the point to recover to: a time with its offset, like 2026-11-15T14:30:00+05:30, or latest (docs/RUNBOOK.md, Disaster recovery)\n',
      `${run.stdout}${run.stderr}`,
    );

    // The rewind: everything stops, db-data and wal-spool go, and the recovery to T fills a new
    // db-data. db-config and storage-data stay, as on the server.
    compose([
      'stop',
      'backup',
      'web',
      'scheduler',
      'api-gw',
      'auth',
      'rest',
      'realtime',
      'storage',
      'db',
    ]);
    compose(['rm', '--force', 'db', 'backup']);
    const removed = docker(['volume', 'rm', `${PROJECT}_db-data`, `${PROJECT}_wal-spool`]);
    if (removed.status !== 0) fail(`docker volume rm: ${removed.stderr.trim()}`);
    run = await recoverPitr(point);
    const timeline = /^pitr: the cluster \d+ stopped cleanly in \S+ on timeline (\d+)/m.exec(
      run.stdout,
    )?.[1];
    checks.expect(
      `recover-pitr to T into a new db-data: exit ${run.status} in ${usage(run, 'recover-pitr')}; "${lines(run.stdout).find((line) => line.startsWith('pitr: the cluster ')) ?? ''}"`,
      run.status === 0 &&
        run.stdout.includes(`pitr: to ${point}, from the night of ${night}: `) &&
        timeline !== undefined &&
        run.stdout.endsWith(
          `point-in-time recovery to ${point} done: start db with a new wal-spool (its entrypoint gives the files to its own postgres, uid 100, and it archives the new timeline), then auth, rest, realtime, storage, api-gw, web, scheduler and backup (docs/RUNBOOK.md)\n`,
        ),
      `${tail(run.stdout, 40)}\n${run.stderr}`,
    );
    if (run.status !== 0)
      fail('The recovery to T failed. pnpm vps:rehearse --fresh starts the rehearsal over.');
    let since = Date.now();
    const up = compose(['up', '-d', '--wait', '--wait-timeout', '180', 'db']);
    const dbLog = logsOf(containerOf('db') ?? '');
    const [identity, onTimeline] = (
      dbSql(
        "select case when system_identifier < 0 then (system_identifier::numeric + 18446744073709551616)::text else system_identifier::text end || ' ' || (select timeline_id from pg_control_checkpoint()) from pg_control_system()",
      )[0] ?? ''
    ).split(' ');
    const recovered = dbCounts();
    checks.expect(
      `db started on the recovered db-data in ${seconds(since)} s ("${/[^\n]*Skipping initialization/.exec(dbLog)?.[0].trim() ?? 'no "Skipping initialization"'}"): the cluster ${identity}, on timeline ${onTimeline}; its ${recovered.length} counts the source's at T (rehearsal_pitr_rows ${recovered.find((line) => line.startsWith('table public.rehearsal_pitr_rows '))?.split(' ')[2] ?? '?'} rows)`,
      up.status === 0 &&
        /Skipping initialization/.test(dbLog) &&
        identity === cluster &&
        onTimeline === timeline &&
        recovered.join('\n') === atT.join('\n'),
      `${tail(`${up.stderr}\n${dbLog}`)}\n${recovered.filter((line) => !atT.includes(line)).join('\n')}`,
    );
    since = Date.now();
    const rest = compose([
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '180',
      'auth',
      'rest',
      'realtime',
      'storage',
      'api-gw',
    ]);
    if (rest.status !== 0)
      fail(`The Supabase services did not turn healthy:\n${tail(rest.stderr)}`);
    restart();
    const [web, scheduler] = await Promise.all([
      waitHealthy('web', 180, since),
      waitHealthy('scheduler', 180, since),
    ]);
    const through = await ownerThroughGateway(env);
    checks.expect(
      `the stack on the cluster recovered to T (web in ${web} s, scheduler in ${scheduler} s), through 127.0.0.1:8300: ${through.said}`,
      through.ok,
      through.detail,
    );

    // The backup service on a new wal-spool: db archived the new timeline's history file, which
    // the shipper signs and sends to the cluster's history folder.
    const backup = compose(['up', '-d', 'backup']);
    if (backup.status !== 0) fail(`backup did not start:\n${tail(backup.stderr)}`);
    const history = `${Number(timeline).toString(16).toUpperCase().padStart(8, '0')}.history`;
    const shipped = await walShipped(cluster, [history], 200);
    const historyObject = shipped.found[0] ?? '';
    // Its signature with Node's crypto, and its text, decrypted: the timeline it branched from, and
    // where, before the first transaction past T.
    const [sum, ...text] = lines(
      compose([
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '--volume',
        `${slash(join(MIRROR, 'age'))}:/run/age:ro`,
        '--entrypoint',
        'sh',
        'backup',
        '-c',
        `rclone cat --no-traverse "backups:$BACKUP_BUCKET/${historyObject}" >/tmp/object && sha256sum </tmp/object | cut -d ' ' -f 1 && age --decrypt --identity /run/age/identity.txt </tmp/object | zstd -dcq`,
      ]).stdout,
    );
    const parts = walObject(historyObject);
    const branched = /^(\d+)\t([0-9A-F]+\/[0-9A-F]+)\tbefore (\S+ \S+)$/.exec(text.at(-1) ?? '');
    const branchedAt = Date.parse((branched?.[3] ?? '').replace(' ', 'T').replace(/\+00$/, 'Z'));
    checks.expect(
      `after db's start the new timeline's ${history} is under wal/${cluster}/history/ within ${shipped.took} s, signed by the backup's key (Node's crypto), and says: timeline ${Number(timeline)} branched from ${branched?.[1] ?? '?'} at ${branched?.[2] ?? '?'}, before ${branched?.[3] ?? '?'}, past T`,
      parts !== undefined &&
        signedBy(
          env.BACKUP_SIGNING_PUBLIC_KEY,
          walMessage(parts.cluster, parts.walfile, sum ?? ''),
          parts.signature,
        ) &&
        branched !== null &&
        Number(branched[1]) < Number(timeline) &&
        branchedAt > Date.parse(point),
      `${shipped.names.filter((name) => name.includes('/history/')).join('\n')}\n${text.join('\n')}`,
    );

    // The next drill, on the rewound cluster: a row on the new timeline, its WAL shipped, and the
    // replay from the same night follows the history file from the old timeline to the new.
    const [onNew] = dbSql(
      'insert into public.rehearsal_pitr_rows values (100);\nselect pg_walfile_name(pg_current_wal_lsn());\nselect pg_switch_wal() is not null;',
    );
    const newShipped = await walShipped(cluster, [onNew ?? ''], 200);
    const across = await drill('latest');
    const countsAcross = pitrCounts(across.stdout);
    const promoted = /the cluster promoted to timeline (\d+)/.exec(across.stdout)?.[1];
    checks.expect(
      `pitr-test to latest after the rewind, from the same night: exit ${across.status} in ${across.took} s, the new timeline's row in ${onNew} shipped within ${newShipped.took} s; rows A and the row on timeline ${Number(timeline)}, and the table (${countsAcross.find((line) => line.startsWith('table public.rehearsal_pitr_rows ')) ?? 'no rows'}, ${countsAcross.find((line) => line.startsWith('table public.rehearsal_pitr_dropped ')) ?? 'no table'}), promoted to timeline ${promoted ?? '?'}`,
      across.status === 0 &&
        across.stdout.includes(`from the night of ${night}: `) &&
        countsAcross.includes('table public.rehearsal_pitr_rows 4') &&
        countsAcross.includes('table public.rehearsal_pitr_dropped 2') &&
        Number(promoted) > Number(timeline),
      `${tail(across.stdout, 40)}\n${across.stderr}`,
    );
    // The new timeline's history file removed, as someone holding the token could: the replay
    // would follow the old timeline past the point, so the drill refuses before it replays.
    const saved = inBackup(
      `rclone cat --no-traverse "backups:$BACKUP_BUCKET/${historyObject}" | base64 -w 0 && rclone deletefile "backups:$BACKUP_BUCKET/${historyObject}"`,
    ).stdout.trim();
    if (!saved) fail(`Removing ${historyObject} failed`);
    for (let tries = 0; tries < 20; tries++) {
      if (!walNames(cluster).includes(historyObject)) break;
      await sleep(1000);
    }
    const orphaned = await drill('latest');
    const back = inBackup(
      `base64 -d | rclone rcat "backups:$BACKUP_BUCKET/${historyObject}" && rclone cat --no-traverse "backups:$BACKUP_BUCKET/${historyObject}" | base64 -w 0`,
      saved,
    );
    if (back.status !== 0 || back.stdout.trim() !== saved) {
      fail(`Putting ${historyObject} back failed: ${back.stderr.trim()}`);
    }
    const tl = history.slice(0, 8);
    checks.expect(
      `pitr-test to latest with ${history} removed from the bucket: exit ${orphaned.status}, "${tail(orphaned.stdout, 1)}", and nothing replayed`,
      orphaned.status === 1 &&
        !orphaned.stdout.includes('pitr: replaying') &&
        orphaned.stdout.endsWith(
          `pitr: the backup's WAL of the timelines ${tl} is in the bucket, but not those timelines' history files: someone else removed them, and the replay would follow an older timeline, so nothing was replayed\n`,
        ),
      `${tail(orphaned.stdout, 40)}\n${orphaned.stderr}`,
    );

    // What the drill planted goes.
    const cleared = inBackup(
      `rclone deletefile "backups:$BACKUP_BUCKET/${plantedSegment}" && rclone deletefile "backups:$BACKUP_BUCKET/${plantedHistory}"`,
    );
    if (cleared.status !== 0)
      fail(`Removing the planted WAL objects failed: ${cleared.stderr.trim()}`);
  } finally {
    restart();
  }
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
