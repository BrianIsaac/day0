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

/** How long a due refresh waits for the connection the last one replaced to finish closing. */
const REFRESH_WAIT_MS = 1_000;
/** How long a press is offered to the backend before it is given up (a backend restart is shorter). */
export const PRESS_RETRY_WINDOW_MS = 60_000;
/** The first wait between offers of a press; it doubles to the cap. */
export const PRESS_RETRY_FIRST_MS = 500;
/** The longest wait between offers of a press. */
export const PRESS_RETRY_CAP_MS = 10_000;
/** How long one backend call may take. */
export const BACKEND_TIMEOUT_MS = 15_000;
/**
 * What the person who pressed is told, through the press's own `response_url`, when the bridge
 * acknowledged a press and could not hand it to Day0 in time (W12-R22): only them, and the request
 * stays, so a press a minute later may get through.
 */
export const PRESS_NOT_RECEIVED =
  'Day0 did not receive this press, so nothing was decided. Press it again in a minute, or decide in day0.';
/**
 * What the person who pressed is told when Day0 answered the press with a refusal, which another
 * press would meet again (W12-R22).
 */
export const PRESS_REFUSED =
  'Day0 could not take this press, so nothing was decided. Decide in day0.';
/** How long telling the person may take. */
export const PRESS_NOTICE_TIMEOUT_MS = 5_000;
/**
 * How long the last report, every app down, may take as the bridge stops: inside the compose
 * service's five-second grace, so a clean stop reaches the card at once (D-6 (b)).
 */
export const FAREWELL_TIMEOUT_MS = 3_000;
/**
 * How long the stop waits for a report already on the wire before its farewell (W13-R17): with
 * the farewell's own bound, inside the compose service's five-second grace.
 */
export const FAREWELL_WAIT_MS = 1_500;
/** The most apps one report names: the backend's heartbeat route takes no more in one call. */
export const REPORT_PAGE = 1_000;

/**
 * A report in the pages the backend takes, each naming at most {@link REPORT_PAGE} apps.
 *
 * @param {{ apps: Array<Record<string, unknown>> }} body
 * @returns {Array<{ apps: Array<Record<string, unknown>> }>}
 */
export function reportPages(body) {
  const pages = [];
  for (let start = 0; start < body.apps.length; start += REPORT_PAGE) {
    pages.push({ apps: body.apps.slice(start, start + REPORT_PAGE) });
  }
  return pages;
}

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
 * @property {number} [stableAfterMs]
 * @property {number} [pressRetryWindowMs]
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
 * @property {string | undefined} slackHost The host the app's last connection URL named, which a
 *   press's `response_url` may also name (the fake Slack of a bed).
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
  const stableAfterMs = options.stableAfterMs ?? STABLE_AFTER_MS;
  const pressRetryWindowMs = options.pressRetryWindowMs ?? PRESS_RETRY_WINDOW_MS;
  /** @type {Map<string, AppState>} */
  const apps = new Map();
  let timer;
  let stopped = false;
  let lastSync = { ok: false, at: 0 };
  /** A report is on the wire, and whether another was asked for meanwhile. */
  let reporting = false;
  let reportAgain = false;
  /** The report loop on the wire, which a farewell waits for so it is the last row written. */
  let reportLoop = Promise.resolve();
  /** Whether the last report named any app, so a bridge holding none reports nothing again. */
  let reportedApps = false;
  /**
   * Apps dropped since the last report, by card: the next report names each down once (W13-R11),
   * so its row does not read live until it ages.
   */
  const dropped = new Map();
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

  /**
   * Each app the bridge holds, by its card and app, with whether it has a greeted connection, and
   * each app it dropped since the last report, down.
   */
  function heartbeat(live = true) {
    const gone = [...dropped].map(([surfaceId, appId]) => ({ surfaceId, appId, live: false }));
    dropped.clear();
    return {
      apps: [
        ...[...apps.values()].map((state) => {
          const connected = live && state.live !== undefined;
          return {
            surfaceId: state.surfaceId,
            appId: state.appId,
            live: connected,
            ...(connected ? { liveSince: state.liveSince } : {}),
            ...(!connected && state.failure !== undefined ? { failure: state.failure } : {}),
          };
        }),
        ...gone,
      ],
    };
  }

  /**
   * Tell the backend which apps hold a live connection (wave 13, 13-FS; D-6 (b)), so the card's
   * buttons row and each request read a bridge that runs rather than one that is configured. A
   * failure is logged when it starts and when it ends: a backend from before 0.17.0 has no route.
   * Answers whether every page was taken.
   */
  async function report(body, timeoutMs = BACKEND_TIMEOUT_MS) {
    try {
      for (const page of reportPages(body)) {
        const answer = await backend('/slack-socket/heartbeat', page, timeoutMs);
        if (answer.status !== 200) throw new Error(`the backend answered ${answer.status}`);
      }
      if (reportFailing) log({ level: 'info', message: 'the heartbeat is reported again' });
      reportFailing = false;
      return true;
    } catch (error) {
      if (!reportFailing) {
        log({
          level: 'warn',
          message: 'the heartbeat could not be reported',
          reason: reasonOf(error),
        });
      }
      reportFailing = true;
      return false;
    }
  }

  /** Report now, or once more after the report on the wire, so one change is never lost. */
  function reportSoon() {
    if (reporting) {
      reportAgain = true;
      return reportLoop;
    }
    reporting = true;
    reportLoop = (async () => {
      try {
        do {
          reportAgain = false;
          if (stopped) return;
          const body = heartbeat();
          // Nothing held and nothing reported last: no row could change. An app reported down
          // as it was dropped is said once (W13-R11).
          if (body.apps.length === 0 && !reportedApps) continue;
          reportedApps = apps.size > 0;
          if (!(await report(body))) {
            // A down report lost with the rest is said again at the next one (the second pass),
            // unless the card's app came back meanwhile.
            for (const app of body.apps) {
              if (app.live === false && !apps.has(app.surfaceId) && !dropped.has(app.surfaceId)) {
                dropped.set(app.surfaceId, app.appId);
              }
            }
            if (dropped.size > 0) reportedApps = true;
          }
        } while (reportAgain);
      } finally {
        reporting = false;
      }
    })();
    return reportLoop;
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
        // The card's new app reports for it: its old app's row is replaced, not written down.
        dropped.delete(surfaceId);
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
          slackHost: undefined,
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
    dropped.set(state.surfaceId, state.appId);
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
    log({ level: 'info', message: 'dialling again', appId: state.appId, inMs: wait });
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
    // A connection that lived long enough ends a flap: its drop dials again at the first wait, not
    // after the back-off its earlier failures had reached (W12-R21).
    if (wasLive && Date.now() - state.liveSince >= stableAfterMs) state.failures = 0;
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
    state.slackHost = new URL(url).host;
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
    const refresh = () => {
      // The connection the last refresh replaced is still closing, so the bridge holds two and
      // `open` would do nothing: try again shortly, or the bridge stops refreshing for good.
      if (state.sockets.size >= 2) {
        state.refresh = setTimeout(refresh, REFRESH_WAIT_MS);
        return;
      }
      state.refresh = undefined;
      if (Date.now() - state.liveSince >= stableAfterMs) state.failures = 0;
      void open(state); // open records its own failure and schedules the retry
    };
    state.refresh = setTimeout(refresh, maxConnectionMs);
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
      if (Date.now() - state.liveSince >= stableAfterMs) state.failures = 0;
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
    const until = Date.now() + pressRetryWindowMs;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const answer = await backend('/slack-socket/press', {
          surfaceId: state.surfaceId,
          payload,
        });
        if (answer.status === 200) {
          log({
            level: 'info',
            message: 'press handed over',
            appId: state.appId,
            status: answer.status,
            outcome: answer.body.status,
          });
          return;
        }
        // The backend refused it outright: offering it again gets the same answer. A 408 or a 429
        // is the backend busy, which a later offer may get past.
        if (
          answer.status >= 400 &&
          answer.status < 500 &&
          answer.status !== 408 &&
          answer.status !== 429
        ) {
          await giveUp(state, payload, attempt, `the backend refused it (${answer.status})`, {
            refused: true,
          });
          return;
        }
        throw new Error(`the backend answered ${answer.status}`);
      } catch (error) {
        const wait = Math.min(pressRetryFirstMs * 2 ** (attempt - 1), PRESS_RETRY_CAP_MS);
        if (stopped || Date.now() + wait > until) {
          await giveUp(state, payload, attempt, reasonOf(error), { refused: false });
          return;
        }
        log({
          level: 'warn',
          message: 'press not handed over',
          appId: state.appId,
          attempt,
          reason: reasonOf(error),
        });
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  /**
   * A press Slack was told arrived and Day0 never took (W12-R22): logged, and the person who pressed
   * told through the press's own `response_url`, since Slack shows them nothing went wrong.
   */
  async function giveUp(state, payload, attempt, reason, { refused }) {
    const told = await tellPresser(state, payload, refused ? PRESS_REFUSED : PRESS_NOT_RECEIVED);
    log({ level: 'error', message: 'press given up', appId: state.appId, attempt, reason, told });
  }

  /**
   * Post a notice to the press's `response_url`, only where it is Slack's (`hooks.slack.com` over
   * https), or the host the app's connection came from (a bed's fake Slack); never a redirect.
   *
   * @returns Whether Slack took the message.
   */
  async function tellPresser(state, payload, text) {
    const target = responseUrlOf(payload, state.slackHost);
    if (target === undefined) return false;
    try {
      const response = await fetchImpl(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          response_type: 'ephemeral',
          replace_original: false,
          text,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(PRESS_NOTICE_TIMEOUT_MS),
      });
      return response.ok;
    } catch (error) {
      log({
        level: 'warn',
        message: 'the person who pressed could not be told',
        appId: state.appId,
        reason: reasonOf(error),
      });
      return false;
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
      // A live report still on the wire would land after the farewell and read the apps live
      // again; one that hangs is waited for no longer than the grace allows (W13-R17).
      let waited;
      await Promise.race([
        reportLoop,
        new Promise((resolve) => {
          waited = setTimeout(resolve, FAREWELL_WAIT_MS);
        }),
      ]);
      clearTimeout(waited);
      // Bounded as a whole: a farewell of several pages still ends within the grace.
      if (farewell.apps.length > 0) {
        let gaveUp;
        await Promise.race([
          report(farewell, FAREWELL_TIMEOUT_MS),
          new Promise((resolve) => {
            gaveUp = setTimeout(resolve, FAREWELL_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(gaveUp);
      }
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

/**
 * A press's `response_url`, when it is one the bridge may post to: Slack's own hook host over
 * https on its default port, or the host the app's own connection came from; undefined otherwise.
 *
 * @param {Record<string, unknown>} payload The press, as Slack sent it.
 * @param {string | undefined} slackHost The host of the app's connection URL.
 * @returns {URL | undefined}
 */
export function responseUrlOf(payload, slackHost) {
  if (typeof payload?.response_url !== 'string') return undefined;
  let url;
  try {
    url = new URL(payload.response_url);
  } catch {
    // Not a URL: nothing to post to.
    return undefined;
  }
  const slack = url.protocol === 'https:' && url.hostname === 'hooks.slack.com' && url.port === '';
  return slack || (slackHost !== undefined && url.host === slackHost) ? url : undefined;
}

/** A failure's message, never a URL (a Socket Mode URL carries its ticket). */
function reasonOf(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/wss?:\/\/\S+/g, '<socket url>');
}
