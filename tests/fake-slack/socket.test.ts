import { createHash, randomBytes } from 'node:crypto';
import { connect as connectTcp, type Socket as TcpSocket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_BOT_TOKEN, startFakeSlack, type FakeSlack } from './spawn';

/*
 * Fake Slack's Socket Mode and buttons (wave 12, 12-M): a person's app-level token for an app
 * (K2), `apps.connections.open` answering a WebSocket URL (K1), the hello, a press of a message's
 * button delivered as an acknowledged `block_actions` envelope (K3), a refresh's disconnect, and
 * `chat.update` holding Slack's documented rule for blocks it is not given (K3b). Each case starts
 * its own fake.
 */

let fake: FakeSlack;

beforeEach(async (): Promise<void> => {
  // Pings every 200 ms, so a connection that stops answering is dropped within a test's time.
  fake = await startFakeSlack({ FAKE_SLACK_PING_MS: '200' });
}, 20_000);

afterEach((): void => {
  fake?.stop();
});

async function api(
  method: string,
  token: string,
  body: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${fake.base}/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

async function proof(path: string, body: Readonly<Record<string, unknown>>): Promise<Response> {
  return await fetch(`${fake.base}/proof/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const BUTTONS = [
  { type: 'section', text: { type: 'mrkdwn', text: 'Decide this.' } },
  {
    type: 'actions',
    block_id: 'day0-decision-ab3xyz',
    elements: [
      {
        type: 'button',
        action_id: 'day0.decision.approve',
        value: 'ab3xyz',
        style: 'primary',
        text: { type: 'plain_text', text: 'Approve' },
      },
      {
        type: 'button',
        action_id: 'day0.decision.reject',
        value: 'ab3xyz',
        style: 'danger',
        text: { type: 'plain_text', text: 'Reject' },
      },
    ],
  },
];

/** A request with buttons in the manager's DM, posted by the first app's bot. */
async function postRequest(): Promise<string> {
  const posted = await api('chat.postMessage', FAKE_BOT_TOKEN, {
    channel: 'D_DAY0_MANAGER',
    text: 'Decide this.',
    blocks: BUTTONS,
  });
  expect(posted.ok).toBe(true);
  return String(posted.ts);
}

/** The person's click that generates the app's app-level token (K2). */
async function generateAppLevelToken(appId = 'A_DAY0_FAKE'): Promise<string> {
  const response = await proof('app-level-token', { appId });
  expect(response.status).toBe(200);
  const { token } = (await response.json()) as { token: string };
  return token;
}

/** One open Socket Mode connection, its messages kept in arrival order. */
interface Socket {
  readonly socket: WebSocket;
  readonly messages: Array<Record<string, unknown>>;
  next(): Promise<Record<string, unknown>>;
}

async function connect(url: string): Promise<Socket> {
  const socket = new WebSocket(url);
  const messages: Array<Record<string, unknown>> = [];
  const waiting: Array<(message: Record<string, unknown>) => void> = [];
  socket.addEventListener('message', (event): void => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  await new Promise<void>((resolve, reject): void => {
    socket.addEventListener('open', (): void => resolve());
    socket.addEventListener('error', (): void => reject(new Error('socket failed')));
  });
  return {
    socket,
    messages,
    next: async (): Promise<Record<string, unknown>> => {
      const ready = messages.shift();
      if (ready) return ready;
      return await new Promise((resolve) => waiting.push(resolve));
    },
  };
}

describe('fake Slack: chat.update and blocks (K3b)', (): void => {
  it('removes the blocks when given text and no blocks, as Slack documents', async (): Promise<void> => {
    const ts = await postRequest();
    expect(
      await api('chat.update', FAKE_BOT_TOKEN, { channel: 'D_DAY0_MANAGER', ts, text: 'Decided.' }),
    ).toMatchObject({ ok: true, ts });
    const shown = (await (await fetch(`${fake.base}/proof`)).json()) as {
      messages: Array<{ ts: string; blockTypes: string[]; buttons: unknown[]; edits: number }>;
    };
    expect(shown.messages.find((message) => message.ts === ts)).toMatchObject({
      blockTypes: [],
      buttons: [],
      edits: 1,
    });
  });

  it('replaces the blocks with those it is given', async (): Promise<void> => {
    const ts = await postRequest();
    const settled = [{ type: 'section', text: { type: 'mrkdwn', text: 'Decided.' } }];
    await api('chat.update', FAKE_BOT_TOKEN, {
      channel: 'D_DAY0_MANAGER',
      ts,
      text: 'Decided.',
      blocks: settled,
    });
    const shown = (await (await fetch(`${fake.base}/proof`)).json()) as {
      messages: Array<{ ts: string; blockTypes: string[]; buttons: unknown[] }>;
    };
    expect(shown.messages.find((message) => message.ts === ts)).toMatchObject({
      blockTypes: ['section'],
      buttons: [],
    });
    expect(JSON.stringify(shown)).not.toContain('Decided.');
  });

  it('refuses an edit of a message that is not there', async (): Promise<void> => {
    expect(
      await api('chat.update', FAKE_BOT_TOKEN, {
        channel: 'D_DAY0_MANAGER',
        ts: '1.000001',
        text: 'Decided.',
      }),
    ).toMatchObject({ ok: false, error: 'message_not_found' });
  });
});

describe('fake Slack: Socket Mode and a press (K1, K2, K3)', (): void => {
  it('opens a connection only with the app-level token a person generated', async (): Promise<void> => {
    expect(await api('apps.connections.open', FAKE_BOT_TOKEN)).toMatchObject({
      ok: false,
      error: 'invalid_auth',
    });
    const token = await generateAppLevelToken();
    expect(token).toMatch(/^xapp-/);
    const opened = await api('apps.connections.open', token);
    expect(opened).toMatchObject({ ok: true });
    expect(String(opened.url)).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/link\/\?ticket=/);
  });

  it('greets a connection, delivers a press as an envelope and records its acknowledgement', async (): Promise<void> => {
    const ts = await postRequest();
    const opened = await api('apps.connections.open', await generateAppLevelToken());
    const connection = await connect(String(opened.url));
    expect(await connection.next()).toMatchObject({
      type: 'hello',
      num_connections: 1,
      connection_info: { app_id: 'A_DAY0_FAKE' },
    });
    const pressing = proof('press', { channel: 'D_DAY0_MANAGER', ts, button: 'approve' });
    const envelope = await connection.next();
    expect(envelope).toMatchObject({
      type: 'interactive',
      payload: {
        type: 'block_actions',
        user: { id: 'U_DAY0_MANAGER' },
        api_app_id: 'A_DAY0_FAKE',
        container: { message_ts: ts, channel_id: 'D_DAY0_MANAGER' },
        actions: [{ action_id: 'day0.decision.approve', value: 'ab3xyz' }],
      },
    });
    connection.socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    const pressed = (await (await pressing).json()) as Record<string, unknown>;
    expect(pressed).toMatchObject({ delivered: true, acknowledged: true });
    connection.socket.close();
  });

  it('gives a press its response_url, and keeps what is posted to it for the person who pressed (W12-R22)', async (): Promise<void> => {
    const ts = await postRequest();
    const opened = await api('apps.connections.open', await generateAppLevelToken());
    const connection = await connect(String(opened.url));
    await connection.next();
    const pressing = proof('press', { channel: 'D_DAY0_MANAGER', ts, button: 'approve' });
    const envelope = (await connection.next()) as {
      envelope_id: string;
      payload: { response_url: string };
    };
    connection.socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    await pressing;
    const responseUrl = new URL(envelope.payload.response_url);
    expect(responseUrl.origin).toBe(new URL(fake.base).origin);
    const posted = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        replace_original: false,
        text: 'Not received.',
      }),
    });
    expect(posted.status).toBe(200);
    const evidence = (await (await fetch(`${fake.base}/proof`)).json()) as {
      responses: Array<Record<string, unknown>>;
    };
    expect(evidence.responses).toEqual([
      {
        channel: 'D_DAY0_MANAGER',
        ts,
        response_type: 'ephemeral',
        replace_original: false,
        text: 'Not received.',
      },
    ]);
    connection.socket.close();
  });

  it('answers a press with no connection open as Slack shows it: not delivered', async (): Promise<void> => {
    const ts = await postRequest();
    const response = await proof('press', { channel: 'D_DAY0_MANAGER', ts, button: 'approve' });
    expect(await response.json()).toMatchObject({
      delivered: false,
      error: 'no_socket_connection',
    });
  });

  it('asks a connection to refresh with a disconnect message', async (): Promise<void> => {
    const opened = await api('apps.connections.open', await generateAppLevelToken());
    const connection = await connect(String(opened.url));
    await connection.next();
    await proof('disconnect', { appId: 'A_DAY0_FAKE', reason: 'refresh_requested' });
    expect(await connection.next()).toMatchObject({
      type: 'disconnect',
      reason: 'refresh_requested',
    });
    connection.socket.close();
  });

  it('refuses a ticket used twice', async (): Promise<void> => {
    const opened = await api('apps.connections.open', await generateAppLevelToken());
    const first = await connect(String(opened.url));
    await first.next();
    await expect(connect(String(opened.url))).rejects.toThrow();
    first.socket.close();
  });
});

/**
 * A client that completes the WebSocket handshake and then answers nothing, as a bridge killed
 * with its container leaves its connection: no close frame and no answer to a ping ever arrives.
 */
async function deadClient(url: string): Promise<TcpSocket> {
  const target = new URL(url);
  const socket = connectTcp(Number(target.port), target.hostname);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const key = randomBytes(16).toString('base64');
  socket.write(
    `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n',
  );
  const expected = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  await new Promise<void>((resolve, reject) =>
    socket.once('data', (chunk) =>
      String(chunk).includes(expected) ? resolve() : reject(new Error('no handshake')),
    ),
  );
  return socket;
}

describe('fake Slack: a connection that stops answering (K1)', (): void => {
  it('drops a connection that answers no ping, so a press reaches the live one', async (): Promise<void> => {
    const ts = await postRequest();
    const token = await generateAppLevelToken();
    const dead = await deadClient(String((await api('apps.connections.open', token)).url));
    const live = await connect(String((await api('apps.connections.open', token)).url));
    await live.next();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const shown = (await (await fetch(`${fake.base}/proof`)).json()) as {
        socketConnections: Record<string, number>;
      };
      if (shown.socketConnections.A_DAY0_FAKE === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const pressing = proof('press', { channel: 'D_DAY0_MANAGER', ts, button: 'approve' });
    const envelope = await live.next();
    live.socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    expect(await (await pressing).json()).toMatchObject({ delivered: true, acknowledged: true });
    dead.destroy();
    live.socket.close();
  });
});
