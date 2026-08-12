import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { DEV_NO_AUTH_COOKIE, isDevNoAuthSecret, mintDevNoAuthToken } from '@/lib/dev-auth-server';

/**
 * Hands the browser a short-lived Convex token for the local boss, once it has
 * shown the unlock cookie. `proxy.ts` refuses callers without it before they
 * reach this route; the check is repeated because this is the one route that turns
 * possession of the unlock secret into the credential Convex accepts, and it
 * should not depend on a matcher pattern for that.
 */
export async function POST(): Promise<NextResponse> {
  if (!DEV_NO_AUTH) {
    return NextResponse.json({ error: 'no-auth dev mode is off' }, { status: 404 });
  }

  const jar = await cookies();
  if (!isDevNoAuthSecret(jar.get(DEV_NO_AUTH_COOKIE)?.value)) {
    return NextResponse.json(
      { error: 'this browser has not been unlocked with the local no-auth key' },
      { status: 403 },
    );
  }

  try {
    const token = await mintDevNoAuthToken();
    return NextResponse.json({ token }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 503 });
  }
}
