// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveSettings } from '@/features/settings/actions';
import { SettingsTabs } from '@/features/settings/components/settings-tabs';
import type { RestaurantSettings } from '@/features/settings/queries';
import { actionOk } from '@/lib/action-result';

vi.mock('@/features/settings/actions', () => ({
  saveSettings: vi.fn(),
  uploadLogo: vi.fn(),
  removeLogo: vi.fn(),
}));

const SETTINGS: RestaurantSettings = {
  id: 'r1',
  name: 'Spice Route',
  slug: 'spice-route',
  legal_name: null,
  address_line: null,
  city: null,
  state: null,
  pincode: null,
  phone: null,
  email: null,
  logo_path: null,
  accent_color: '#c2410c',
  gstin: null,
  fssai_license: null,
  gst_mode: 'regular',
  gst_rate_bps: 500,
  prices_include_tax: false,
  service_charge_enabled: false,
  service_charge_bps: 0,
  invoice_prefix: 'INV',
  bill_footer_text: null,
  paper_width: '80mm',
  show_upi_qr_on_bill: false,
  upi_vpa: null,
  upi_payee_name: null,
  require_first_order_approval: true,
  customer_cancel_window_seconds: 120,
  max_tables_per_waiter: 6,
  staff_can_remove_served_items: false,
  print_waiter_on_bill: true,
  reopen_window_minutes: 30,
  business_day_start_hour: 4,
  timezone: 'Asia/Kolkata',
  updated_at: '2026-09-19T10:00:00.000Z',
};

function renderTabs(settings: RestaurantSettings) {
  return (
    <SettingsTabs
      settings={settings}
      supabaseUrl="http://127.0.0.1:54321"
      canShowUpiQr
      upgradeHint="Available on Growth"
      readOnly={false}
    />
  );
}

beforeEach(() => {
  vi.mocked(saveSettings).mockResolvedValue(actionOk());
});

// The refresh after a save lands a moment after the action returns (spec §13.3
// Settings: tabs save separately).
describe('SettingsTabs after a refresh', () => {
  it('keeps what is being typed in another tab', () => {
    const { rerender } = render(renderTabs(SETTINGS));
    fireEvent.click(screen.getByRole('tab', { name: 'Ordering' }));
    const cancelWindow = screen.getByLabelText('Customer cancel window');
    fireEvent.change(cancelWindow, { target: { value: '700' } });

    // A Bill save refreshes the page.
    rerender(
      renderTabs({ ...SETTINGS, invoice_prefix: 'SR', updated_at: '2026-09-19T10:00:05.000Z' }),
    );

    expect(screen.getByLabelText('Customer cancel window')).toHaveValue(700);
  });

  it('shows the stored values of the saved tab and keeps edits made since', async () => {
    const { rerender } = render(renderTabs(SETTINGS));
    fireEvent.click(screen.getByRole('tab', { name: 'Tax & charges' }));
    const panel = screen.getByRole('tabpanel', { name: 'Tax & charges' });
    fireEvent.change(within(panel).getByLabelText('GSTIN'), {
      target: { value: '23aaacd1234e1z5' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(saveSettings).toHaveBeenCalledWith(
      'tax',
      expect.objectContaining({ gstin: '23AAACD1234E1Z5' }),
    );

    // Typed after the save, before the refresh lands.
    fireEvent.change(within(panel).getByLabelText(/FSSAI/), {
      target: { value: '12345678901234' },
    });
    rerender(
      renderTabs({ ...SETTINGS, gstin: '23AAACD1234E1Z5', updated_at: '2026-09-19T10:00:05.000Z' }),
    );

    expect(screen.getByLabelText('GSTIN')).toHaveValue('23AAACD1234E1Z5');
    expect(screen.getByLabelText(/FSSAI/)).toHaveValue('12345678901234');
  });
});
