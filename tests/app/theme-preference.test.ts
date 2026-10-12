/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_ATTRIBUTE,
  THEME_CHANGE_EVENT,
  THEME_COLOURS,
  THEME_HINT_SCRIPT,
  THEME_STORAGE_KEY,
  readThemePreference,
  resolveTheme,
  storeThemePreference,
} from '../../app/theme-preference';

// By path: under jsdom, `URL` is jsdom's own, which `fs` does not accept.
const CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../app/globals.css'),
  'utf8',
);

/** The system's colour scheme as `matchMedia` reports it, and its listeners. */
interface SystemScheme {
  light: boolean;
  readonly listeners: Set<() => void>;
  /** The system switches scheme, as a manager's evening schedule does. */
  change(light: boolean): void;
}

function systemScheme(light: boolean): SystemScheme {
  const scheme: SystemScheme = {
    light,
    listeners: new Set(),
    change(next: boolean): void {
      scheme.light = next;
      for (const listener of scheme.listeners) listener();
    },
  };
  vi.stubGlobal('matchMedia', (query: string) => {
    expect(query).toBe('(prefers-color-scheme: light)');
    return {
      get matches(): boolean {
        return scheme.light;
      },
      addEventListener: (_type: string, listener: () => void): void => {
        scheme.listeners.add(listener);
      },
    };
  });
  return scheme;
}

/** Run the head's theme script as the browser does, and say what it wrote onto `<html>`. */
function runThemeScript(): string | null {
  // The script is the layout's inline text; running it here is running what ships.
  new Function(THEME_HINT_SCRIPT)();
  return document.documentElement.getAttribute(THEME_ATTRIBUTE);
}

function theme(): string | null {
  return document.documentElement.getAttribute(THEME_ATTRIBUTE);
}

function chrome(): string[] {
  return [...document.querySelectorAll('meta[name="theme-color"]')].map(
    (meta) => meta.getAttribute('content') ?? '',
  );
}

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  // A sentinel rather than no attribute: an earlier test's head script still watches the root and
  // draws the theme again the moment the attribute is removed.
  document.documentElement.setAttribute(THEME_ATTRIBUTE, 'unset');
  document.head.replaceChildren();
});

describe('readThemePreference', (): void => {
  it.each([
    [null, 'dark'],
    ['dark', 'dark'],
    ['light', 'light'],
    ['system', 'system'],
    ['Light', 'dark'],
    ['', 'dark'],
  ] as const)('reads %j as %s, dark being the default', (stored, preference): void => {
    expect(readThemePreference(stored)).toBe(preference);
  });
});

describe('resolveTheme', (): void => {
  it('draws Dark and Light as chosen whatever the system says, and Follow system as the system', (): void => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
  });
});

describe('the chrome colours', (): void => {
  it("are each set's page colour", (): void => {
    expect(CSS).toContain(`--color-bg: ${THEME_COLOURS.dark};`);
    expect(/:root\[data-theme='light'\] \{[^}]*--color-bg: (#[0-9a-f]{6});/.exec(CSS)?.[1]).toBe(
      THEME_COLOURS.light,
    );
  });
});

describe('the head theme script (the preference applied before first paint)', (): void => {
  it('declares with const and let, never var (second review v5)', (): void => {
    expect(THEME_HINT_SCRIPT).not.toMatch(/\bvar\b/);
  });

  it('draws dark for a browser that has never chosen, whatever its system says', (): void => {
    systemScheme(true);
    expect(runThemeScript()).toBe('dark');
    expect(chrome()).toEqual([THEME_COLOURS.dark]);
  });

  it.each([
    ['light', false, 'light'],
    ['dark', true, 'dark'],
    ['system', true, 'light'],
    ['system', false, 'dark'],
  ] as const)(
    'writes the theme resolveTheme gives for a stored %s under a light system: %s',
    (stored, light, drawn): void => {
      systemScheme(light);
      window.localStorage.setItem(THEME_STORAGE_KEY, stored);
      expect(runThemeScript()).toBe(drawn);
      expect(chrome()).toEqual([THEME_COLOURS[drawn]]);
    },
  );

  it('follows a change of the system’s scheme while the manager follows the system', (): void => {
    const system = systemScheme(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    runThemeScript();
    system.change(true);
    expect(theme()).toBe('light');
    expect(chrome()).toEqual([THEME_COLOURS.light]);
    system.change(false);
    expect(theme()).toBe('dark');
  });

  it('ignores a change of the system’s scheme while the manager has chosen one', (): void => {
    const system = systemScheme(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    runThemeScript();
    system.change(true);
    expect(theme()).toBe('dark');
  });

  it('takes a choice made on the Appearance card at once, and one made in another tab', (): void => {
    systemScheme(false);
    runThemeScript();
    storeThemePreference('light');
    expect(theme()).toBe('light');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }));
    expect(theme()).toBe('dark');
  });

  it('draws the theme again when React clears the root’s attributes, as a hydration it gives up on does', async (): Promise<void> => {
    // The browser job saw it: a root rendered again on the client drops the attributes the head's
    // scripts wrote, and the page fell back to the dark set under a stored Light.
    systemScheme(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    runThemeScript();
    document.documentElement.removeAttribute(THEME_ATTRIBUTE);
    await Promise.resolve();
    expect(theme()).toBe('light');
  });

  it('keeps every theme-color tag on the drawn theme, one React adds after hydration too', async (): Promise<void> => {
    systemScheme(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    runThemeScript();
    const added = document.createElement('meta');
    added.setAttribute('name', 'theme-color');
    added.setAttribute('content', THEME_COLOURS.dark);
    document.head.append(added);
    await Promise.resolve();
    expect(chrome()).toEqual([THEME_COLOURS.light, THEME_COLOURS.light]);
  });

  it('retargets the chrome colour the layout rendered rather than adding a second', (): void => {
    systemScheme(false);
    const rendered = document.createElement('meta');
    rendered.setAttribute('name', 'theme-color');
    rendered.setAttribute('content', THEME_COLOURS.dark);
    document.head.append(rendered);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    runThemeScript();
    expect(chrome()).toEqual([THEME_COLOURS.light]);
  });

  it('draws a stored choice in a browser with no matchMedia, Follow system as dark', (): void => {
    vi.stubGlobal('matchMedia', undefined);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(runThemeScript()).toBe('light');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    expect(runThemeScript()).toBe('dark');
  });

  it('follows the system through the older listener where the query has no addEventListener, and still takes the card’s choice', (): void => {
    const listeners = new Set<() => void>();
    let light = false;
    // Safari before 14: a MediaQueryList with addListener only.
    vi.stubGlobal('matchMedia', () => ({
      get matches(): boolean {
        return light;
      },
      addListener: (listener: () => void): void => {
        listeners.add(listener);
      },
    }));
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    expect(runThemeScript()).toBe('dark');
    light = true;
    for (const listener of listeners) listener();
    expect(theme()).toBe('light');
    storeThemePreference('dark');
    expect(theme()).toBe('dark');
  });

  it('draws dark when the browser refuses storage, and never throws', (): void => {
    systemScheme(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(runThemeScript()).toBe('dark');
  });
});

describe('storeThemePreference', (): void => {
  it('keeps the choice in this browser and announces it', (): void => {
    const heard: string[] = [];
    window.addEventListener(THEME_CHANGE_EVENT, () => heard.push('change'));
    expect(storeThemePreference('system')).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(heard).toEqual(['change']);
  });

  it('still draws a choice the browser refuses to keep, for this visit', (): void => {
    systemScheme(false);
    runThemeScript();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    storeThemePreference('light');
    expect(theme()).toBe('light');
  });

  it('says so when the browser refuses to keep it', (): void => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(storeThemePreference('light')).toBe(false);
  });
});
