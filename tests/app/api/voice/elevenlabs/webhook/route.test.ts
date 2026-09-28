/** @vitest-environment node */
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../../../../../../app/api/voice/elevenlabs/webhook/route';

const SECRET = 'whsec_test';

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** A delivery signed the way ElevenLabs signs one: `t=<seconds>,v0=<hmac of "t.body">`. */
function signed(body: string, at = Math.floor(Date.now() / 1000), secret = SECRET): Request {
  const v0 = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return new Request('http://localhost:3000/api/voice/elevenlabs/webhook', {
    method: 'POST',
    headers: { 'elevenlabs-signature': `t=${at},v0=${v0}` },
    body,
  });
}

describe('the ElevenLabs post-call webhook', (): void => {
  it('answers 503 rather than accepting anything when no signing secret is configured', async (): Promise<void> => {
    vi.stubEnv('ELEVENLABS_WEBHOOK_SECRET', '');
    const response = await POST(signed('{}'));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain(
      'ELEVENLABS_WEBHOOK_SECRET is not set',
    );
  });

  it('refuses a delivery with no signature, a stale one, or one signed with another secret', async (): Promise<void> => {
    vi.stubEnv('ELEVENLABS_WEBHOOK_SECRET', SECRET);
    const unsigned = new Request('http://localhost:3000/api/voice/elevenlabs/webhook', {
      method: 'POST',
      body: '{}',
    });
    expect((await POST(unsigned)).status).toBe(401);
    expect((await POST(signed('{}', Math.floor(Date.now() / 1000) - 31 * 60))).status).toBe(401);
    expect((await POST(signed('{}', undefined, 'whsec_other'))).status).toBe(401);
  });

  it('checks the signature over the exact bytes before parsing, and only then refuses a body it cannot read', async (): Promise<void> => {
    vi.stubEnv('ELEVENLABS_WEBHOOK_SECRET', SECRET);
    const response = await POST(signed('not json'));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid JSON body');
  });

  it('refuses a signed delivery that names no agent, no session token, no conversation or no transcript, without reaching the backend', async (): Promise<void> => {
    vi.stubEnv('ELEVENLABS_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', '');
    const errors: string[] = [];
    for (const data of [
      {},
      { conversation_initiation_client_data: { dynamic_variables: { internal_agent_id: 'a1' } } },
      {
        conversation_initiation_client_data: {
          dynamic_variables: { internal_agent_id: 'a1', internal_session_token: 't' },
        },
      },
      {
        conversation_id: 'c1',
        conversation_initiation_client_data: {
          dynamic_variables: { internal_agent_id: 'a1', internal_session_token: 't' },
        },
        transcript: [],
      },
    ]) {
      const response = await POST(
        signed(JSON.stringify({ type: 'post_call_transcription', data })),
      );
      expect(response.status).toBe(400);
      errors.push(((await response.json()) as { error: string }).error);
    }
    expect(errors).toEqual([
      'dynamic_variables.internal_agent_id not provided',
      'dynamic_variables.internal_session_token not provided',
      'data.conversation_id not provided',
      'empty transcript',
    ]);
  });
});
