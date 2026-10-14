'use client';

import dynamic from 'next/dynamic';

import { Skeleton } from '@/components/ui/skeleton';

// Loaded after the page (docs/SUPER_ADMIN_PLAN.md 12e): recharts isn't part of
// the panel's first load, and charts draw only in the browser.
const loading = () => <Skeleton className="h-56 w-full" />;

export const MrrChart = dynamic(() => import('./home-chart-views').then((m) => m.MrrChart), {
  ssr: false,
  loading,
});
export const UsageChart = dynamic(() => import('./home-chart-views').then((m) => m.UsageChart), {
  ssr: false,
  loading,
});
export const NewRestaurantsChart = dynamic(
  () => import('./home-chart-views').then((m) => m.NewRestaurantsChart),
  { ssr: false, loading },
);
