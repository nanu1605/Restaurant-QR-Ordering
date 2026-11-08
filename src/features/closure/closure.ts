import { z } from 'zod';

/**
 * Closing an account (docs/SUPER_ADMIN_PLAN.md 14e, docs/DECISIONS.md SA-93+):
 * what the forms send and the pages read.
 */

export const closeAccountSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Say why, for the audit log.')
    .max(300, 'Use 300 characters or fewer.'),
  code: z.string().trim().min(1, 'Type the restaurant code.').max(40, 'That isn’t its code.'),
});
export type CloseAccountInput = z.input<typeof closeAccountSchema>;

const closureSchema = z
  .object({
    closed_at: z.string(),
    closed_by: z.string().nullable(),
    reason: z.string().nullable(),
    removal_due_at: z.string(),
    removed_at: z.string().nullable(),
  })
  .nullable();
export type Closure = NonNullable<z.infer<typeof closureSchema>>;
export const parseClosure = (json: unknown) => closureSchema.parse(json);

const exportRowSchema = z
  .object({
    status: z.enum(['building', 'ready', 'failed']),
    path: z.string(),
    size_bytes: z.number().nullable(),
    created_at: z.string(),
    expires_at: z.string().nullable(),
  })
  .nullable();
export const parseExportRow = (json: unknown) => exportRowSchema.parse(json);

/** An export the server may build, from restaurant_export_claim (docs/DECISIONS.md VPS-26). */
const exportClaimSchema = z
  .object({ export_id: z.uuid(), restaurant_id: z.uuid(), claim_id: z.uuid() })
  .transform((claim) => ({
    exportId: claim.export_id,
    restaurantId: claim.restaurant_id,
    claimId: claim.claim_id,
  }))
  .nullable();
export type ExportClaim = NonNullable<z.infer<typeof exportClaimSchema>>;
export const parseExportClaim = (json: unknown) => exportClaimSchema.parse(json);

/** What a page shows of the latest export; its file's path stays on the server. */
export type DataExport =
  | { state: 'none' | 'building' | 'failed' | 'expired' }
  | { state: 'ready'; url: string; size: string; until: string; secondsLeft: number };
