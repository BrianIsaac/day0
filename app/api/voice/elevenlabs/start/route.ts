import { NextResponse } from 'next/server';
import { establishCaller } from '@/lib/dev-auth-server';
import { env } from '@/env';
import { log } from '@/lib/logger';

/** How long the signed-URL request may take before the page is told voice is unreachable. */
const SIGNED_URL_TIMEOUT_MS = 10_000;

/**
 * What the page reads when ElevenLabs refuses a signed URL, in the manager's words (N29): the
 * provider, the signed URL and its reason are the log's (N26).
 */
const SIGNED_URL_REFUSED = 'Voice could not open a private call with this employee';

/** The longest part of a refusal's body the log keeps. */
const PROVIDER_BODY_LOG_CHARS = 500;

const UNCONFIGURED_REASON =
  'Voice mode needs ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID. Chat mode runs the same Day-1 1:1 without them.';

/**
 * Hand the browser the agent id so it can mount the ElevenLabs widget,
 * plus a one-time signed URL for private agents. Public agents return
 * the agent id directly and the widget connects with no signed URL.
 *
 * Every signed URL is minted against the owner's ElevenLabs quota, so
 * the caller is established here and not left to the proxy matcher
 * alone.
 *
 * A non-OK response from ElevenLabs is never silent, since a silent
 * fallback made it impossible to tell a wrong API key from a wrong agent id
 * or an allowlist that does not include this domain; but its body is the
 * provider's words about the account, so it goes to the server log with the
 * status and the page gets fixed text (N26).
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
        signal: AbortSignal.timeout(SIGNED_URL_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      // Common case: API key lacks `convai_write` permission, or the
      // agent is configured for public access (no signed URL needed).
      // Either way, fall back to passing the agent id directly to the
      // browser so it can connect over the public WebSocket. The browser
      // surfaces the warning but still lets the user click Start.
      log.warn('ElevenLabs refused a signed URL', {
        status: res.status,
        statusText: res.statusText,
        body: (await res.text()).slice(0, PROVIDER_BODY_LOG_CHARS),
      });
      return NextResponse.json({
        configured: true,
        agentId: voiceAgentId,
        signedUrl: null,
        public: true,
        warning: SIGNED_URL_REFUSED,
      });
    }
    const data = (await res.json()) as { signed_url?: string };
    return NextResponse.json({
      configured: true,
      agentId: voiceAgentId,
      signedUrl: data.signed_url ?? null,
      public: !data.signed_url,
    });
  } catch (err: unknown) {
    // A transport error names hosts and, through a proxy, can carry its
    // credentials: it goes to the log, and the page gets the fixed reason (C-34).
    log.warn('the ElevenLabs signed-URL request failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'the voice service could not be reached' }, { status: 502 });
  }
}
