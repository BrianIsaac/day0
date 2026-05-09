import { NextResponse } from 'next/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

interface Body {
  agentId: string;
  bossLabel: string;
  transcript: string;
  voiceSessionId?: string;
}

/**
 * Browser-callable charter-synthesis trigger — used by the chat-mode
 * 1:1 once the agent emits <<DAY-ONE-COMPLETE>>.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json()) as Body;
  if (!body.agentId || !body.transcript) {
    return NextResponse.json({ error: 'agentId and transcript required' }, { status: 400 });
  }
  const client = convexClient();
  const result = await client.action(api.onboarding.synthesiseFromTranscript, {
    agentId: body.agentId as Id<'agents'>,
    bossLabel: body.bossLabel,
    transcript: body.transcript,
    voiceSessionId: body.voiceSessionId
      ? (body.voiceSessionId as Id<'voiceSessions'>)
      : undefined,
  });
  return NextResponse.json(result);
}

function convexClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error('NEXT_PUBLIC_CONVEX_URL not set');
  return new ConvexHttpClient(url);
}
