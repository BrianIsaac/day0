/**
 * The Socket Mode bridge (wave 12, 12-M; RM7): holds one WebSocket per employee app that carries
 * Approve and Reject presses, acknowledges every envelope at once, and hands each press to the
 * backend's internal route behind the deployment's generated secret. Nothing inbound is opened to
 * the internet (Q13): Slack pushes presses down connections this process dials out.
 *
 * The app-level token never reaches this process: the backend opens each connection
 * (`apps.connections.open`) and answers only its short-lived URL.
 */

/** How often the list of apps is read again. */
export const SYNC_INTERVAL_MS = 30_000;
/** The first wait before a dropped connection is opened again; it doubles to the cap. */
export const RECONNECT_FIRST_MS = 1_000;
/** The longest wait between reconnection attempts. */
export const RECONNECT_CAP_MS = 60_000;
/** How long a connection must have lived before its failures are forgotten (a flap backs off). */
export const STABLE_AFTER_MS = 60_000;
/** How long an opened connection may take to say hello before it is given up. */
export const HELLO_TIMEOUT_MS = 10_000;
/**
 * The longest a connection is kept before the next is opened in its place. Slack refreshes its
 * own every few hours; this bounds how long a connection that went half-open unseen (a network
 * break with no close) can hold the app's presses.
 */
export const MAX_CONNECTION_MS = 30 * 60_000;
/** How long a press is offered to the backend before it is given up (a backend restart is shorter). */
export const PRESS_RETRY_WINDOW_MS = 60_000;
/** The first wait between offers of a press; it doubles to the cap. */
export const PRESS_RETRY_FIRST_MS = 500;
/** The longest wait between offers of a press. */
export const PRESS_RETRY_CAP_MS = 10_000;
/** How long one backend call may take. */
export const BACKEND_TIMEOUT_MS = 15_000;
/**
 * How long the last report, every app down, may take as the bridge stops: inside the compose
 * service's five-second grace, so a clean stop reaches the card at once (D-6 (b)).
 */
export const FAREWELL_TIMEOUT_MS = 3_000;

/**
 * @typedef {object} BridgeOptions
 * @property {string} backendUrl The backend's HTTP actions origin, such as `http://backend:3211`.
 * @property {string} secret The deployment's `DAY0_SOCKET_BRIDGE_SECRET`.
 * @property {typeof fetch} [fetch]
 * @property {typeof WebSocket} [WebSocket]
 * @property {(line: Record<string, unknown>) => void} [log] One structured line; never a URL.
 * @property {number} [syncIntervalMs]
 * @property {number} [reconnectFirstMs]
 * @property {number} [pressRetryFirstMs]
 * @property {number} [helloTimeoutMs]
 * @property {number} [maxConnectionMs]
 */

/**
 * @typedef {object} AppState
 * @property {string} surfaceId
 * @property {string} appId
 * @property {string | undefined} appName The app's name, as the backend lists it.
 * @property {string | undefined} tokenRef Which app-level token the card holds, as the backend
 *   names it (never the token): a different one means the token was replaced (W12V-6).
 * @property {Set<WebSocket>} sockets Every socket open or opening for the app (at most two).
 * @property {WebSocket | undefined} live The socket whose hello arrived last.
 * @property {WebSocket | undefined} pending The socket opened and not yet greeted.
 * @property {boolean} requesting A connection URL is being asked for.
 * @property {number} failures Consecutive failed opens, for the backoff.
 * @property {number} liveSince When the live socket was greeted.
 * @property {string | undefined} failure Why the last open failed, until a connection is greeted;
 *   reported to the backend with the app (D-6 (b)).
 * @property {ReturnType<typeof setTimeout> | undefined} retry
 * @property {ReturnType<typeof setTimeout> | undefined} refresh
 * @property {boolean} mismatch The last connection answered for another app.
 * @property {boolean} removed
 */

/**
 * Make a bridge. `start` reads the app list and keeps it current; `stop` closes everything.
 *
 * @param {BridgeOptions} options
 */
export function createBridge(options) {
  const fetchImpl = options.fetch ?? fetch;
  const Socket = options.WebSocket ?? WebSocket;
  const log = options.log ?? (() => undefined);
  const syncIntervalMs = options.syncIntervalMs ?? SYNC_INTERVAL_MS;
  const reconnectFirstMs = options.reconnectFirstMs ?? RECONNECT_FIRST_MS;
  const pressRetryFirstMs = options.pressRetryFirstMs ?? PRESS_RETRY_FIRST_MS;
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const maxConnectionMs = options.maxConnectionMs ?? MAX_CONNECTION_MS;
  /** @type {Map<string, AppState>} */
  const apps = new Map();
  let timer;
  let stopped = false;
  let lastSync = { ok: false, at: 0 };
  /** A report is on the wire, and whether another was asked for meanwhile. */
  let reporting = false;
  let reportAgain = false;
  /** Whether the last report failed, so a backend that takes none is said once, not every sync. */
  let reportFailing = false;

  /** POST one of the backend's bridge routes with the secret; the parsed answer and status. */
  async function backend(path, body, timeoutMs = BACKEND_TIMEOUT_MS) {
    const response = await fetchImpl(new URL(path, options.backendUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = await response.json().catch(() => ({}));
    return { status: response.status, body: parsed ?? {} };
  }

  /** Each app the bridge holds, by its card and app, with whether it has a greeted connection. */
  function heartbeat(live = true) {
    return {
      apps: [...apps.values()].map((state) => {
        const connected = live && state.live !== undefined;
        return {
          surfaceId: state.surfaceId,
          appId: state.appId,
          live: connected,
          ...(connected ? { liveSince: state.liveSince } : {}),
          ...(!connected && state.failure !== undefined ? { failure: state.failure } : {}),
        };
      }),
    };
  }

  /**
   * Tell the backend which apps hold a live connection (wave 13, 13-FS; D-6 (b)), so the card's
   * buttons row and each request read a bridge that runs rather than one that is configured. A
   * failure is logged when it starts and when it ends: a backend from before 0.17.0 has no route.
   */
  async function report(body, timeoutMs = BACKEND_TIMEOUT_MS) {
    try {
      const answer = await backend('/slack-socket/heartbeat', body, timeoutMs);
      if (answer.status !== 200) throw new Error(`the backend answered ${answer.status}`);
      if (reportFailing) log({ level: 'info', message: 'the heartbeat is reported again' });
      reportFailing = false;
    } catch (error) {
      if (!reportFailing) {
        log({
          level: 'warn',
          message: 'the heartbeat could not be reported',
          reason: reasonOf(error),
        });
      }
      reportFailing = true;
    }
  }

  /** Report now, or once more after the report on the wire, so one change is never lost. */
  async function reportSoon() {
    if (reporting) {
      reportAgain = true;
      return;
    }
    reporting = true;
    try {
      do {
        reportAgain = false;
        if (stopped) return;
        await report(heartbeat());
      } while (reportAgain);
    } finally {
      reporting = false;
    }
  }

  async function sync() {
    try {
      const answer = await backend('/slack-socket/apps', {});
      if (answer.status !== 200 || !Array.isArray(answer.body.apps)) {
        throw new Error(`the backend answered ${answer.status}`);
      }
      if (stopped) return;
      const listed = new Map(
        answer.body.apps
          .filter((app) => typeof app?.surfaceId === 'string' && typeof app?.appId === 'string')
          .map((app) => [
            app.surfaceId,
            {
              appId: app.appId,
              appName: typeof app.appName === 'string' ? app.appName : undefined,
              tokenRef: typeof app.tokenRef === 'string' ? app.tokenRef : undefined,
            },
          ]),
      );
      for (const [surfaceId, state] of apps) {
        const now = listed.get(surfaceId);
        if (now?.appId !== state.appId) remove(state);
        else if (now.tokenRef !== state.tokenRef) replace(state);
      }
      for (const [surfaceId, { appId, appName, tokenRef }] of listed) {
        if (apps.has(surfaceId)) continue;
        const state = {
          surfaceId,
          appId,
          appName,
          tokenRef,
          sockets: new Set(),
          live: undefined,
          pending: undefined,
          requesting: false,
          failures: 0,
          liveSince: 0,
          retry: undefined,
          refresh: undefined,
          mismatch: false,
          removed: false,
          failure: undefined,
        };
        apps.set(surfaceId, state);
        void open(state); // open records its own failure and schedules the retry
      }
      lastSync = { ok: true, at: Date.now() };
      void reportSoon(); // report logs its own failure
    } catch (error) {
      lastSync = { ok: false, at: Date.now() };
      log({ level: 'warn', message: 'the app list could not be read', reason: reasonOf(error) });
    }
  }

  function close(state) {
    clearTimeout(state.retry);
    clearTimeout(state.refresh);
    state.retry = undefined;
    state.refresh = undefined;
    for (const socket of state.sockets) socket.close();
  }

  function remove(state) {
    state.removed = true;
    close(state);
    apps.delete(state.surfaceId);
    log({ level: 'info', message: 'app no longer carries presses', appId: state.appId });
  }

  /**
   * The card's app-level token was replaced (W12V-6): the connection opened with the earlier one
   * is closed, and the same sync opens one with the new token, so a wrong token shows at once.
   */
  function replace(state) {
    state.removed = true;
    close(state);
    apps.delete(state.surfaceId);
    log({
      level: 'info',
      message: 'the app-level token was replaced; dialling again',
      appId: state.appId,
    });
  }

  function scheduleRetry(state) {
    if (stopped || state.removed || state.retry !== undefined) return;
    const wait = Math.min(reconnectFirstMs * 2 ** state.failures, RECONNECT_CAP_MS);
    state.failures += 1;
    state.retry = setTimeout(() => {
      state.retry = undefined;
      void open(state); // open records its own failure and schedules the retry
    }, wait);
  }

  /** A socket's own end: forgotten, and the app reopened when it holds nothing else. */
  function forget(state, socket, why) {
    state.sockets.delete(socket);
    if (state.pending === socket) state.pending = undefined;
    const wasLive = state.live === socket;
    if (wasLive) state.live = undefined;
    if (state.sockets.size === 0 && !state.removed && !stopped) {
      log({ level: 'warn', message: why, appId: state.appId });
      scheduleRetry(state);
    }
    // Only a connection that was carrying presses changes what the card may say.
    if (wasLive && state.live === undefined && !stopped) void reportSoon(); // report logs its own failure
  }

  /** Why the app's last open failed, kept for the report until a connection is greeted. */
  function failed(state, message, error) {
    state.failure = error === undefined ? message : `${message}: ${reasonOf(error)}`;
  }

  /**
   * Open a connection for the app. A refresh opens the next before the last is closed, so a press
   * is never without a connection; the app never holds more than two (Slack allows ten, K1), and
   * never more than one opening.
   */
  async function open(state) {
    if (stopped || state.removed || state.requesting || state.pending !== undefined) return;
    if (state.sockets.size >= 2) return;
    state.requesting = true;
    let url;
    try {
      const answer = await backend('/slack-socket/connection', { surfaceId: state.surfaceId });
      if (answer.status === 404) {
        state.requesting = false;
        if (!state.removed) remove(state);
        return;
      }
      if (answer.status !== 200 || typeof answer.body.url !== 'string') {
        throw new Error(answer.body.error ?? `the backend answered ${answer.status}`);
      }
      url = answer.body.url;
    } catch (error) {
      state.requesting = false;
      log({
        level: 'warn',
        message: 'no connection URL',
        appId: state.appId,
        reason: reasonOf(error),
      });
      failed(state, 'no connection URL', error);
      scheduleRetry(state);
      return;
    }
    state.requesting = false;
    // Stopped or dropped while the URL was asked for: nothing is opened.
    if (stopped || state.removed) return;
    let socket;
    try {
      socket = new Socket(url);
    } catch (error) {
      log({
        level: 'warn',
        message: 'the connection URL was refused',
        appId: state.appId,
        reason: reasonOf(error),
      });
      failed(state, 'the connection URL was refused', error);
      scheduleRetry(state);
      return;
    }
    state.sockets.add(socket);
    state.pending = socket;
    const hello = setTimeout(() => {
      if (state.pending === socket) {
        log({ level: 'warn', message: 'no hello in time', appId: state.appId });
        failed(state, 'no hello in time');
        socket.close();
      }
    }, helloTimeoutMs);
    socket.addEventListener('message', (event) => {
      void receive(state, socket, String(event.data)); // receive logs every failure itself
    });
    socket.addEventListener('close', () => {
      clearTimeout(hello);
      forget(state, socket, 'connection closed');
    });
    socket.addEventListener('error', () => {
      log({ level: 'warn', message: 'connection error', appId: state.appId });
    });
  }

  function greeted(state, socket, message) {
    const appId = message.connection_info?.app_id;
    if (typeof appId === 'string' && appId !== state.appId) {
      // An app-level token of another app: its presses would arrive under this card.
      state.mismatch = true;
      log({
        level: 'error',
        message: 'the connection is for another app',
        appId: state.appId,
        connectedAppId: appId,
      });
      failed(state, `the connection is for another app (${appId})`);
      state.pending = undefined;
      socket.close();
      return;
    }
    const previous = state.live;
    state.mismatch = false;
    state.live = socket;
    state.pending = undefined;
    state.liveSince = Date.now();
    state.failure = undefined;
    log({ level: 'info', message: 'connected', appId: state.appId });
    // A refresh's greeting changes nothing the card says; a first one does.
    if (previous === undefined) void reportSoon(); // report logs its own failure
    // The connection this one replaced, after a refresh, goes once this one is greeted.
    if (previous !== undefined && previous !== socket) previous.close();
    clearTimeout(state.refresh);
    state.refresh = setTimeout(() => {
      state.refresh = undefined;
      if (Date.now() - state.liveSince >= STABLE_AFTER_MS) state.failures = 0;
      void open(state); // open records its own failure and schedules the retry
    }, maxConnectionMs);
  }

  async function receive(state, socket, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // Not JSON: nothing Slack sends over Socket Mode, so nothing to acknowledge.
      return;
    }
    if (message === null || typeof message !== 'object') return;
    if (message.type === 'hello') {
      greeted(state, socket, message);
      return;
    }
    if (message.type === 'disconnect') {
      log({ level: 'info', message: 'refresh asked', appId: state.appId, reason: message.reason });
      if (Date.now() - state.liveSince >= STABLE_AFTER_MS) state.failures = 0;
      // A refresh opens the next at once; a link Slack disabled is reopened only after the backoff.
      if (message.reason === 'link_disabled') {
        socket.close();
        return;
      }
      void open(state); // open records its own failure and schedules the retry
      return;
    }
    if (typeof message.envelope_id !== 'string') return;
    // Acknowledged before anything else, so Slack never waits on the backend (K1).
    socket.send(JSON.stringify({ envelope_id: message.envelope_id }));
    if (message.type !== 'interactive' || message.payload?.type !== 'block_actions') return;
    await forward(state, message.payload);
  }

  /**
   * Offer one press to the backend until it answers, for as long as a backend restart takes. A
   * press is acknowledged before it is offered and keyed by its own timestamp at the backend, so
   * offering it again never decides twice.
   */
  async function forward(state, payload) {
    const until = Date.now() + PRESS_RETRY_WINDOW_MS;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const answer = await backend('/slack-socket/press', {
          surfaceId: state.surfaceId,
          payload,
        });
        if (answer.status === 200 || (answer.status >= 400 && answer.status < 500)) {
          log({
            level: answer.status === 200 ? 'info' : 'warn',
            message: 'press handed over',
            appId: state.appId,
            status: answer.status,
            outcome: answer.body.status,
          });
          return;
        }
        throw new Error(`the backend answered ${answer.status}`);
      } catch (error) {
        const wait = Math.min(pressRetryFirstMs * 2 ** (attempt - 1), PRESS_RETRY_CAP_MS);
        const giveUp = stopped || Date.now() + wait > until;
        log({
          level: giveUp ? 'error' : 'warn',
          message: giveUp ? 'press given up' : 'press not handed over',
          appId: state.appId,
          attempt,
          reason: reasonOf(error),
        });
        if (giveUp) return;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  return {
    async start() {
      stopped = false;
      await sync();
      if (stopped) return;
      timer = setInterval(() => {
        void sync(); // sync logs its own failure
      }, syncIntervalMs);
    },
    /**
     * Close everything, then report every app down, so the card stops offering buttons at once
     * rather than when the last report ages (D-6 (b)); the report is given up after
     * {@link FAREWELL_TIMEOUT_MS}.
     */
    async stop() {
      stopped = true;
      clearInterval(timer);
      const farewell = heartbeat(false);
      for (const state of apps.values()) {
        state.removed = true;
        close(state);
      }
      apps.clear();
      if (farewell.apps.length > 0) await report(farewell, FAREWELL_TIMEOUT_MS);
    },
    /** What the health check reports: the last list read and each app's connection. */
    status() {
      return {
        synced: lastSync.ok,
        syncedAt: lastSync.at,
        apps: [...apps.values()].map((state) => ({
          appId: state.appId,
          ...(state.appName !== undefined ? { appName: state.appName } : {}),
          connected: state.live !== undefined,
          sockets: state.sockets.size,
          ...(state.mismatch ? { mismatch: true } : {}),
        })),
      };
    },
  };
}

/** A failure's message, never a URL (a Socket Mode URL carries its ticket). */
function reasonOf(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/wss?:\/\/\S+/g, '<socket url>');
}
