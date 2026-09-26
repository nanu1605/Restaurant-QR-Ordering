import { z } from 'zod';

// Zod compiles fast parsers with `new Function`. The pages' policy forbids
// eval, and even Zod's caught probe for it reports a violation
// (docs/DECISIONS.md P9-9), so parse without it in the browser.
z.config({ jitless: true });
