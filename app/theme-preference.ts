/**
 * The viewer's theme (16-T, wave 16 section 5.5): Dark, the default and the identity; Light; or
 * Follow system. The choice is this browser's own, kept in its storage, and the head's script
 * applies it before the first paint by writing the theme onto `<html>`, where the stylesheet's
 * light set keys off it (`app/globals.css`). The script is the one writer of the attribute: the
 * Appearance card stores a choice and announces it, and the script answers.
 */

/** The choices the Appearance card offers, in its order. */
export const THEME_PREFERENCES = ['dark', 'light', 'system'] as const;

/** One of the viewer's choices. */
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** A theme the page is drawn in. */
export type Theme = 'dark' | 'light';

/** Where this browser keeps the choice. */
export const THEME_STORAGE_KEY = 'day0-theme';

/** The attribute on `<html>` the head's script writes: `dark` or `light`. */
export const THEME_ATTRIBUTE = 'data-theme';

/** The event the Appearance card dispatches on `window`, its `detail` the new choice. */
export const THEME_CHANGE_EVENT = 'day0-theme-change';

/** The query whose answer Follow system takes. */
const SYSTEM_LIGHT_QUERY = '(prefers-color-scheme: light)';

/**
 * The browser chrome's colour in each theme: each set's `--color-bg`, so the header runs into
 * the window's own frame. The head's script writes it: the layout renders no `theme-color`.
 */
export const THEME_COLOURS: Readonly<Record<Theme, string>> = {
  dark: '#0a0a0b',
  light: '#fafafa',
};

/**
 * The choice a stored value names, Dark for anything that names none.
 *
 * @param stored - The value this browser kept, null when it kept none.
 */
export function readThemePreference(stored: string | null): ThemePreference {
  return THEME_PREFERENCES.find((preference) => preference === stored) ?? 'dark';
}

/**
 * The theme a choice draws.
 *
 * @param systemPrefersLight - Whether the system's scheme is light, which only Follow system reads.
 */
export function resolveTheme(preference: ThemePreference, systemPrefersLight: boolean): Theme {
  if (preference === 'system') return systemPrefersLight ? 'light' : 'dark';
  return preference;
}

/**
 * Keep a choice in this browser and announce it, so the head's script draws it at once.
 *
 * @returns Whether the browser kept it: a browser that refuses storage draws the choice for this
 *   visit only.
 */
export function storeThemePreference(preference: ThemePreference): boolean {
  let kept = true;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage refused (a private window, a full quota, site data blocked): the choice still
    // applies to this visit through the event below, and the caller says it was not kept.
    kept = false;
  }
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: preference }));
  return kept;
}

/**
 * The choice this browser keeps, Dark when it keeps none or refuses to say.
 */
export function storedThemePreference(): ThemePreference {
  try {
    return readThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    // Storage refused: nothing kept is the default.
    return 'dark';
  }
}

/**
 * The root layout's inline head script: it applies the stored choice before the first paint,
 * which no static page's server can, and keeps applying it for the page's life: when Follow
 * system's scheme changes, when the Appearance card announces a choice, when another tab stores
 * one, and when a client render of the root clears the attribute. It writes the theme onto `<html>` and the chrome's colour onto the layout's
 * `theme-color` meta, adding one only if the layout's has not been parsed yet. It is
 * `readThemePreference` and `resolveTheme` in the page's own words, over the same values.
 */
export const THEME_HINT_SCRIPT = `(function () {
  const preferences = ${JSON.stringify(THEME_PREFERENCES)};
  const colours = ${JSON.stringify(THEME_COLOURS)};
  const key = ${JSON.stringify(THEME_STORAGE_KEY)};
  const system =
    typeof window.matchMedia === 'function'
      ? window.matchMedia(${JSON.stringify(SYSTEM_LIGHT_QUERY)})
      : null;
  let announced = null;
  function stored() {
    if (announced !== null) return announced;
    try {
      return window.localStorage.getItem(key);
    } catch (refused) {
      return null;
    }
  }
  function apply() {
    const value = stored();
    const preference = preferences.indexOf(value) >= 0 ? value : 'dark';
    const systemLight = system !== null && system.matches;
    const theme = preference === 'system' ? (systemLight ? 'light' : 'dark') : preference;
    document.documentElement.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)}, theme);
    let metas = document.querySelectorAll('meta[name="theme-color"]');
    if (metas.length === 0) {
      const meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
      metas = [meta];
    }
    for (const meta of metas) meta.setAttribute('content', colours[theme]);
  }
  apply();
  // A root React renders again on the client (a hydration it gives up on) drops the attributes
  // written here; the theme is drawn again rather than falling back to the dark set.
  new MutationObserver(function () {
    if (document.documentElement.getAttribute(${JSON.stringify(THEME_ATTRIBUTE)}) === null) apply();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [${JSON.stringify(THEME_ATTRIBUTE)}],
  });
  // A theme-color tag added later (a route's metadata, React's head after hydration) takes the
  // drawn theme's colour too, so the chrome never carries a stale one.
  new MutationObserver(function (changes) {
    const added = changes.some(function (change) {
      return Array.prototype.some.call(change.addedNodes, function (node) {
        return node.nodeName === 'META' && node.getAttribute('name') === 'theme-color';
      });
    });
    if (added) apply();
  }).observe(document.head, { childList: true });
  window.addEventListener(${JSON.stringify(THEME_CHANGE_EVENT)}, function (event) {
    announced = event.detail;
    apply();
  });
  window.addEventListener('storage', function (event) {
    if (event.key !== key && event.key !== null) return;
    announced = null;
    apply();
  });
  // Last, so a browser whose query lacks both listeners still takes every choice above; Safari
  // before 14 has only the older addListener.
  if (system !== null && typeof system.addEventListener === 'function') {
    system.addEventListener('change', apply);
  } else if (system !== null && typeof system.addListener === 'function') {
    system.addListener(apply);
  }
})();`;
