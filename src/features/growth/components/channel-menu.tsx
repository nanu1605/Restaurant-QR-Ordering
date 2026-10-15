'use client';

import {
  ACQUISITION_CHANNEL_LABELS,
  ACQUISITION_CHANNELS,
  type AcquisitionChannel,
} from '@/features/platform/platform';
import { ChoiceMenu } from '@/features/support/components/request-controls';

import { setAcquisitionChannel } from '../actions';

const UNKNOWN = 'unknown';

/** "Found us", set by the team (docs/DECISIONS.md SA-59); saved and audited when chosen. */
export function ChannelMenu({
  restaurantId,
  channel,
}: {
  restaurantId: string;
  channel: AcquisitionChannel | null;
}) {
  return (
    <ChoiceMenu
      label="Found us"
      value={channel ?? UNKNOWN}
      options={[
        ...ACQUISITION_CHANNELS.map((value): [string, string] => [
          value,
          ACQUISITION_CHANNEL_LABELS[value],
        ]),
        [UNKNOWN, 'Not known'],
      ]}
      onChoose={(next) => setAcquisitionChannel(restaurantId, next === UNKNOWN ? null : next)}
    />
  );
}
