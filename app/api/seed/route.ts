import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

/**
 * Seeds the demo environment for the just-deployed agent. Called from
 * the deploy form on the landing page. Authenticated via the caller's
 * Clerk JWT — the Convex action enforces that the caller owns the
 * agent before seeding.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const agentId = url.searchParams.get('agentId');
  if (!agentId) {
    return NextResponse.json({ error: 'agentId query param required' }, { status: 400 });
  }

  const { getToken } = await auth();
  const token = await getToken({ template: 'convex' });
  if (!token) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }

  const client = convexClient();
  client.setAuth(token);
  const result = await client.action(api.seed.seedDemo, {
    agentId: agentId as Id<'agents'>,
  });
  return NextResponse.json(result);
}

function convexClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error('NEXT_PUBLIC_CONVEX_URL not set');
  return new ConvexHttpClient(url);
}
