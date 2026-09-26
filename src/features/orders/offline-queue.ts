import { z } from 'zod';

import { forwardStatusSchema } from './schemas';

/**
 * Dish status moves made without a network (spec §19 Phase 9,
 * docs/DECISIONS.md P9-5). TanStack Query holds them until the network is
 * back; this journal in localStorage keeps them through a reload or a closed
 * tab, per member, for a day. Replaying is safe: a move is a no-op once the
 * dish is there.
 */

const changeSchema = z.union([
  z.object({ key: z.string(), ids: z.array(z.string()), status: forwardStatusSchema }),
  z.object({ key: z.string(), orderId: z.string() }),
]);

/** Dishes moved forward, or a round marked served. `key` is unique per tap. */
export type StatusChange = z.infer<typeof changeSchema>;

const entriesSchema = z.array(z.object({ change: changeSchema, at: z.number() }));
type Entry = z.infer<typeof entriesSchema>[number];

export const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

const storageKey = (memberId: string) => `tableorder:queue:${memberId}`;

function read(memberId: string, now: number): Entry[] {
  try {
    const raw = window.localStorage.getItem(storageKey(memberId));
    const parsed = entriesSchema.safeParse(raw ? JSON.parse(raw) : []);
    return parsed.success ? parsed.data.filter((entry) => now - entry.at < QUEUE_TTL_MS) : [];
  } catch {
    return [];
  }
}

function write(memberId: string, entries: Entry[]) {
  try {
    if (entries.length === 0) window.localStorage.removeItem(storageKey(memberId));
    else window.localStorage.setItem(storageKey(memberId), JSON.stringify(entries));
  } catch {
    // Private mode or full storage: the change still waits in memory.
  }
}

/** Keeps a change until it reaches the server (a replayed one keeps its place). */
export function saveChange(memberId: string, change: StatusChange, now = Date.now()) {
  const entries = read(memberId, now);
  if (entries.some((entry) => entry.change.key === change.key)) return;
  write(memberId, [...entries, { change, at: now }]);
}

export function dropChange(memberId: string, key: string, now = Date.now()) {
  write(
    memberId,
    read(memberId, now).filter((entry) => entry.change.key !== key),
  );
}

/** The member's changes that never reached the server, oldest first. */
export function savedChanges(memberId: string, now = Date.now()): StatusChange[] {
  return read(memberId, now).map((entry) => entry.change);
}
