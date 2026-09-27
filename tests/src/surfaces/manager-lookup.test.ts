import { describe, expect, it } from 'vitest';
import { probeSlackSurface } from '../../../convex/surfaceActions';
import { isManagerLookupFailure } from '../../../src/surfaces/manager-lookup';

const SLACK_POLICY =
  'Methods: `auth.test`, `users.lookupByEmail`, `conversations.open`, `conversations.list`, ' +
  '`conversations.history`, `conversations.replies`, `chat.postMessage`.';

/** Create one Slack-shaped JSON response. */
function slackResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A Slack whose bot is `UBOT` and whose email lookup answers as given.
 *
 * Args:
 *   user: The looked-up user, when the lookup succeeds.
 *   error: The Slack error code, when it does not.
 *
 * Returns:
 *   A fetcher for `probeSlackSurface`.
 */
function lookupReturning(
  user: Record<string, unknown> | undefined,
  error?: string,
): (input: string | URL) => Promise<Response> {
  return async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/auth.test')) return slackResponse({ ok: true, user_id: 'UBOT' });
    if (url.includes('/users.lookupByEmail')) {
      return error ? slackResponse({ ok: false, error }) : slackResponse({ ok: true, user });
    }
    throw new Error('conversations.open must not be reached');
  };
}

/** The message a probe raised, for a probe that must fail. */
async function probeFailure(
  email: string,
  fetcher: (input: string | URL) => Promise<Response>,
): Promise<string> {
  try {
    await probeSlackSurface('value', email, SLACK_POLICY, fetcher);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the probe was expected to fail');
}

describe('isManagerLookupFailure', (): void => {
  it('recognises every manager lookup failure the Slack probe raises', async (): Promise<void> => {
    const reasons = await Promise.all([
      probeFailure('left@day0.local', lookupReturning(undefined, 'users_not_found')),
      probeFailure('gone@day0.local', lookupReturning({ id: 'UGONE', deleted: true })),
      probeFailure('bot@day0.local', lookupReturning({ id: 'UOTHER', is_bot: true })),
      probeFailure('self@day0.local', lookupReturning({ id: 'UBOT' })),
      probeFailure('odd@day0.local', lookupReturning({})),
      probeFailure('  ', lookupReturning(undefined)),
    ]);
    for (const reason of reasons) expect(isManagerLookupFailure(reason)).toBe(true);
  });

  it('leaves a refused credential and a healthy row to the access path', async (): Promise<void> => {
    const refused = await probeFailure('boss@day0.local', async () =>
      slackResponse({ ok: false, error: 'invalid_auth' }),
    );
    expect(isManagerLookupFailure(refused)).toBe(false);
    expect(isManagerLookupFailure('provider returned 401')).toBe(false);
    expect(isManagerLookupFailure(undefined)).toBe(false);
  });
});
