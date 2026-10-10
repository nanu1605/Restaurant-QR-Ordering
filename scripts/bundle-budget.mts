/**
 * First-load JavaScript per page, gzipped, against a ceiling per area (docs/DECISIONS.md W-14).
 * Reads the stats `next build` writes with Turbopack, so run it after a build:
 *
 *   pnpm budget
 *
 * Fails when a page is over. Raise a ceiling only on purpose, with a note in W-14.
 */
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

// KiB, about 8% above each area's largest page at W4c (gzip, as below).
const BUDGETS: [area: RegExp, kib: number][] = [
  [/^\/t\//, 275], // the customer menu, on diners' phones: 247-252
  [/^\/(admin|staff|super)(\/|$)/, 565], // the panels: up to 520
  [/./, 325], // the website, login and not-found: 221-297
];

type Row = { route: string; firstLoadChunkPaths: string[] };

const rows: Row[] = JSON.parse(readFileSync('.next/diagnostics/route-bundle-stats.json', 'utf8'));
if (!rows.length) throw new Error('No pages in route-bundle-stats.json');

const gzipped = new Map<string, number>();
function size(path: string) {
  let bytes = gzipped.get(path);
  if (bytes === undefined) {
    bytes = gzipSync(readFileSync(path)).length;
    gzipped.set(path, bytes);
  }
  return bytes;
}

let over = 0;
for (const { route, firstLoadChunkPaths } of rows.sort((a, b) => a.route.localeCompare(b.route))) {
  const kib = firstLoadChunkPaths.reduce((sum, path) => sum + size(path), 0) / 1024;
  const budget = BUDGETS.find(([area]) => area.test(route))![1];
  if (kib > budget) over++;
  console.log(
    `${kib > budget ? '✗' : '✓'} ${route.padEnd(60)} ${kib.toFixed(0).padStart(4)} / ${budget} KiB`,
  );
}
if (over) {
  console.error(`${over} page(s) over the first-load JavaScript budget (docs/DECISIONS.md W-14).`);
  process.exit(1);
}
