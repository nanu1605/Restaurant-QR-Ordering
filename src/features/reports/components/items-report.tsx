import { CookingPot } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { Money } from '@/components/shared/money';
import { FoodTypeMark } from '@/components/shared/food-type-mark';

import type { ItemsReport } from '../report';
import { CategoryChart, type CategoryPoint } from './category-chart';
import { ScrollRegion } from '@/components/shared/scroll-region';

/** Dish and category sales (spec §19 Phase 6 item-wise and category sales). */
export function ItemsReportView({ report }: { report: ItemsReport }) {
  if (report.items.length === 0) {
    return (
      <EmptyState
        icon={CookingPot}
        title="No dishes billed"
        description="Bills in this range have no dishes yet. Try a wider range."
      />
    );
  }

  const points: CategoryPoint[] = report.categories.map((category) => ({
    name: category.name ?? 'Without a category',
    revenuePaise: category.revenuePaise,
    qty: category.qty,
  }));

  return (
    <>
      <section aria-labelledby="categories-heading" className="flex min-w-0 flex-col gap-2">
        <h2 id="categories-heading" className="text-base font-semibold text-ink">
          Categories
        </h2>
        <CategoryChart points={points} />
        <details className="text-base text-ink">
          <summary className="cursor-pointer text-sm text-ink-muted">Show the numbers</summary>
          <table className="mt-2 w-full border-collapse text-base">
            <caption className="sr-only">Sales per category</caption>
            <thead>
              <tr className="border-b border-line text-left text-sm text-ink-muted">
                <th scope="col" className="py-2 font-medium">
                  Category
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Dishes
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Quantity
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Sales
                </th>
              </tr>
            </thead>
            <tbody>
              {report.categories.map((category) => (
                <tr key={category.categoryId ?? 'none'} className="border-b border-line">
                  <th scope="row" className="py-2 text-left font-normal">
                    {category.name ?? 'Without a category'}
                  </th>
                  <td className="py-2 text-right tabular-nums">{category.dishes}</td>
                  <td className="py-2 text-right tabular-nums">{category.qty}</td>
                  <td className="py-2 text-right">
                    <Money paise={category.revenuePaise} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      <section aria-labelledby="dishes-heading" className="flex min-w-0 flex-col gap-2">
        <h2 id="dishes-heading" className="text-base font-semibold text-ink">
          Dishes
        </h2>
        <p className="text-sm text-ink-muted">
          Quantities and sales at menu prices, before any discount on the bill.
        </p>
        <ScrollRegion label="Dishes">
          <table className="w-full border-collapse text-base">
            <thead>
              <tr className="border-b border-line text-left text-sm text-ink-muted">
                <th scope="col" className="py-2 font-medium">
                  Dish
                </th>
                <th scope="col" className="py-2 font-medium">
                  Category
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Quantity
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Sales
                </th>
              </tr>
            </thead>
            <tbody>
              {report.items.map((item) => (
                <tr
                  key={`${item.menuItemId}-${item.variantId ?? 'plain'}`}
                  className="border-b border-line"
                >
                  <th scope="row" className="py-2 text-left font-normal text-ink">
                    <span className="flex items-center gap-2">
                      {item.foodType && <FoodTypeMark type={item.foodType} size="sm" />}
                      {item.name}
                      {item.variant && <span className="text-ink-muted">· {item.variant}</span>}
                    </span>
                  </th>
                  <td className="py-2 text-ink-muted">{item.category ?? '—'}</td>
                  <td className="py-2 text-right text-ink tabular-nums">{item.qty}</td>
                  <td className="py-2 text-right text-ink">
                    <Money paise={item.revenuePaise} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </section>
    </>
  );
}
