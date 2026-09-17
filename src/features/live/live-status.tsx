'use client';

import { Volume2, VolumeX } from 'lucide-react';

import { ConnectionIndicator } from '@/components/shared/connection-indicator';
import { Button } from '@/components/ui/button';
import { useHydrated } from '@/hooks/use-hydrated';

import { useLive } from './live-provider';
import { setSoundEnabled, useSoundSetting } from './sound';

/** Header controls on live screens (spec §12, §13.2): connection and sound. */
export function LiveStatus() {
  const { connection } = useLive();
  return (
    <div className="flex items-center gap-2">
      <ConnectionIndicator state={connection} />
      <SoundToggle />
    </div>
  );
}

/** "Enable sound" until this device chooses; then a small on/off toggle. */
function SoundToggle() {
  const hydrated = useHydrated();
  const setting = useSoundSetting();
  if (!hydrated) return null;

  if (setting === null) {
    return (
      <Button variant="outline" size="lg" onClick={() => setSoundEnabled(true)}>
        <Volume2 aria-hidden />
        {/* Icon only on phones, where the header is tight. */}
        <span className="sr-only sm:not-sr-only">Enable sound</span>
      </Button>
    );
  }
  const on = setting === 'on';
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      onClick={() => setSoundEnabled(!on)}
      aria-pressed={on}
      aria-label="New order sound"
      title={on ? 'New order sound is on' : 'New order sound is off'}
    >
      {on ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}
    </Button>
  );
}
