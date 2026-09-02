'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export const CURSOR_STORAGE_KEY = 'day0-cursor';
export const CURSOR_CHANGE_EVENT = 'day0-cursor-change';

export type CursorPreference = 'off' | 'on';

type CursorPreferenceTarget = Pick<Window, 'dispatchEvent' | 'localStorage'>;

export function readCursorPreference(storage: Pick<Storage, 'getItem'>): CursorPreference {
  return storage.getItem(CURSOR_STORAGE_KEY) === 'off' ? 'off' : 'on';
}

export function setCursorPreference(
  preference: CursorPreference,
  target: CursorPreferenceTarget = window,
): void {
  target.localStorage.setItem(CURSOR_STORAGE_KEY, preference);
  target.dispatchEvent(new CustomEvent(CURSOR_CHANGE_EVENT, { detail: preference }));
}

export function toggleCursorPreference(target: CursorPreferenceTarget = window): void {
  const current = readCursorPreference(target.localStorage);
  setCursorPreference(current === 'on' ? 'off' : 'on', target);
}

export function handleCursorShortcut(
  event: Pick<
    KeyboardEvent,
    'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'preventDefault' | 'repeat' | 'shiftKey'
  >,
  target: CursorPreferenceTarget = window,
): boolean {
  if (
    event.repeat ||
    !event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.key.toLowerCase() !== 'c'
  ) {
    return false;
  }

  event.preventDefault();
  toggleCursorPreference(target);
  return true;
}

export function useCursorPreference({ keyboardShortcut = false } = {}): CursorPreference | null {
  const [preference, setPreference] = useState<CursorPreference | null>(null);

  useEffect(() => {
    const syncPreference = () => setPreference(readCursorPreference(window.localStorage));
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === CURSOR_STORAGE_KEY) syncPreference();
    };

    syncPreference();
    window.addEventListener('storage', onStorage);
    window.addEventListener(CURSOR_CHANGE_EVENT, syncPreference);

    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(CURSOR_CHANGE_EVENT, syncPreference);
    };
  }, []);

  useEffect(() => {
    if (!keyboardShortcut) return;

    const onKeyDown = (event: KeyboardEvent) => handleCursorShortcut(event);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [keyboardShortcut]);

  return preference;
}

export function CursorToggle() {
  const preference = useCursorPreference();
  const [headerControls, setHeaderControls] = useState<Element | null>(null);
  const isOn = preference !== 'off';

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setHeaderControls(document.querySelector('header > div:last-child'));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  if (!headerControls) return null;

  return createPortal(
    <button
      type="button"
      aria-pressed={isOn}
      className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      onClick={() => toggleCursorPreference()}
      title="Toggle the whip cursor (Shift+C)"
    >
      <span>Whip cursor</span>
      <span className={isOn ? 'text-[var(--color-accent)]' : undefined}>{isOn ? 'On' : 'Off'}</span>
    </button>,
    headerControls,
  );
}
