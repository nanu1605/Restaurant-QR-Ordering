import { EyeOff } from 'lucide-react';

import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Money } from '@/components/shared/money';
import { ScrollRegion } from '@/components/shared/scroll-region';
import { Badge } from '@/components/ui/badge';

import { formatDateTime, type SupportMenu, type SupportTables } from '../platform';

/**
 * Read-only pieces of the super-admin support view (spec §13.4,
 * docs/DECISIONS.md P7-6). Nothing here changes anything.
 */

export function SupportMenuList({ menu }: { menu: SupportMenu }) {
  if (menu.categories.length === 0) {
    return <p className="text-sm text-ink-muted">No categories yet.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {menu.categories.map((category) => (
        <section
          key={category.id}
          aria-label={category.name}
          className="rounded-lg border border-line bg-surface"
        >
          <h3 className="flex items-center gap-2 border-b border-line px-3 py-2 text-base font-semibold text-ink">
            {category.name}
            {!category.is_active && <HiddenBadge />}
            <span className="text-sm font-normal text-ink-muted">
              {category.items.length} {category.items.length === 1 ? 'dish' : 'dishes'}
            </span>
          </h3>
          {category.items.length === 0 ? (
            <p className="px-3 py-2 text-sm text-ink-muted">No dishes.</p>
          ) : (
            <ul className="divide-y divide-line">
              {category.items.map((item) => (
                <li key={item.id} className="flex flex-wrap items-start gap-3 px-3 py-2">
                  <FoodTypeMark type={item.food_type} size="sm" className="mt-1" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex flex-wrap items-center gap-2 font-medium text-ink">
                      {item.name}
                      {!item.is_active && <HiddenBadge />}
                      {item.is_active && !item.is_available && (
                        <Badge variant="outline">Out of stock</Badge>
                      )}
                    </span>
                    {item.description && (
                      <span className="text-sm text-ink-muted">{item.description}</span>
                    )}
                  </div>
                  <span className="text-sm text-ink">
                    {item.variants.length === 0 ? (
                      <Money paise={item.price_paise} fraction="auto" />
                    ) : (
                      item.variants.map((variant, index) => (
                        <span key={variant.name}>
                          {index > 0 && ' · '}
                          {variant.name} <Money paise={variant.price_paise} fraction="auto" />
                        </span>
                      ))
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function HiddenBadge() {
  return (
    <Badge variant="outline">
      <EyeOff aria-hidden />
      Hidden
    </Badge>
  );
}

export function SupportTablesList({ tables }: { tables: SupportTables }) {
  if (tables.tables.length === 0) {
    return <p className="text-sm text-ink-muted">No tables yet.</p>;
  }
  return (
    <ScrollRegion label="Tables" className="rounded-lg border border-line bg-surface">
      <table className="w-full text-left text-sm text-ink">
        <caption className="sr-only">Tables</caption>
        <thead className="border-b border-line text-ink-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Table
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Guests since
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {tables.tables.map((table) => (
            <tr key={table.id}>
              <td className="px-3 py-2 font-medium">{table.label}</td>
              <td className="px-3 py-2">
                {!table.is_active ? 'Switched off' : table.opened_at ? 'Occupied' : 'Free'}
              </td>
              <td className="px-3 py-2 tabular-nums">
                {table.opened_at ? formatDateTime(table.opened_at) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
