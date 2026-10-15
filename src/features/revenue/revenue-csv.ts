import { paiseToRupees, type CsvTable } from '@/features/reports/csv';

import { MOVEMENT_LABELS, MOVEMENTS, type RevenueReport } from './revenue';

/**
 * The Revenue page's period table as a CSV (docs/DECISIONS.md SA-27): one row
 * per day, week or month, rupees before GST unless named, empty before MRR
 * history starts.
 */
export function revenueCsv(report: RevenueReport): CsvTable {
  return {
    headers: [
      'First day',
      'Last day',
      'MRR at the end',
      'Paid restaurants at the end',
      ...MOVEMENTS.flatMap((kind) => [MOVEMENT_LABELS[kind], `${MOVEMENT_LABELS[kind]} MRR`]),
      'Net new MRR',
      'Subscriptions collected',
      'Setup fees collected',
      'GST collected',
    ],
    rows: report.series.map((point) => {
      const history = point.mrr_paise !== null;
      const net = MOVEMENTS.reduce((sum, kind) => sum + point.movements[kind].paise, 0);
      return [
        point.start,
        point.end,
        history ? paiseToRupees(point.mrr_paise!) : null,
        point.paid,
        ...MOVEMENTS.flatMap((kind) =>
          history
            ? [point.movements[kind].count, paiseToRupees(point.movements[kind].paise)]
            : [null, null],
        ),
        history ? paiseToRupees(net) : null,
        paiseToRupees(point.subscription_base_paise),
        paiseToRupees(point.setup_fee_base_paise),
        paiseToRupees(point.gst_paise),
      ];
    }),
  };
}
