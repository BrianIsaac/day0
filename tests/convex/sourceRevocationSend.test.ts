import { describe, expect, it } from 'vitest';
import {
  revokeSlackConfigurationToken,
  sendRevocation,
  slackRevocationOutcome,
  type RevocationFetch,
} from '../../convex/sourceRevocationSend';
import { linearTokenRevocation, readLinearAnswer } from '../../src/surfaces/revokers/linear';
import {
  LINEAR_REVOKE_ALREADY_REVOKED,
  SLACK_CONFIGURATION_ALREADY_REVOKED,
  SLACK_CONFIGURATION_REVOKED,
} from '../fixtures/real-vendor-walk-2026-10-03';

/** A configuration token in the tree's short shape. */
const TOKEN = 'xoxe.xoxp-1234567890-abcdefghij';

/** A transport answering each Slack method from a table, recording the methods it was asked. */
function slackAnswering(answers: Readonly<Record<string, { status: number; body: unknown }>>): {
  readonly transport: RevocationFetch;
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    transport: async (input: string | URL): Promise<Response> => {
      const method = new URL(String(input)).pathname.split('/').pop() ?? '';
      asked.push(method);
      const answer = answers[method];
      if (answer === undefined) throw new Error(`no answer for ${method}`);
      return Response.json(answer.body, { status: answer.status });
    },
  };
}

describe('sendRevocation', (): void => {
  it("reads the vendor's answer by its reader, never following a redirect", async (): Promise<void> => {
    const seen: RequestInit[] = [];
    const answer = await sendRevocation({
      request: linearTokenRevocation('lin_oauth_1', 'access_token'),
      token: 'lin_oauth_1',
      vendor: 'Linear',
      read: readLinearAnswer,
      fetch: async (_input: string | URL, init?: RequestInit): Promise<Response> => {
        if (init !== undefined) seen.push(init);
        return Response.json(LINEAR_REVOKE_ALREADY_REVOKED.body, {
          status: LINEAR_REVOKE_ALREADY_REVOKED.status,
        });
      },
    });
    expect(answer).toEqual({ kind: 'gone' });
    expect(seen.map((init) => init.redirect)).toEqual(['manual']);
  });

  it('asks again later when the vendor cannot be reached, and never repeats the token', async (): Promise<void> => {
    const answer = await sendRevocation({
      request: linearTokenRevocation('lin_oauth_1', 'access_token'),
      token: 'lin_oauth_1',
      vendor: 'Linear',
      read: readLinearAnswer,
      fetch: async (): Promise<Response> => {
        throw new Error('connect ECONNREFUSED while sending lin_oauth_1');
      },
    });
    expect(answer.kind).toBe('retry');
    expect(JSON.stringify(answer)).not.toContain('lin_oauth_1');
  });
});

describe('revokeSlackConfigurationToken (R41V-10)', (): void => {
  it('takes a revoke Slack carried out, checked with auth.test', async (): Promise<void> => {
    const { transport, asked } = slackAnswering({
      'auth.revoke': SLACK_CONFIGURATION_REVOKED,
      'auth.test': SLACK_CONFIGURATION_ALREADY_REVOKED,
    });
    await expect(revokeSlackConfigurationToken(TOKEN, transport)).resolves.toEqual({
      kind: 'revoked',
    });
    expect(asked).toEqual(['auth.revoke', 'auth.test']);
  });

  it("keeps Slack's word for a token it had already ended", async (): Promise<void> => {
    const { transport } = slackAnswering({
      'auth.revoke': SLACK_CONFIGURATION_ALREADY_REVOKED,
      'auth.test': SLACK_CONFIGURATION_ALREADY_REVOKED,
    });
    const answer = await revokeSlackConfigurationToken(TOKEN, transport);
    expect(answer).toEqual({ kind: 'gone', error: 'token_revoked' });
    expect(slackRevocationOutcome(answer)).toEqual({
      outcome: 'already-revoked',
      reason: 'Slack answered token_revoked',
    });
  });

  it('calls a revoke failed when Slack still accepts the token afterwards, whatever auth.revoke said', async (): Promise<void> => {
    const { transport } = slackAnswering({
      'auth.revoke': SLACK_CONFIGURATION_ALREADY_REVOKED,
      'auth.test': { status: 200, body: { ok: true } },
    });
    const answer = await revokeSlackConfigurationToken(TOKEN, transport);
    expect(slackRevocationOutcome(answer)).toEqual({
      outcome: 'failed',
      reason:
        'Slack answered token_revoked to auth.revoke, yet still accepted the token at auth.test',
    });
  });

  it('lets the revoke stand when the check cannot be made', async (): Promise<void> => {
    const answer = await revokeSlackConfigurationToken(TOKEN, async (input: string | URL) => {
      if (String(input).endsWith('/auth.test')) throw new Error('fetch failed');
      return Response.json(SLACK_CONFIGURATION_REVOKED.body);
    });
    expect(answer).toEqual({ kind: 'revoked' });
  });
});
