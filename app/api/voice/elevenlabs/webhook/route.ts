import { NextResponse } from 'next/server';
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

/**
 * ElevenLabs post-call transcription webhook. The agent's dashboard
 * webhook config carries this URL. Custom data (our internal agentId,
 * the boss label) lands at
 * `data.conversation_initiation_client_data.dynamic_variables` —
 * sent in the original `startSession({ dynamicVariables })` call from
 * the browser.
 *
 * Trust model: this route is unauthenticated (no Clerk JWT), so we hand
 * off to `synthesiseFromTranscriptForWebhook` rather than the
 * ownership-checked `synthesiseFromTranscript`. The Convex action
 * verifies the (agentId, conversation_id) pair matches an active voice
 * session — sessions can only be started by the legitimate user via
 * the ownership-checked `voice.start` mutation, so a forged webhook
 * payload pointing at someone else's agentId will fail the lookup.
 *
 * For production hardening, also verify the `elevenlabs-signature`
 * header against the agent's webhook secret via
 * `elevenlabs.webhooks.constructEvent(rawBody, ...)`.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const rawBody = await req.text();
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
  const conversationId = typeof data?.conversation_id === 'string' ? data.conversation_id : undefined;

  if (!agentId) {
    return NextResponse.json(
      { error: 'dynamic_variables.internal_agent_id not provided' },
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
  const result = await client.action(api.onboarding.synthesiseFromTranscriptForWebhook, {
    agentId: agentId as Id<'agents'>,
    bossLabel,
    transcript,
    elevenLabsConversationId: conversationId,
  });
  return NextResponse.json(result);
}

function convexClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error('NEXT_PUBLIC_CONVEX_URL not set');
  return new ConvexHttpClient(url);
}
