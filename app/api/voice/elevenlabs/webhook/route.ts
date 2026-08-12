import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

interface ElevenLabsPostCallPayload {
  type?: string;
  event_timestamp?: number;
  data?: {
    agent_id?: string;
    conversation_id?: string;
    transcript?: Array<{
      role: 'agent' | 'user';
      message: string;
      time_in_call_secs?: number;
    }>;
    conversation_initiation_client_data?: {
      dynamic_variables?: Record<string, string | number | boolean>;
    };
  };
}

/** Deliveries signed outside this window are refused, so a body captured off
 * the wire cannot be replayed later. Matches the ElevenLabs reference. */
const SIGNATURE_TOLERANCE_SECONDS = 30 * 60;

const MISSING_SECRET =
  'ELEVENLABS_WEBHOOK_SECRET is not set, so this deployment cannot tell a real ' +
  'ElevenLabs delivery from a forged one. Set it to the signing secret shown ' +
  'against the post-call webhook in the ElevenLabs dashboard.';

/**
 * ElevenLabs post-call transcription webhook. The agent's dashboard
 * webhook config carries this URL. Custom data (our internal agentId,
 * the boss label, the session's webhook token) lands at
 * `data.conversation_initiation_client_data.dynamic_variables` —
 * sent in the original `startSession({ dynamicVariables })` call from
 * the browser.
 *
 * Trust model: no Clerk JWT reaches this route, so the caller is
 * authenticated by the `elevenlabs-signature` HMAC over the raw body,
 * verified below before anything else reads the payload. Without the
 * shared secret the route refuses every request — a check that fails open
 * would be worse than no check, because the call site would read as
 * protected. Behind that, the Convex action independently binds the
 * transcript to a session via `internal_session_token`; it is a public
 * Convex function and cannot assume this route ran.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = verifySignature(rawBody, req.headers.get('elevenlabs-signature'));
  if (!signature.ok) {
    console.error(`[elevenlabs webhook] rejected: ${signature.error}`);
    return NextResponse.json({ error: signature.error }, { status: signature.status });
  }

  let payload: ElevenLabsPostCallPayload;
  try {
    payload = JSON.parse(rawBody) as ElevenLabsPostCallPayload;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const data = payload.data;
  const dyn = data?.conversation_initiation_client_data?.dynamic_variables ?? {};
  const agentId = typeof dyn.internal_agent_id === 'string' ? dyn.internal_agent_id : undefined;
  const bossLabel = typeof dyn.boss_label === 'string' ? dyn.boss_label : 'boss';
  const sessionToken =
    typeof dyn.internal_session_token === 'string' ? dyn.internal_session_token : undefined;
  const conversationId = typeof data?.conversation_id === 'string' ? data.conversation_id : undefined;

  if (!agentId) {
    return NextResponse.json(
      { error: 'dynamic_variables.internal_agent_id not provided' },
      { status: 400 },
    );
  }
  if (!sessionToken) {
    return NextResponse.json(
      { error: 'dynamic_variables.internal_session_token not provided' },
      { status: 400 },
    );
  }
  if (!conversationId) {
    return NextResponse.json(
      { error: 'data.conversation_id not provided' },
      { status: 400 },
    );
  }

  const transcript = (data?.transcript ?? [])
    .map((t) => `${t.role.toUpperCase()}: ${t.message}`)
    .join('\n');
  if (!transcript) {
    return NextResponse.json({ error: 'empty transcript' }, { status: 400 });
  }

  const client = convexClient();
  try {
    const result = await client.action(api.onboarding.synthesiseFromTranscriptForWebhook, {
      agentId: agentId as Id<'agents'>,
      bossLabel,
      transcript,
      elevenLabsConversationId: conversationId,
      sessionToken,
    });
    // A repeat delivery is a success, not a fault: ElevenLabs sends retries with
    // a byte-identical payload, treats 4xx as permanent, and disables a webhook
    // after enough consecutive failures. Saying "already recorded" with a 200 is
    // both true and what keeps the endpoint alive.
    return NextResponse.json(result);
  } catch (err) {
    const message = (err as Error).message ?? 'unknown error';
    console.error(`[elevenlabs webhook] synthesis failed: ${message}`);
    if (message.includes('webhook denied')) {
      return NextResponse.json(
        { error: 'payload does not match a voice session for that agent' },
        { status: 403 },
      );
    }
    // 5xx, so a genuine delivery whose model call failed is retried rather than
    // dropped. The session has already been handed back for exactly that.
    return NextResponse.json({ error: 'charter synthesis failed' }, { status: 500 });
  }
}

type SignatureCheck = { ok: true } | { ok: false; status: number; error: string };

/**
 * ElevenLabs signs `${timestamp}.${rawBody}` with the webhook secret and sends
 * `t=<unix seconds>,v0=<hex sha256>`. The body must be the exact bytes
 * received, so this runs before any parse.
 */
function verifySignature(rawBody: string, header: string | null): SignatureCheck {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return { ok: false, status: 503, error: MISSING_SECRET };

  const parts = (header ?? '').split(',').map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const provided = parts.find((p) => p.startsWith('v0='))?.slice(3);
  if (!timestamp || !provided) {
    return { ok: false, status: 401, error: 'missing or malformed elevenlabs-signature header' };
  }

  const signedAt = Number(timestamp);
  if (!Number.isFinite(signedAt)) {
    return { ok: false, status: 401, error: 'elevenlabs-signature timestamp is not a number' };
  }
  if (Math.abs(Date.now() / 1000 - signedAt) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, status: 401, error: 'elevenlabs-signature timestamp outside tolerance' };
  }

  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'),
    'utf8',
  );
  const actual = Buffer.from(provided, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, status: 401, error: 'elevenlabs-signature does not match body' };
  }
  return { ok: true };
}

function convexClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error('NEXT_PUBLIC_CONVEX_URL not set');
  return new ConvexHttpClient(url);
}
