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
/** How many times a press is offered to the backend before it is given up, with its waits. */
export const PRESS_ATTEMPTS = 4;
export const PRESS_RETRY_FIRST_MS = 500;
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
 */

/**
 * @typedef {object} AppState
 * @property {string} surfaceId
 * @property {string} appId
 * @property {Set<WebSocket>} sockets Every socket open or opening for the app (at most two).
 * @property {WebSocket | undefined} live The socket whose hello arrived last.
 * @property {number} failures Consecutive failed opens, for the backoff.
 * @property {ReturnType<typeof setTimeout> | undefined} retry
 * @property {boolean} opening
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
    return { status: response.status, body: parsed };
  }

  async function sync() {
    try {
      const answer = await backend('/slack-socket/apps', {});
      if (answer.status !== 200 || !Array.isArray(answer.body.apps)) {
        throw new Error(`the backend answered ${answer.status}`);
      }
      const listed = new Map(
        answer.body.apps
          .filter((app) => typeof app?.surfaceId === 'string' && typeof app?.appId === 'string')
          .map((app) => [app.surfaceId, app.appId]),
      );
      for (const [surfaceId, state] of apps) {
        if (!listed.has(surfaceId)) remove(state);
      }
      for (const [surfaceId, appId] of listed) {
        if (!apps.has(surfaceId)) {
          const state = {
            surfaceId,
            appId,
            sockets: new Set(),
            live: undefined,
            failures: 0,
            retry: undefined,
            opening: false,
            removed: false,
          };
          apps.set(surfaceId, state);
          void open(state); // open records its own failure and schedules the retry
        }
      }
      lastSync = { ok: true, at: Date.now() };
    } catch (error) {
      lastSync = { ok: false, at: Date.now() };
      log({ level: 'warn', message: 'the app list could not be read', reason: reasonOf(error) });
    }
  }

  function remove(state) {
    state.removed = true;
    clearTimeout(state.retry);
    for (const socket of state.sockets) socket.close();
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

  /**
   * Open a connection for the app. A refresh opens the next before the last is closed, so a press
   * is never without a connection; the app never holds more than two (Slack allows ten, K1).
   */
  async function open(state) {
    if (stopped || state.removed || state.opening || state.sockets.size >= 2) return;
    state.opening = true;
    let url;
    try {
      const answer = await backend('/slack-socket/connection', { surfaceId: state.surfaceId });
      if (answer.status === 404) {
        state.opening = false;
        remove(state);
        return;
      }
      if (answer.status !== 200 || typeof answer.body.url !== 'string') {
        throw new Error(answer.body.error ?? `the backend answered ${answer.status}`);
      }
      url = answer.body.url;
    } catch (error) {
      state.opening = false;
      log({
        level: 'warn',
        message: 'no connection URL',
        appId: state.appId,
        reason: reasonOf(error),
      });
      scheduleRetry(state);
      return;
    }
    const socket = new Socket(url);
    state.sockets.add(socket);
    socket.addEventListener('message', (event) => {
      void receive(state, socket, String(event.data)); // receive logs every failure itself
    });
    socket.addEventListener('close', () => {
      state.sockets.delete(socket);
      if (state.live === socket) state.live = undefined;
      if (state.opening && state.live === undefined) state.opening = false;
      if (state.sockets.size === 0 && !state.removed && !stopped) {
        log({ level: 'warn', message: 'connection closed', appId: state.appId });
        scheduleRetry(state);
      }
    });
    socket.addEventListener('error', () => {
      log({ level: 'warn', message: 'connection error', appId: state.appId });
    });
  }

  async function receive(state, socket, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // Not JSON: nothing Slack sends over Socket Mode, so nothing to acknowledge.
      return;
    }
    if (message.type === 'hello') {
      const previous = state.live;
      state.live = socket;
      state.opening = false;
      state.failures = 0;
      log({ level: 'info', message: 'connected', appId: state.appId });
      // The connection this one replaced, after a refresh, goes once this one is greeted.
      if (previous !== undefined && previous !== socket) previous.close();
      return;
    }
    if (message.type === 'disconnect') {
      log({ level: 'info', message: 'refresh asked', appId: state.appId, reason: message.reason });
      void open(state); // open records its own failure and schedules the retry
      return;
    }
    if (typeof message.envelope_id !== 'string') return;
    // Acknowledged before anything else, so Slack never waits on the backend (K1).
    socket.send(JSON.stringify({ envelope_id: message.envelope_id }));
    if (message.type !== 'interactive' || message.payload?.type !== 'block_actions') return;
    await forward(state, message.payload);
  }

  /** Offer one press to the backend until it answers, a few times, with growing waits. */
  async function forward(state, payload) {
    for (let attempt = 1; attempt <= PRESS_ATTEMPTS; attempt += 1) {
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
        log({
          level: 'warn',
          message: 'press not handed over',
          appId: state.appId,
          attempt,
          reason: reasonOf(error),
        });
        if (attempt < PRESS_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, pressRetryFirstMs * 2 ** (attempt - 1)),
          );
        }
      }
    }
  }

  return {
    async start() {
      stopped = false;
      await sync();
      timer = setInterval(() => {
        void sync(); // sync logs its own failure
      }, syncIntervalMs);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const state of apps.values()) {
        clearTimeout(state.retry);
        for (const socket of state.sockets) socket.close();
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
