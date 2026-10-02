import { describe, expect, it } from 'vitest';
import {
  DeploymentCallFailed,
  adminTarget,
  deploymentAdmin,
} from '../../../scripts/lib/convex-admin';

const URL_BASE = 'http://127.0.0.1:3740';
const ADMIN_KEY = 'convex-self-hosted|0123456789abcdef';

/** A deployment that answers every call with one body, and keeps what it was sent. */
function answering(
  body: unknown,
  status = 200,
): {
  readonly sent: Array<{ url: string; init: RequestInit }>;
  readonly fetch: typeof fetch;
} {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  return {
    sent,
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      sent.push({ url: String(input), init: init ?? {} });
      return Response.json(body, { status });
    },
  };
}

describe('the deployment, called with its admin key', (): void => {
  it('runs an internal function by its path, the arguments in the POST body and the key in the header', async (): Promise<void> => {
    const deployment = answering({ status: 'success', value: 'conn-1', logLines: [] });
    const admin = deploymentAdmin({
      url: `${URL_BASE}/`,
      adminKey: ADMIN_KEY,
      fetch: deployment.fetch,
    });

    const id = await admin.run('action', 'organisationConnections:landFromSetup', {
      system: 'slack',
      secret: 'xoxe-1234567890-abcdefghij',
    });

    expect(id).toBe('conn-1');
    const [call] = deployment.sent;
    expect(call.url).toBe(`${URL_BASE}/api/action`);
    expect(call.init.method).toBe('POST');
    expect(new Headers(call.init.headers).get('authorization')).toBe(`Convex ${ADMIN_KEY}`);
    expect(JSON.parse(String(call.init.body))).toEqual({
      path: 'organisationConnections:landFromSetup',
      args: { system: 'slack', secret: 'xoxe-1234567890-abcdefghij' },
      format: 'json',
    });
  });

  it('throws the function’s own refusal, never the arguments it was given', async (): Promise<void> => {
    const deployment = answering({
      status: 'error',
      errorMessage:
        'Slack is already connected for the organisation: rotate its secret, or revoke it first.',
      errorData:
        'Slack is already connected for the organisation: rotate its secret, or revoke it first.',
    });
    const admin = deploymentAdmin({ url: URL_BASE, adminKey: ADMIN_KEY, fetch: deployment.fetch });

    const refused = admin.run('action', 'organisationConnections:landFromSetup', {
      secret: 'xoxe-1234567890-abcdefghij',
    });

    await expect(refused).rejects.toThrow(DeploymentCallFailed);
    await expect(refused).rejects.toThrow('Slack is already connected for the organisation');
    await expect(refused).rejects.not.toThrow(/xoxe-/);
  });

  it('says the backend could not be reached, without the admin key', async (): Promise<void> => {
    const admin = deploymentAdmin({
      url: URL_BASE,
      adminKey: ADMIN_KEY,
      fetch: async (): Promise<Response> => {
        throw new TypeError(`fetch failed for ${ADMIN_KEY}`);
      },
    });
    const call = admin.run('query', 'organisationConnections:occupyingFor', { system: 'slack' });
    await expect(call).rejects.toThrow(/could not be reached/);
    await expect(call).rejects.not.toThrow(/0123456789abcdef/);
  });

  it('reads the self-hosted address and admin key from the env file, and refuses a cloud deployment', (): void => {
    expect(
      adminTarget({ CONVEX_SELF_HOSTED_URL: URL_BASE, CONVEX_SELF_HOSTED_ADMIN_KEY: ADMIN_KEY }),
    ).toEqual({ url: URL_BASE, adminKey: ADMIN_KEY });
    expect(adminTarget({ CONVEX_DEPLOYMENT: 'prod:scrupulous-bass-813' })).toEqual({
      gap: expect.stringContaining('self-hosted'),
    });
    expect(adminTarget({ CONVEX_SELF_HOSTED_URL: URL_BASE })).toEqual({
      gap: expect.stringContaining('CONVEX_SELF_HOSTED_ADMIN_KEY'),
    });
  });
});
