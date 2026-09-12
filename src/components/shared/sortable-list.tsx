'use client';

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from 'cn';
import { GripVertical } from 'lucide-react';
import { useId, type ComponentProps, type ReactNode } from 'react';

/**
 * Drag-and-drop list (spec §4: @dnd-kit) for menu categories, dishes and
 * tables. Works with a pointer and with the keyboard: focus a handle, press
 * Space, move with the arrow keys, press Space again to drop.
 */
export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  getLabel,
  disabled,
  className,
  children,
}: {
  items: T[];
  onReorder: (next: T[]) => void;
  /** Name read out to screen readers while moving, e.g. the dish name. */
  getLabel: (item: T) => string;
  disabled?: boolean;
  className?: string;
  children: (item: T) => ReactNode;
}) {
  const id = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const label = (itemId: UniqueIdentifier | undefined) => {
    const item = items.find((candidate) => candidate.id === itemId);
    return item ? getLabel(item) : 'Item';
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${label(active.id)}.`,
    // Over itself fires right after pick-up too; keep "Picked up …" then.
    onDragOver: ({ active, over }) =>
      over && over.id !== active.id ? `${label(active.id)} is over ${label(over.id)}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over && over.id !== active.id
        ? `${label(active.id)} moved to where ${label(over.id)} was.`
        : `${label(active.id)} dropped in its place.`,
    onDragCancel: ({ active }) => `Moving ${label(active.id)} was cancelled.`,
  };

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((item) => item.id === active.id);
    const to = items.findIndex((item) => item.id === over.id);
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(items, from, to));
  }

  return (
    // A stable id keeps the accessibility ids identical on server and client.
    <DndContext
      id={id}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            'To move, press Space or Enter, use the arrow keys, then press Space or Enter again to drop. Press Escape to cancel.',
        },
      }}
    >
      <SortableContext
        items={items.map((item) => item.id)}
        strategy={verticalListSortingStrategy}
        disabled={disabled}
      >
        <ul className={cn('flex flex-col gap-1', className)}>{items.map(children)}</ul>
      </SortableContext>
    </DndContext>
  );
}

export type DragHandleProps = ComponentProps<'button'>;

/** A list row that can be dragged by its handle. */
export function SortableItem({
  id,
  disabled,
  className,
  children,
}: {
  id: string;
  disabled?: boolean;
  className?: string;
  children: (handle: DragHandleProps) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(className, isDragging && 'relative z-10 shadow-md')}
    >
      {children({ ref: setActivatorNodeRef, ...attributes, ...listeners } as DragHandleProps)}
    </li>
  );
}

export function DragHandle({
  label,
  handle,
  disabled,
}: {
  label: string;
  handle: DragHandleProps;
  disabled?: boolean;
}) {
  if (disabled) return <span aria-hidden className="w-7 shrink-0" />;
  return (
    <button
      type="button"
      aria-label={label}
      {...handle}
      className="flex h-9 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-ink-muted hover:bg-muted hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing"
    >
      <GripVertical aria-hidden className="size-4" />
    </button>
  );
}
