import 'server-only';

import { createClient } from '@/lib/supabase/server';

import { type Board, fetchBoard } from './board';

/** The live board for the first render; the browser keeps it fresh afterwards. */
export async function getBoard(): Promise<Board> {
  return fetchBoard(await createClient());
}
