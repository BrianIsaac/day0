import { NextResponse } from 'next/server';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { establishConvexCaller } from '@/lib/convex-caller';
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
 * 1:1 once the agent emits the `dayOneComplete` tool call. The caller is
 * established by `establishConvexCaller`, whichever issuer signed them in,
 * and the Convex action enforces that they own the agent. A page from
 * another origin is refused first, and the JSON body is read, bounded, only
 * once the caller is established.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const crossOrigin = crossOriginRefusal(req);
  if (crossOrigin) return crossOrigin;

  const caller = await establishConvexCaller();
  if (!caller.ok) return caller.refusal;
  const { client } = caller;

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
