'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import type { RestaurantSettings } from '../queries';

import { BillForm, OrderingForm, RestaurantForm, TaxForm } from './settings-forms';

type SettingsTabsProps = {
  settings: RestaurantSettings;
  supabaseUrl: string;
  canShowUpiQr: boolean;
  upgradeHint: string;
  readOnly: boolean;
};

/** Settings tabs (spec §13.3): each tab saves on its own. */
export function SettingsTabs({
  settings,
  supabaseUrl,
  canShowUpiQr,
  upgradeHint,
  readOnly,
}: SettingsTabsProps) {
  // Forms remount after a save so they show the stored (normalised) values,
  // e.g. the GSTIN in capitals; the selected tab stays put.
  const version = settings.updated_at;
  return (
    <Tabs defaultValue="restaurant" className="gap-4">
      <TabsList className="h-10 w-full max-w-xl">
        <TabsTrigger value="restaurant">Restaurant</TabsTrigger>
        <TabsTrigger value="tax">Tax &amp; charges</TabsTrigger>
        <TabsTrigger value="bill">Bill</TabsTrigger>
        <TabsTrigger value="ordering">Ordering</TabsTrigger>
      </TabsList>
      <div className="rounded-lg border border-line bg-surface p-4 md:p-6">
        <TabsContent value="restaurant">
          <RestaurantForm
            key={version}
            settings={settings}
            readOnly={readOnly}
            supabaseUrl={supabaseUrl}
          />
        </TabsContent>
        <TabsContent value="tax">
          <TaxForm key={version} settings={settings} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="bill">
          <BillForm
            key={version}
            settings={settings}
            readOnly={readOnly}
            canShowUpiQr={canShowUpiQr}
            upgradeHint={upgradeHint}
          />
        </TabsContent>
        <TabsContent value="ordering">
          <OrderingForm key={version} settings={settings} readOnly={readOnly} />
        </TabsContent>
      </div>
    </Tabs>
  );
}
