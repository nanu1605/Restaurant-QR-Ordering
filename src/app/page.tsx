import { StatusChip } from '@/components/shared/status-chip';
import { APP_NAME } from '@/lib/config';
import { ACTIVE_ITEM_STATUSES } from '@/lib/order-status';

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center gap-6 px-6 py-16">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold text-ink">{APP_NAME}</h1>
        <p className="text-base text-ink-muted">
          Customers scan the QR code on their table and order from their phone. Staff see every dish
          live, from the kitchen to the table, and the bill is one tap away.
        </p>
      </div>
      <ul aria-label="Dish progress" className="flex flex-wrap items-center gap-2">
        {ACTIVE_ITEM_STATUSES.map((status) => (
          <li key={status}>
            <StatusChip status={status} />
          </li>
        ))}
      </ul>
    </main>
  );
}
