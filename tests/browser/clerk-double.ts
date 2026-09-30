import type { Page, Route } from '@playwright/test';

/** Who the double says the visitor is. */
export type ClerkAnswer = 'signed-in' | 'signed-out';

/** Clerk's script, held back until the spec lets it answer. */
export interface HeldClerk {
  /** Settles once the page has asked for Clerk's script, which it does only after hydrating. */
  readonly requested: Promise<void>;
  /** Serves the double, so Clerk answers and mounts its controls. */
  readonly release: () => void;
}

/**
 * The resources Clerk emits: who is signed in, if anyone. `useAuth` counts a session as signed in
 * only with the claims of its last token.
 *
 * @param answer - Who the visitor is.
 */
function emittedResources(answer: ClerkAnswer): Record<string, unknown> {
  if (answer === 'signed-out') {
    return {
      client: { sessions: [], signedInSessions: [], lastActiveSessionId: null },
      session: null,
      user: null,
      organization: null,
    };
  }
  const user = {
    id: 'user_double',
    firstName: 'Boss',
    primaryEmailAddress: { emailAddress: 'boss@example.invalid' },
    imageUrl: '',
    hasImage: false,
  };
  const session = {
    id: 'sess_double',
    status: 'active',
    user,
    lastActiveToken: { jwt: { claims: { sub: user.id } } },
  };
  return {
    client: { sessions: [session], signedInSessions: [session], lastActiveSessionId: session.id },
    session,
    user,
    organization: null,
  };
}

/**
 * Clerk's browser build as far as `@clerk/react` reads it once the script has run: an instance
 * already loaded, the resources it last emitted (what `useUser` and `useAuth` read), and the
 * mounts the public pages ask for. The account menu is drawn as a 28 px avatar, as Clerk's default
 * theme draws it; the sign-in and sign-up widgets draw nothing. A version of `@clerk/react` that
 * reads more than this fails the spec that uses it, never passes it.
 *
 * Plain script rather than a serialised function, so no transpiler's helper can leak into it.
 *
 * @param answer - Who the visitor is.
 */
function clerkDoubleScript(answer: ClerkAnswer): string {
  return `(function () {
  var resources = ${JSON.stringify(emittedResources(answer))};
  if (resources.session) resources.session.getToken = function () { return Promise.resolve(null); };
  function drawNothing(node) { node.replaceChildren(); }
  window.Clerk = {
    loaded: true,
    version: 'double',
    client: resources.client,
    session: resources.session,
    user: resources.user,
    organization: null,
    isSignedIn: resources.user !== null,
    __internal_lastEmittedResources: resources,
    addListener: function (listener, options) {
      if (!options || !options.skipInitialEmit) listener(resources);
      return function () {};
    },
    __internal_updateProps: function () {},
    mountSignIn: drawNothing,
    unmountSignIn: drawNothing,
    mountSignUp: drawNothing,
    unmountSignUp: drawNothing,
    mountUserButton: function (node) {
      var avatar = document.createElement('button');
      avatar.type = 'button';
      avatar.setAttribute('aria-label', 'Open user menu');
      avatar.style.cssText = 'display:block;width:28px;height:28px;border:0;border-radius:9999px;background:#22d3ee';
      node.replaceChildren(avatar);
    },
    unmountUserButton: drawNothing
  };
})();`;
}

/** The script tag Clerk injects is cross-origin, so the double answers as a CDN would. */
const SCRIPT_HEADERS = { 'access-control-allow-origin': '*' };

/**
 * Serve Clerk's script as a double the spec releases, and its UI script as an empty one, under
 * the build's placeholder publishable key, whose frontend API cannot resolve. Every other request
 * to a `.invalid` host (the Convex address, Clerk's API) is aborted, as the page specs do.
 *
 * @param page - The page, before it navigates.
 * @param answer - Who the double says the visitor is.
 */
export async function holdClerk(page: Page, answer: ClerkAnswer): Promise<HeldClerk> {
  let markRequested: () => void = () => undefined;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Playwright tries the most recently added route first, so the catch-all goes in first.
  await page.route(/\.invalid\//, (route: Route) => route.abort());
  await page.route(/\/ui\.browser\.js$/, (route: Route) =>
    route.fulfill({
      contentType: 'text/javascript',
      headers: SCRIPT_HEADERS,
      body: 'window.__internal_ClerkUICtor = function ClerkUIDouble() {};',
    }),
  );
  await page.route(/\/clerk\.browser\.js$/, async (route: Route) => {
    markRequested();
    await released;
    await route.fulfill({
      contentType: 'text/javascript',
      headers: SCRIPT_HEADERS,
      body: clerkDoubleScript(answer),
    });
  });
  return { requested, release };
}
