import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { auth } from '@clerk/nextjs/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { DEV_NO_AUTH_COOKIE, isDevNoAuthSession, mintDevNoAuthToken } from '@/lib/dev-auth-server';
import { crossOriginRefusal, readJsonBody } from '@/lib/json-request';

/** An agent id and nothing else; anything larger is not a seed request. */
const SEED_BODY_LIMIT_BYTES = 4 * 1024;

/**
 * Seeds the demo environment for the just-deployed agent. Called from
 * the deploy form on the landing page with `{ agentId }` as JSON. Authenticated
 * via the caller's Clerk JWT - the Convex action enforces that the caller owns
 * the agent before seeding. In no-auth dev mode the token is minted here with
 * this machine's local key instead, and the same ownership check runs. A page
 * from another origin is refused before anything else, and the body is read
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

  const body = await readJsonBody(req, SEED_BODY_LIMIT_BYTES);
  if (!body.ok) return body.refusal;
  const agentId = agentIdOf(body.value);
  if (!agentId) {
    return NextResponse.json({ error: 'agentId required' }, { status: 400 });
  }

  const result = await client.action(api.seed.seedDemo, {
    agentId: agentId as Id<'agents'>,
  });
  return NextResponse.json(result);
}

function agentIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const agentId = (value as { agentId?: unknown }).agentId;
  return typeof agentId === 'string' && agentId !== '' ? agentId : undefined;
}

function convexClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error('NEXT_PUBLIC_CONVEX_URL not set');
  return new ConvexHttpClient(url);
}
