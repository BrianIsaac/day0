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
 * @property {Set<WebSocket>} sockets Every socket open or opening for the app (at most two).
 * @property {WebSocket | undefined} live The socket whose hello arrived last.
 * @property {WebSocket | undefined} pending The socket opened and not yet greeted.
 * @property {boolean} requesting A connection URL is being asked for.
 * @property {number} failures Consecutive failed opens, for the backoff.
 * @property {number} liveSince When the live socket was greeted.
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

  /** POST one of the backend's bridge routes with the secret; the parsed answer and status. */
  async function backend(path, body) {
    const response = await fetchImpl(new URL(path, options.backendUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
    const parsed = await response.json().catch(() => ({}));
    return { status: response.status, body: parsed ?? {} };
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
          .map((app) => [app.surfaceId, app.appId]),
      );
      for (const [surfaceId, state] of apps) {
        if (listed.get(surfaceId) !== state.appId) remove(state);
      }
      for (const [surfaceId, appId] of listed) {
        if (apps.has(surfaceId)) continue;
        const state = {
          surfaceId,
          appId,
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
        };
        apps.set(surfaceId, state);
        void open(state); // open records its own failure and schedules the retry
      }
      lastSync = { ok: true, at: Date.now() };
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
    if (state.live === socket) state.live = undefined;
    if (state.sockets.size === 0 && !state.removed && !stopped) {
      log({ level: 'warn', message: why, appId: state.appId });
      scheduleRetry(state);
    }
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
      scheduleRetry(state);
      return;
    }
    state.sockets.add(socket);
    state.pending = socket;
    const hello = setTimeout(() => {
      if (state.pending === socket) {
        log({ level: 'warn', message: 'no hello in time', appId: state.appId });
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
      state.pending = undefined;
      socket.close();
      return;
    }
    const previous = state.live;
    state.mismatch = false;
    state.live = socket;
    state.pending = undefined;
    state.liveSince = Date.now();
    log({ level: 'info', message: 'connected', appId: state.appId });
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
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const state of apps.values()) {
        state.removed = true;
        close(state);
      }
      apps.clear();
    },
    /** What the health check reports: the last list read and each app's connection. */
    status() {
      return {
        synced: lastSync.ok,
        syncedAt: lastSync.at,
        apps: [...apps.values()].map((state) => ({
          appId: state.appId,
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
