import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { NoteForm, NoteItem } from '@/features/platform/components/notes';
import { Section } from '@/features/platform/components/restaurant-sections';
import { getRestaurantDetail, listNotes } from '@/features/platform/queries';
import { hasPlatformPermission, requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Notes',
};

/**
 * The team's notes on a restaurant (docs/SUPER_ADMIN_PLAN.md 13a,
 * docs/DECISIONS.md SA-38): pinned ones first, then the newest.
 */
export default async function RestaurantNotesPage({
  params,
}: PageProps<'/super/restaurants/[restaurantId]/notes'>) {
  await requirePlatformPermission('restaurants.view');
  const { restaurantId } = await params;
  const detail = await getRestaurantDetail(restaurantId);
  if (!detail) notFound();
  const [notes, manage] = await Promise.all([
    listNotes(restaurantId),
    hasPlatformPermission('restaurants.manage'),
  ]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Section title="Notes">
        {notes.length === 0 ? (
          <p className="text-sm text-ink-muted">No notes yet.</p>
        ) : (
          <ul className="-mx-3 -my-2 flex flex-col divide-y divide-line">
            {notes.map((note) => (
              <NoteItem key={note.id} note={note} canManage={manage} />
            ))}
          </ul>
        )}
        {notes.length === 200 && (
          <p className="text-xs text-ink-muted">The newest 200 notes are shown.</p>
        )}
      </Section>
      {manage && (
        <Section title="Add a note">
          <NoteForm restaurantId={restaurantId} />
        </Section>
      )}
    </div>
  );
}
