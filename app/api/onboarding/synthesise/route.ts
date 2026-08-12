import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { auth } from '@clerk/nextjs/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import {
  DEV_NO_AUTH_COOKIE,
  isDevNoAuthSecret,
  mintDevNoAuthToken,
} from '@/lib/dev-auth-server';

interface Body {
  agentId: string;
  bossLabel: string;
  transcript: string;
  voiceSessionId?: string;
}

/**
 * Browser-callable charter-synthesis trigger — used by the chat-mode
 * 1:1 once the agent emits the `dayOneComplete` tool call. Authenticated
 * via the caller's Clerk JWT; the Convex action enforces that the caller
 * owns the agent. In no-auth dev mode the token is minted here with this
 * machine's local key instead, and the same ownership check runs.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json()) as Body;
  if (!body.agentId || !body.transcript) {
    return NextResponse.json({ error: 'agentId and transcript required' }, { status: 400 });
  }

  const client = convexClient();
  if (DEV_NO_AUTH) {
    const jar = await cookies();
    if (!isDevNoAuthSecret(jar.get(DEV_NO_AUTH_COOKIE)?.value)) {
      return NextResponse.json({ error: 'not authenticated' }, { status: 403 });
    }
    client.setAuth(await mintDevNoAuthToken());
  } else {
    const { getToken } = await auth();
    const token = await getToken({ template: 'convex' });
    if (!token) {
      return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
    }
    client.setAuth(token);
  }

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
