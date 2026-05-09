import { NextResponse } from 'next/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

export async function POST(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const agentId = url.searchParams.get('agentId');
  if (!agentId) {
    return NextResponse.json({ error: 'agentId query param required' }, { status: 400 });
  }
  const client = convexClient();
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
