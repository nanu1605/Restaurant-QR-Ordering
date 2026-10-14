import { describe, expect, it } from 'vitest';

import { cancelReasonSchema } from '@/features/subscriptions/cancel-reasons';

// Why an owner turned autopay off (docs/DECISIONS.md SA-15).
describe('cancelReasonSchema', () => {
  it('needs one of the listed reasons', () => {
    expect(cancelReasonSchema.safeParse({ reason: 'closing', detail: '' }).success).toBe(true);
    expect(cancelReasonSchema.safeParse({ reason: 'bored', detail: '' }).success).toBe(false);
  });

  it('asks for a few words with "Other"', () => {
    const result = cancelReasonSchema.safeParse({ reason: 'other', detail: '  ' });
    expect(result.error?.issues[0]?.path).toEqual(['detail']);
    expect(cancelReasonSchema.safeParse({ reason: 'other', detail: 'Seasonal' }).success).toBe(
      true,
    );
  });
});
