import { NextResponse } from 'next/server';
import { env } from '@/env';

/**
 * Hand the browser the agent id so it can mount the ElevenLabs widget,
 * plus a one-time signed URL for private agents. Public agents return
 * the agent id directly and the widget connects with no signed URL.
 *
 * On any non-OK response from ElevenLabs we surface the actual error to
 * the browser. Silent fallbacks made it impossible to tell whether the
 * failure was a wrong API key, a wrong agent id, or an allowlist that
 * doesn't include this domain.
 */
export async function GET(): Promise<NextResponse> {
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID) {
    return NextResponse.json(
      { error: 'ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID must be set' },
      { status: 400 },
    );
  }
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${env.ELEVENLABS_AGENT_ID}`,
      {
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
      },
    );
    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json(
        {
          error: `ElevenLabs returned ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
        },
        { status: 502 },
      );
    }
    const data = (await res.json()) as { signed_url?: string };
    return NextResponse.json({
      agentId: env.ELEVENLABS_AGENT_ID,
      signedUrl: data.signed_url ?? null,
      public: !data.signed_url,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
