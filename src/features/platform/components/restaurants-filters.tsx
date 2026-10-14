import Form from 'next/form';
import Link from 'next/link';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import type { RestaurantFilters } from '../params';
import type { TeamMember } from '../restaurant-page';
import {
  ACQUISITION_CHANNEL_LABELS,
  ACQUISITION_CHANNELS,
  HEALTH_LABELS,
  HEALTHS,
  ONBOARDING_FILTER_LABELS,
  ONBOARDING_FILTERS,
  RESTAURANT_COLUMN_LABELS,
  RESTAURANT_COLUMNS,
  SUBSCRIPTION_STATE_LABELS,
  SUBSCRIPTION_STATES,
  type RestaurantColumn,
  type Tag,
} from '../platform';

const PATH = '/super/restaurants';

const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm';
const LABEL_CLASS = 'flex flex-col gap-1 text-sm font-medium text-ink';

type RestaurantsFiltersProps = {
  filters: RestaurantFilters;
  columns: RestaurantColumn[];
  /** Whether lifetime paid can be chosen (money.view). */
  money: boolean;
  cities: string[];
  regions: string[];
  plans: { code: string; name: string }[];
  tags: Tag[];
  team: TeamMember[];
};

/**
 * Search, filters and columns for the restaurants list (docs/DECISIONS.md
 * SA-23); everything lives in the URL, so a view can be shared or saved.
 */
export function RestaurantsFilters({
  filters,
  columns,
  money,
  cities,
  regions,
  plans,
  tags,
  team,
}: RestaurantsFiltersProps) {
  const select = (
    name: keyof RestaurantFilters,
    label: string,
    any: string,
    options: [string, string][],
  ) => (
    <label className={LABEL_CLASS}>
      {label}
      <select name={name} defaultValue={String(filters[name] ?? '')} className={SELECT_CLASS}>
        <option value="">{any}</option>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  const date = (name: keyof RestaurantFilters, label: string) => (
    <label className={LABEL_CLASS}>
      {label}
      <Input
        type="date"
        name={name}
        defaultValue={String(filters[name] ?? '')}
        className="h-11 md:h-9"
      />
    </label>
  );

  return (
    <Form
      key={JSON.stringify([filters, columns])}
      action={PATH}
      role="search"
      aria-label="Restaurants"
      className="grid gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6"
    >
      {filters.sort && <input type="hidden" name="sort" value={filters.sort} />}
      {filters.dir && <input type="hidden" name="dir" value={filters.dir} />}
      <label className={`${LABEL_CLASS} sm:col-span-2`}>
        Search
        <Input
          type="search"
          name="q"
          defaultValue={filters.q}
          placeholder="Name, code or city"
          className="h-11 md:h-9"
        />
      </label>
      {select(
        'state',
        'State',
        'Any state',
        SUBSCRIPTION_STATES.map((state) => [state, SUBSCRIPTION_STATE_LABELS[state]]),
      )}
      {select(
        'plan',
        'Plan',
        'Any plan',
        plans.map((plan) => [plan.code, plan.name]),
      )}
      {select(
        'health',
        'Health',
        'Any health',
        HEALTHS.map((health) => [health, HEALTH_LABELS[health]]),
      )}
      {select(
        'onboarding',
        'Onboarding',
        'Any',
        ONBOARDING_FILTERS.map((value) => [value, ONBOARDING_FILTER_LABELS[value]]),
      )}
      {select('channel', 'Found us', 'Any way', [
        ...ACQUISITION_CHANNELS.map((c): [string, string] => [c, ACQUISITION_CHANNEL_LABELS[c]]),
        ['unknown', 'Not known'],
      ])}
      {select(
        'city',
        'City',
        'Any city',
        cities.map((city) => [city, city]),
      )}
      {select(
        'region',
        'Indian state',
        'Anywhere',
        regions.map((region) => [region, region]),
      )}
      {select(
        'tag',
        'Tag',
        'Any tag',
        tags.map((tag) => [tag.id, tag.name]),
      )}
      {select('manager', 'Account manager', 'Anyone', [
        ['me', 'Me'],
        ['none', 'No one'],
        ...team.map((member): [string, string] => [member.user_id, member.email]),
      ])}
      {date('from', 'Created from')}
      {date('to', 'Created to')}
      {date('paid_from', 'Paid till from')}
      {date('paid_to', 'Paid till to')}
      <details className="sm:col-span-2 lg:col-span-4 xl:col-span-6">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-ink md:min-h-9">
          Columns
        </summary>
        <fieldset className="mt-2 grid gap-x-4 sm:grid-cols-3 lg:grid-cols-6">
          <legend className="sr-only">Columns to show</legend>
          {RESTAURANT_COLUMNS.filter((column) => money || column !== 'lifetime').map((column) => (
            <label
              key={column}
              className="flex min-h-11 items-center gap-2 text-sm text-ink md:min-h-8"
            >
              <input
                type="checkbox"
                name="cols"
                value={column}
                defaultChecked={columns.includes(column)}
                className="size-4 accent-brand"
              />
              {RESTAURANT_COLUMN_LABELS[column]}
            </label>
          ))}
        </fieldset>
      </details>
      <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4 xl:col-span-6">
        <Button type="submit" size="touch">
          Apply
        </Button>
        <Link href={PATH} className={buttonVariants({ variant: 'ghost', size: 'touch' })}>
          Clear
        </Link>
      </div>
    </Form>
  );
}
