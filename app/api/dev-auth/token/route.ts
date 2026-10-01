import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { DEV_NO_AUTH_COOKIE, devNoAuthSessionId, mintDevNoAuthToken } from '@/lib/dev-auth-server';
import { errorMessage } from '@/lib/errors';

/**
 * Hands the browser a short-lived Convex token for the local boss, once it has
 * shown the unlock cookie. The token names the configured manager address as
 * the caller's verified `email`, read here on the server and never taken from
 * the browser, so the address an employee is deployed under is the operator's. `proxy.ts` refuses callers without it before they
 * reach this route; the check is repeated because this is the one route that turns
 * possession of the unlock secret into the credential Convex accepts, and it
 * should not depend on a matcher pattern for that.
 */
export async function POST(): Promise<NextResponse> {
  if (!DEV_NO_AUTH) {
    return NextResponse.json({ error: 'no-auth dev mode is off' }, { status: 404 });
  }

  const jar = await cookies();
  const session = await devNoAuthSessionId(jar.get(DEV_NO_AUTH_COOKIE)?.value);
  if (!session) {
    return NextResponse.json(
      { error: 'this browser has not been unlocked with the local no-auth key' },
      { status: 403 },
    );
  }

  try {
    const token = await mintDevNoAuthToken(session);
    return NextResponse.json({ token }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 503 });
  }
}
