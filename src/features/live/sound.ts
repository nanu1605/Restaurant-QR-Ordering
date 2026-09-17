'use client';

import { useSyncExternalStore } from 'react';

/**
 * New-order chime (spec §12). Browsers block audio until the user interacts,
 * so the header offers "Enable sound" once per device and remembers the choice
 * in localStorage. The chime is synthesised with Web Audio: no sound file.
 */

const STORAGE_KEY = 'tableorder:sound';
const listeners = new Set<() => void>();
let context: AudioContext | null = null;

export type SoundSetting = 'on' | 'off' | null;

function readSetting(): SoundSetting {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'on' || value === 'off' ? value : null;
  } catch {
    return null;
  }
}

const readEnabled = () => readSetting() === 'on';

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => event.key === STORAGE_KEY && onChange();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/** This device's choice: null until it has chosen (then "Enable sound" shows). */
export function useSoundSetting(): SoundSetting {
  return useSyncExternalStore(subscribe, readSetting, () => null);
}

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return null;
  context ??= new window.AudioContext();
  return context;
}

/** Call from a click or tap: browsers only start audio from a user gesture. */
export function setSoundEnabled(enabled: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Private mode: the choice lasts until the page closes.
  }
  if (enabled) void audioContext()?.resume();
  for (const listener of listeners) listener();
}

// After a reload (or when a tablet locks) the audio context is suspended. Any
// later tap or key press wakes it: browsers only allow that from events that
// count as a user gesture (click, touchend, keydown — not a touch pointerdown),
// and the listeners stay, so a failed or later suspension is retried.
if (typeof window !== 'undefined') {
  const wake = () => {
    if (!readEnabled()) return;
    const ctx = audioContext();
    if (ctx && ctx.state !== 'running') void ctx.resume();
  };
  for (const type of ['click', 'touchend', 'keydown'] as const) {
    window.addEventListener(type, wake, { capture: true, passive: true });
  }
}

/** Two short rising notes. Silent unless sound is on and audio is unlocked. */
export function playChime() {
  if (!readEnabled()) return;
  const ctx = audioContext();
  if (!ctx || ctx.state !== 'running') return;
  const start = ctx.currentTime;
  [880, 1320].forEach((frequency, index) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const at = start + index * 0.18;
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.17);
  });
}
