import { NextResponse } from 'next/server';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { establishConvexCaller } from '@/lib/convex-caller';
import { crossOriginRefusal, readJsonBody } from '@/lib/json-request';
import { log } from '@/lib/logger';
import { isEmployeeNotYours } from '@/agent/employee-access';

/** An agent id and nothing else; anything larger is not a seed request. */
const SEED_BODY_LIMIT_BYTES = 4 * 1024;

/**
 * Seeds the demo environment for the just-deployed agent. Called from
 * the deploy form on the landing page with `{ agentId }` as JSON. The caller
 * is established by `establishConvexCaller`, whichever issuer signed them in,
 * and the Convex action enforces that they own the agent before seeding. A
 * page from another origin is refused before anything else, and the body is
 * read only once the caller is established.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const crossOrigin = crossOriginRefusal(req);
  if (crossOrigin) return crossOrigin;

  const caller = await establishConvexCaller();
  if (!caller.ok) return caller.refusal;
  const { client } = caller;

  const body = await readJsonBody(req, SEED_BODY_LIMIT_BYTES);
  if (!body.ok) return body.refusal;
  const agentId = agentIdOf(body.value);
  if (!agentId) {
    return NextResponse.json({ error: 'agentId required' }, { status: 400 });
  }

  try {
    const result = await client.action(api.seed.seedDemo, {
      agentId: agentId as Id<'agents'>,
    });
    return NextResponse.json(result);
  } catch (err: unknown) {
    // The deployment's error text is for the log, not the page: in production
    // it carries the function path and the backend's own words (C-34).
    const message = err instanceof Error ? err.message : String(err);
    log.warn('demo seeding failed', { reason: message });
    if (isEmployeeNotYours(err) || /\bforbidden\b/.test(message)) {
      return NextResponse.json({ error: 'that agent is not yours to seed' }, { status: 403 });
    }
    return NextResponse.json({ error: 'demo seeding failed' }, { status: 500 });
  }
}

function agentIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const agentId = (value as { agentId?: unknown }).agentId;
  return typeof agentId === 'string' && agentId !== '' ? agentId : undefined;
}
