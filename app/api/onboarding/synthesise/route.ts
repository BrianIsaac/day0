import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { auth } from '@clerk/nextjs/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { DEV_NO_AUTH_COOKIE, isDevNoAuthSession, mintDevNoAuthToken } from '@/lib/dev-auth-server';
import { crossOriginRefusal, readJsonBody } from '@/lib/json-request';

interface Body {
  agentId: string;
  bossLabel: string;
  transcript: string;
  voiceSessionId?: string;
}

/** A whole Day-1 transcript with room to spare. */
const SYNTHESISE_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * Browser-callable charter-synthesis trigger - used by the chat-mode
 * 1:1 once the agent emits the `dayOneComplete` tool call. Authenticated
 * via the caller's Clerk JWT; the Convex action enforces that the caller
 * owns the agent. In no-auth dev mode the token is minted here with this
 * machine's local key instead, and the same ownership check runs. A page
 * from another origin is refused first, and the JSON body is read, bounded,
 * only once the caller is established.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const crossOrigin = crossOriginRefusal(req);
  if (crossOrigin) return crossOrigin;

  const client = convexClient();
  if (DEV_NO_AUTH) {
    const jar = await cookies();
    if (!(await isDevNoAuthSession(jar.get(DEV_NO_AUTH_COOKIE)?.value))) {
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

  const read = await readJsonBody(req, SYNTHESISE_BODY_LIMIT_BYTES);
  if (!read.ok) return read.refusal;
  const body = bodyOf(read.value);
  if (!body) {
    return NextResponse.json(
      { error: 'agentId, bossLabel and transcript required' },
      { status: 400 },
    );
  }

  try {
    const result = await client.action(api.onboarding.synthesiseFromTranscript, {
      agentId: body.agentId as Id<'agents'>,
      bossLabel: body.bossLabel,
      transcript: body.transcript,
      voiceSessionId: body.voiceSessionId
        ? (body.voiceSessionId as Id<'voiceSessions'>)
        : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = (err as Error).message ?? 'unknown error';
    console.error(`[onboarding synthesise] failed: ${message}`);
    // A caller asking to end a call that is not its own gets a refusal it can
    // read, rather than an opaque 500 that looks like a server fault.
    if (message.includes('finalisation denied') || message.includes('forbidden')) {
      return NextResponse.json(
        { error: 'that voice session does not belong to this agent' },
        { status: 403 },
      );
    }
    return NextResponse.json({ error: 'charter synthesis failed' }, { status: 500 });
  }
}

function bodyOf(value: unknown): Body | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const { agentId, bossLabel, transcript, voiceSessionId } = record;
  if (typeof agentId !== 'string' || agentId === '') return undefined;
  if (typeof transcript !== 'string' || transcript === '') return undefined;
  if (typeof bossLabel !== 'string') return undefined;
  return {
    agentId,
    bossLabel,
    transcript,
    ...(typeof voiceSessionId === 'string' && voiceSessionId !== '' ? { voiceSessionId } : {}),
  };
}

function convexClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error('NEXT_PUBLIC_CONVEX_URL not set');
  return new ConvexHttpClient(url);
}
