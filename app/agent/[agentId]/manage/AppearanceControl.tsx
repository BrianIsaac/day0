'use client';

import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import {
  THEME_CHANGE_EVENT,
  THEME_PREFERENCES,
  type ThemePreference,
  storeThemePreference,
  storedThemePreference,
} from '../../../theme-preference';
import { StatusRegion } from '../../../components/StatusRegion';
import type { ChangeOutcome } from '../../../components/use-change';

/** The card's sentence (`agent-manage.html`, the section 7 draft as written: RM24). */
export const APPEARANCE_COPY = 'Dark is the default. Light follows your system if you ask for it.';

/** Each choice's label, in the card's order. */
const LABELS: Readonly<Record<ThemePreference, string>> = {
  dark: 'Dark',
  light: 'Light',
  system: 'Follow system',
};

/** Listen for a choice announced on this page or stored by another tab. */
function subscribe(onChange: () => void): () => void {
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** The server draws the default; the browser's own choice replaces it once hydrated. */
function serverPreference(): ThemePreference {
  return 'dark';
}

/**
 * The Appearance card's control (16-T): Dark, Light and Follow system as one radio group, the
 * choice this browser keeps checked. A choice is kept and drawn at once by the head's theme
 * script (`app/theme-preference.ts`); what it came to is said in a live region, and focus stays on
 * the radio, as every control on the employee page keeps it. The choice is the viewer's, in this
 * browser, and has nothing to do with the employee, so nothing is written to the backend.
 */
export function AppearanceControl() {
  const stored = useSyncExternalStore(subscribe, storedThemePreference, serverPreference);
  // A choice the browser refused to keep holds for the visit; the stored one is shown otherwise.
  const [unkept, setUnkept] = useState<ThemePreference | null>(null);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  const shown = unkept ?? stored;
  const group = useId();

  // Another tab storing a choice is what the page draws then, so the card shows it too.
  useEffect(() => {
    const showStored = (): void => setUnkept(null);
    window.addEventListener('storage', showStored);
    return () => window.removeEventListener('storage', showStored);
  }, []);

  function choose(preference: ThemePreference): void {
    const kept = storeThemePreference(preference);
    setUnkept(kept ? null : preference);
    setOutcome({
      tone: 'done',
      text: kept
        ? `Theme: ${LABELS[preference]}.`
        : `Theme: ${LABELS[preference]}, for this visit: this browser does not keep the choice.`,
    });
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-[var(--color-fg-2)]">{APPEARANCE_COPY}</p>
      <fieldset className="grid gap-2">
        <legend className="sr-only">Theme</legend>
        <div className="flex flex-wrap gap-2">
          {THEME_PREFERENCES.map((preference) => (
            <label
              key={preference}
              className="relative inline-flex min-h-11 cursor-pointer items-center rounded-full border border-[var(--color-border)] px-3.5 text-[13px] text-[var(--color-fg-2)] transition-colors has-checked:border-[var(--color-accent-line)] has-checked:bg-[var(--color-accent-soft)] has-checked:text-[var(--color-accent)] has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-[var(--color-accent)] not-has-checked:hover:border-[var(--color-border-2)] not-has-checked:hover:text-[var(--color-fg)] motion-reduce:transition-none"
            >
              <input
                type="radio"
                name={group}
                value={preference}
                checked={shown === preference}
                onChange={() => choose(preference)}
                className="sr-only"
              />
              {LABELS[preference]}
            </label>
          ))}
        </div>
      </fieldset>
      <StatusRegion outcome={outcome} />
    </div>
  );
}
