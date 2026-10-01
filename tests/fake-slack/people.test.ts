import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_BOT_TOKEN, startFakeSlack, type FakeSlack } from './spawn';

let fake: FakeSlack;

beforeAll(async (): Promise<void> => {
  fake = await startFakeSlack({ FAKE_SLACK_PEOPLE: 'Mateo@Acme.test, nora@acme.test' });
}, 20_000);

afterAll((): void => {
  fake?.stop();
});

async function api(method: string, body: string, type: string): Promise<Record<string, unknown>> {
  return (await (
    await fetch(`${fake.base}/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${FAKE_BOT_TOKEN}`, 'content-type': type },
      body,
    })
  ).json()) as Record<string, unknown>;
}

const FORM = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json; charset=utf-8';

describe('fake Slack’s people (RM2)', (): void => {
  it('fake Slack answers a lookup per address', async (): Promise<void> => {
    expect(await api('users.lookupByEmail', 'email=mateo%40acme.test', FORM)).toMatchObject({
      ok: true,
      user: { id: 'U_DAY0_PERSON_1', deleted: false },
    });
    expect(await api('users.lookupByEmail', 'email=NORA%40acme.test', FORM)).toMatchObject({
      user: { id: 'U_DAY0_PERSON_2' },
    });
    // Every other address is still the one manager, as before the people existed.
    expect(await api('users.lookupByEmail', 'email=priya%40acme.test', FORM)).toMatchObject({
      user: { id: 'U_DAY0_MANAGER' },
    });
  });

  it('opens a DM of each person’s own, so a handover between two managers reaches two DMs', async (): Promise<void> => {
    expect(
      await api('conversations.open', JSON.stringify({ users: 'U_DAY0_PERSON_1' }), JSON_TYPE),
    ).toMatchObject({
      channel: { id: 'D_DAY0_PERSON_1' },
    });
    expect(await api('conversations.open', 'users=U_DAY0_MANAGER', FORM)).toMatchObject({
      channel: { id: 'D_DAY0_MANAGER' },
    });
    for (const channel of ['D_DAY0_PERSON_1', 'D_DAY0_MANAGER', 'D_DAY0_PERSON_1']) {
      expect(
        await api(
          'chat.postMessage',
          JSON.stringify({ channel, text: 'handover notice' }),
          JSON_TYPE,
        ),
      ).toMatchObject({ ok: true, channel });
    }
    const proof = (await (await fetch(`${fake.base}/proof`)).json()) as Record<string, unknown>;
    expect(proof.postsByChannel).toEqual({ D_DAY0_PERSON_1: 2, D_DAY0_MANAGER: 1 });
    expect(JSON.stringify(proof)).not.toContain('handover notice');
  });
});
