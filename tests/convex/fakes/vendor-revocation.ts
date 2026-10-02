import { vi } from 'vitest';

/** One request the code under test sent to a vendor, as the network seam saw it. */
export interface VendorCall {
  readonly url: string;
  readonly authorization?: string;
  readonly form: Readonly<Record<string, string>>;
}

/** A recorded answer the fake network gives: an HTTP status and a JSON or text body. */
export interface VendorAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** The fake network: the calls it saw, and the answers it gives, in order, per URL path. */
export interface VendorNetwork {
  readonly calls: VendorCall[];
  /** Queue answers for a path (`/api/auth.revoke`, `/oauth/revoke`); the last one repeats. */
  answer(path: string, ...answers: VendorAnswer[]): void;
}

/**
 * Replace `fetch` with a network that answers a revocation request from recorded answers, so a
 * test reaches no vendor (standard 11.4). A path with no answer queued fails the test: nothing
 * may reach a vendor the test did not expect. The test restores it with `vi.unstubAllGlobals()`.
 *
 * @returns The network, to queue answers on and read the calls from.
 */
export function stubVendorNetwork(): VendorNetwork {
  const calls: VendorCall[] = [];
  const queued = new Map<string, VendorAnswer[]>();
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({
      url: url.toString(),
      ...(headers.get('authorization') !== null
        ? { authorization: headers.get('authorization') ?? '' }
        : {}),
      form: Object.fromEntries(new URLSearchParams(body)),
    });
    const answers = queued.get(url.pathname) ?? [];
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer === undefined) {
      throw new Error(`No recorded answer for ${url.toString()}: the test reached a vendor.`);
    }
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return new Response(text, { status: answer.status });
  });
  return {
    calls,
    answer(path: string, ...answers: VendorAnswer[]): void {
      queued.set(path, [...answers]);
    },
  };
}
