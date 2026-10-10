// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Money, withRupee } from '@/components/shared/money';
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
    const { container } = render(<Money paise={66200} />);
    const amount = container.firstElementChild;
    expect(amount).toHaveTextContent('₹662.00');
    expect(amount).toHaveClass('tabular-nums');
  });

  it('draws the ₹ in the system font, so the extra Noto files never load', () => {
    render(<Money paise={-150} signDisplay="exceptZero" />);
    expect(screen.getByText('₹')).toHaveClass('[font-family:system-ui,sans-serif]');
    const { container } = render(<p>{withRupee('2 items · ₹1,040 and ₹5')}</p>);
    expect(container).toHaveTextContent('2 items · ₹1,040 and ₹5');
    expect(container.querySelectorAll('span')).toHaveLength(2);
    expect(withRupee('no rupees')).toBe('no rupees');
  });
});
