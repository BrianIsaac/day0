import { NextResponse } from 'next/server';
import { establishCaller } from '@/lib/dev-auth-server';
import { env } from '@/env';

/**
 * Hand the browser the agent id so it can mount the ElevenLabs widget,
 * plus a one-time signed URL for private agents. Public agents return
 * the agent id directly and the widget connects with no signed URL.
 *
 * Every signed URL is minted against the owner's ElevenLabs quota, so
 * the caller is established here and not left to the proxy matcher
 * alone.
 *
 * On any non-OK response from ElevenLabs we surface the actual error to
 * the browser. Silent fallbacks made it impossible to tell whether the
 * failure was a wrong API key, a wrong agent id, or an allowlist that
 * doesn't include this domain.
 *
 * ElevenLabs is optional: with no key this answers 200 with
 * `configured: false` rather than an error status, and the UI routes
 * the boss to chat mode instead. Missing voice credentials are a
 * deployment shape, not a fault. `?probe=1` answers that question
 * alone, so the mode picker can grey out voice without minting a
 * signed URL it will never use.
 *
 * The post-call webhook needs a third variable, ELEVENLABS_WEBHOOK_SECRET,
 * and refuses every delivery without it. Voice itself still runs: the
 * browser posts the transcript on disconnect, so the webhook only matters
 * when the tab dies mid-call.
 */
const UNCONFIGURED_REASON =
  'Voice mode needs ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID. Chat mode runs the same Day-1 1:1 without them.';

export async function GET(req: Request): Promise<NextResponse> {
  const caller = await establishCaller();
  if (!caller.ok) return caller.refusal;

  const apiKey = env.ELEVENLABS_API_KEY;
  const voiceAgentId = env.ELEVENLABS_AGENT_ID;
  const configured = !!apiKey && !!voiceAgentId;

  if (new URL(req.url).searchParams.has('probe')) {
    return NextResponse.json({
      configured,
      ...(configured ? {} : { reason: UNCONFIGURED_REASON }),
    });
  }

  if (!apiKey || !voiceAgentId) {
    return NextResponse.json({
      configured: false,
      agentId: null,
      signedUrl: null,
      public: false,
      reason: UNCONFIGURED_REASON,
    });
  }
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${voiceAgentId}`,
      {
        headers: { 'xi-api-key': apiKey },
      },
    );
    if (!res.ok) {
      // Common case: API key lacks `convai_write` permission, or the
      // agent is configured for public access (no signed URL needed).
      // Either way, fall back to passing the agent id directly to the
      // browser so it can connect over the public WebSocket. The browser
      // surfaces the warning but still lets the user click Start.
      const body = await res.text();
      return NextResponse.json({
        configured: true,
        agentId: voiceAgentId,
        signedUrl: null,
        public: true,
        warning: `signed-url fetch returned ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
      });
    }
    const data = (await res.json()) as { signed_url?: string };
    return NextResponse.json({
      configured: true,
      agentId: voiceAgentId,
      signedUrl: data.signed_url ?? null,
      public: !data.signed_url,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
