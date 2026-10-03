import {
  readSlackAnswer,
  slackTokenCheck,
  slackTokenRevocation,
  slackTokenStillWorks,
} from '../src/surfaces/revokers/slack';
import type { RevocationAnswer, RevocationRequest } from '../src/surfaces/revokers/types';
import { log } from '../src/lib/logger';
import { safeFailureMessage } from '../src/surfaces/redact';

/*
 * The one send of an organisation secret's revocation to its vendor, for the code that ends the
 * organisation's own secrets (`organisationSecrets.ts`) and a Slack rotation that finds its
 * connection revoked meanwhile (`slackProvisionActions.ts`). It defines no Convex function, so
 * either runtime imports it. The revokers it sends stay pure (`src/surfaces/revokers/`).
 */

/** How long one call to the vendor may take. */
const VENDOR_CALL_TIMEOUT_MS = 15_000;

/** The longest reason a ledger line keeps. */
const REASON_LIMIT = 300;

/** The transport a send goes through: the platform's `fetch`, or a caller's seam. */
export type RevocationFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** The body of a vendor's answer, parsed when it is JSON. */
async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON: a proxy's or the vendor's own error page, which the reader reads by its status.
    return text;
  }
}

/** A vendor's answer with any echo of the token taken out of its words. */
function withoutToken(answer: RevocationAnswer, token: string): RevocationAnswer {
  switch (answer.kind) {
    case 'revoked':
    case 'gone':
      return answer;
    case 'retry':
    case 'refused':
      return {
        kind: answer.kind,
        words: safeFailureMessage(new Error(answer.words), token, answer.words, REASON_LIMIT),
      };
    default: {
      const unknown: never = answer;
      throw new Error(`unhandled revocation answer ${String(unknown)}`);
    }
  }
}

/**
 * Send one revocation and read the vendor's answer by its reader; a redirect is never followed,
 * and no word of the answer carries the token.
 *
 * @param input.request - The revoker's request.
 * @param input.token - The token the request ends, kept out of every word.
 * @param input.vendor - The vendor's name, for the words when it cannot be reached.
 * @param input.read - The vendor's reader of a revocation answer.
 * @param input.fetch - The transport; the platform's by default.
 */
export async function sendRevocation(input: {
  readonly request: RevocationRequest;
  readonly token: string;
  readonly vendor: string;
  readonly read: (status: number, body: unknown) => RevocationAnswer;
  readonly fetch?: RevocationFetch;
}): Promise<RevocationAnswer> {
  const send = input.fetch ?? fetch;
  let response: Response;
  try {
    response = await send(input.request.url, {
      method: 'POST',
      headers: input.request.headers,
      body: input.request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(VENDOR_CALL_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    return {
      kind: 'retry',
      words: safeFailureMessage(
        error,
        input.token,
        `Could not reach ${input.vendor}.`,
        REASON_LIMIT,
      ),
    };
  }
  return withoutToken(input.read(response.status, await bodyOf(response)), input.token);
}

/** Slack's answer to `auth.revoke`, with Slack's own word when it found the token already gone. */
export type SlackRevocationAnswer =
  | Exclude<RevocationAnswer, { readonly kind: 'gone' }>
  | { readonly kind: 'gone'; readonly error: string };

/**
 * Whether Slack still accepts a token (`auth.test`). A check that cannot be made answers false,
 * so the revoke's own answer stands.
 */
async function stillWorks(token: string, transport: RevocationFetch): Promise<boolean> {
  const check = slackTokenCheck(token);
  try {
    const response = await transport(check.url, {
      method: 'POST',
      headers: check.headers,
      body: check.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(VENDOR_CALL_TIMEOUT_MS),
    });
    return slackTokenStillWorks(response.status, await bodyOf(response));
  } catch (error: unknown) {
    log.warn('slack auth.test after a revoke could not be made; the revoke stands as answered', {
      reason: safeFailureMessage(error, token, 'no detail'),
    });
    return false;
  }
}

/**
 * Ask Slack to revoke a configuration token (`auth.revoke`), which ends that token alone and never
 * its refresh token (the real-vendor walk, R41V-10), and read the answer, keeping Slack's word for
 * a token it had already ended. Slack's answer is then checked with `auth.test`: on the walk a
 * token Day0 recorded as revoked still worked at Slack, so a token Slack still accepts is a failed
 * revoke whatever `auth.revoke` answered.
 *
 * @param token - The configuration token, which is also the call's bearer.
 * @param transport - The transport; the platform's `fetch` by default.
 */
export async function revokeSlackConfigurationToken(
  token: string,
  transport: RevocationFetch = fetch,
): Promise<SlackRevocationAnswer> {
  let said = 'that the token no longer works';
  const answer = await sendRevocation({
    request: slackTokenRevocation(token),
    token,
    vendor: 'Slack',
    read: (status: number, body: unknown): RevocationAnswer => {
      const error =
        typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
      if (typeof error === 'string') said = safeFailureMessage(new Error(error), token, error);
      return readSlackAnswer('auth.revoke', status, body);
    },
    fetch: transport,
  });
  if (answer.kind !== 'revoked' && answer.kind !== 'gone') return answer;
  if (await stillWorks(token, transport)) {
    const answered = answer.kind === 'revoked' ? 'revoked' : said;
    return {
      kind: 'refused',
      words: `Slack answered ${answered} to auth.revoke, yet still accepted the token at auth.test`,
    };
  }
  return answer.kind === 'gone' ? { kind: 'gone', error: said } : answer;
}

/**
 * The ledger's outcome for Slack's answer to `auth.revoke`: a token Slack revoked now is `done`,
 * one it had already ended (`token_revoked`, `invalid_auth` and the like) `already-revoked` with
 * Slack's word, so the ledger tells a revoke from a no-op (R41V-10); anything else `failed`.
 *
 * @param answer - Slack's answer, from {@link revokeSlackConfigurationToken}.
 */
export function slackRevocationOutcome(
  answer: SlackRevocationAnswer,
):
  | { readonly outcome: 'done' }
  | { readonly outcome: 'already-revoked' | 'failed'; readonly reason: string } {
  switch (answer.kind) {
    case 'revoked':
      return { outcome: 'done' };
    case 'gone':
      return { outcome: 'already-revoked', reason: `Slack answered ${answer.error}` };
    case 'retry':
    case 'refused':
      return { outcome: 'failed', reason: answer.words };
    default: {
      const unknown: never = answer;
      throw new Error(`unhandled revocation answer ${String(unknown)}`);
    }
  }
}
