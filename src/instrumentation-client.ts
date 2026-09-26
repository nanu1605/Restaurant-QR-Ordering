// Zod compiles fast parsers with `new Function`. The pages' policy forbids
// eval, and even Zod's caught probe for it reports a violation
// (docs/DECISIONS.md P9-9), so parse without it in the browser. Zod keeps its
// settings in this global (the same object whether it loads before or after
// this file); importing Zod here would put it on every page.
const holder = globalThis as { __zod_globalConfig?: Record<string, unknown> };
(holder.__zod_globalConfig ??= {}).jitless = true;
