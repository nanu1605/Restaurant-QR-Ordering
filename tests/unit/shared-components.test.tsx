// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Money } from '@/components/shared/money';
import { StatusChip } from '@/components/shared/status-chip';
import { ORDER_ITEM_STATUSES, ORDER_ITEM_STATUS_LABELS } from '@/lib/order-status';

describe('StatusChip', () => {
  it.each(ORDER_ITEM_STATUSES)('shows a text label and icon for %s', (status) => {
    const { container } = render(<StatusChip status={status} />);
    const chip = screen.getByText(ORDER_ITEM_STATUS_LABELS[status]);
    expect(chip).toHaveAttribute('data-status', status);
    // Colour is never the only signal: an icon is always present.
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('FoodTypeMark', () => {
  it('is labelled for screen readers', () => {
    render(<FoodTypeMark type="non_veg" />);
    expect(screen.getByRole('img', { name: 'Non-vegetarian' })).toBeInTheDocument();
  });
});

describe('Money', () => {
  it('renders paise as rupees with tabular digits', () => {
    render(<Money paise={66200} />);
    const amount = screen.getByText('₹662.00');
    expect(amount).toHaveClass('tabular-nums');
  });
});
