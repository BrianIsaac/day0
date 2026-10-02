'use node';

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  revocationJobValidator,
  type AttemptPlan,
  type AttemptResult,
  type RevocationJob,
} from './sourceRevocation';
import { log } from '../src/lib/logger';
import { TransientProviderError } from '../src/lib/transport-error';
import {
  forgetNangoConnection,
  NangoRefusal,
  nangoConfigFrom,
  parseNangoLocation,
} from '../src/surfaces/nango-token-store';
import { safeFailureMessage } from '../src/surfaces/redact';
import { linearTokenRevocation, readLinearAnswer } from '../src/surfaces/revokers/linear';
import { oauthTokenRevocation, readOAuthRevocationAnswer } from '../src/surfaces/revokers/oauth';
import {
  callOutcome,
  revocationPlanFor,
  type RevocationCall,
  type RevocationMeans,
  type RevocationPlan,
  type RevocationSubject,
} from '../src/surfaces/revokers/plan';
import {
  readSlackAnswer,
  slackAppDeletion,
  slackAppUninstall,
  slackTokenRevocation,
  type SlackRevocationMethod,
} from '../src/surfaces/revokers/slack';
import type { RevocationAnswer, RevocationRequest } from '../src/surfaces/revokers/types';

/*
 * Revocation at the vendor, the call (wave 11, 11-AR; the access plan, section 4.4). One attempt:
 * count it and schedule its successor (`sourceRevocation.beginAttempt`), plan the calls, open
 * only what those calls need through the internal-only path that admits a held row, make them,
 * and record the answer (`sourceRevocation.recordAttempt`). The tokens live only inside this
 * action and are never logged; a failure's words are the vendor's, bounded, with every token
 * taken out.
 */

/** How long one vendor call may take. */
const VENDOR_CALL_TIMEOUT_MS = 30_000;

/** The longest words a failure keeps, on the row and on the record. */
const WORDS_LIMIT = 300;

/** The secrets one attempt opened, each only where a planned call needs it. */
interface Opened {
  readonly token: string;
  readonly refreshTokens: readonly string[];
  readonly clientSecret?: string;
  readonly configurationToken?: string;
  readonly connectionSecret?: string;
}

/** One call's answer, and whether the call was made with the organisation connection's secret. */
interface CallAnswer {
  readonly answer: RevocationAnswer;
  readonly viaConnection: boolean;
}

/** What one attempt found, and whether a call made with the connection's secret was sent. */
interface AttemptOutcome {
  readonly result: AttemptResult;
  readonly viaConnection: boolean;
}

/** The plans of one attempt: the held credential's, and each refresh token's of its pair. */
interface AttemptPlans {
  readonly own: RevocationPlan;
  readonly refreshes: readonly RevocationPlan[];
}

/**
 * Open a held or live row for the call: a held row through the path that admits it, a live one
 * (IT's configuration token, the connection's client secret) through the ordinary decrypt.
 *
 * @throws Error when the row cannot be opened.
 */
async function open(ctx: ActionCtx, credentialId: Id<'credentials'>): Promise<string> {
  const row: Doc<'credentials'> | null = await ctx.runQuery(internal.credentials.getInternal, {
    credentialId,
  });
  return row?.sourceRevocation?.state === 'pending'
    ? await ctx.runAction(internal.credentials.decryptForRevocation, { credentialId })
    : await ctx.runAction(internal.credentials.decrypt, { credentialId });
}

/** Every call the attempt's plans name. */
function plannedCalls(plans: AttemptPlans): RevocationCall[] {
  return [plans.own, ...plans.refreshes].flatMap((plan) =>
    plan.kind === 'call' ? [...plan.calls] : [],
  );
}

/**
 * Open the held token and only what the planned calls need: the refresh tokens a call revokes,
 * IT's configuration token for an app deletion, the app's secret for an uninstall, and the
 * connection's client secret for an RFC 7009 revoke (through the path that admits it revoked, for
 * the end the connection's own revoke made).
 *
 * @throws Error when a needed row cannot be opened.
 */
async function openNeeded(
  ctx: ActionCtx,
  job: RevocationJob,
  plan: AttemptPlan,
  plans: AttemptPlans,
): Promise<Opened> {
  const calls = plannedCalls(plans);
  const needs = (kind: RevocationCall['kind']): boolean => calls.some((call) => call.kind === kind);
  const optional = async (
    id: Id<'credentials'> | undefined,
    needed: boolean,
  ): Promise<string | undefined> => (id === undefined || !needed ? undefined : await open(ctx, id));
  const refreshIds = plans.refreshes.some((refresh) => refresh.kind === 'call')
    ? plan.refreshCredentialIds
    : [];
  const [token, refreshTokens, clientSecret, configurationToken, connectionSecret] =
    await Promise.all([
      open(ctx, job.credentialId),
      Promise.all(refreshIds.map(async (id) => await open(ctx, id))),
      optional(plan.clientSecretCredentialId, needs('slack-uninstall-app')),
      optional(plan.configurationTokenCredentialId, needs('slack-delete-app')),
      plan.connectionSecretRevoked === true && needs('oauth-revoke')
        ? ctx.runAction(internal.credentials.decryptConnectionSecretForRevocation, {
            credentialId: job.credentialId,
          })
        : optional(plan.connectionSecretCredentialId, needs('oauth-revoke')),
    ]);
  return {
    token,
    refreshTokens,
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    ...(configurationToken !== undefined ? { configurationToken } : {}),
    ...(connectionSecret !== undefined ? { connectionSecret } : {}),
  };
}

/** Read a response body as JSON where it is, else as text. */
async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON: a proxy's or the vendor's own error page; the status and text are what it says.
    return text;
  }
}

/** Every secret an attempt opened, for the words to be cleaned of. */
function secretsOf(opened: Opened): string[] {
  return [
    opened.token,
    ...opened.refreshTokens,
    opened.clientSecret,
    opened.configurationToken,
    opened.connectionSecret,
  ].filter((secret): secret is string => secret !== undefined && secret !== '');
}

/** Words a vendor or a failure gave, as one bounded line with no secret in it. */
function cleanWords(words: string, secrets: readonly string[]): string {
  return safeFailureMessage(new Error(words), secrets[0] ?? '', words, WORDS_LIMIT, secrets);
}

/** An answer whose words are cleaned of the attempt's secrets. */
function cleanAnswer(answer: RevocationAnswer, secrets: readonly string[]): RevocationAnswer {
  switch (answer.kind) {
    case 'revoked':
    case 'gone':
      return answer;
    case 'retry':
    case 'refused':
      return { kind: answer.kind, words: cleanWords(answer.words, secrets) };
  }
}

/**
 * Send one revocation request and read its answer. A redirect is never followed, so a token in the
 * body never reaches another address: its 3xx answer is a refusal; a network failure asks for
 * another attempt.
 */
async function send(
  request: RevocationRequest,
  read: (status: number, body: unknown) => RevocationAnswer,
  secrets: readonly string[],
): Promise<RevocationAnswer> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      // A redirect comes back as its own 3xx answer, which the readers refuse: following it would
      // send the token in the body to another address.
      redirect: 'manual',
      signal: AbortSignal.timeout(VENDOR_CALL_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const host = new URL(request.url).host;
    return {
      kind: 'retry',
      words: safeFailureMessage(
        error,
        secrets[0] ?? '',
        `Could not reach ${host}.`,
        WORDS_LIMIT,
        secrets,
      ),
    };
  }
  return cleanAnswer(read(response.status, await bodyOf(response)), secrets);
}

/** Slack's reader for one method. */
function slackReader(method: SlackRevocationMethod) {
  return (status: number, body: unknown): RevocationAnswer => readSlackAnswer(method, status, body);
}

/**
 * Build an RFC 7009 request, refusing in Day0's words an endpoint the builder refuses.
 *
 * @returns The request, or the refusal.
 */
function oauthRequest(
  call: Extract<RevocationCall, { kind: 'oauth-revoke' }>,
  token: string,
  plan: AttemptPlan,
  opened: Opened,
): RevocationRequest | { readonly refused: string } {
  const clientId = plan.connectionClientId ?? call.clientId;
  try {
    return oauthTokenRevocation({
      endpoint: call.endpoint,
      token,
      hint: call.hint,
      ...(clientId !== undefined
        ? {
            client: {
              clientId,
              ...(opened.connectionSecret !== undefined
                ? { clientSecret: opened.connectionSecret }
                : {}),
            },
          }
        : {}),
    });
  } catch (error: unknown) {
    return {
      refused: `Day0 refused the revocation endpoint: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Make one call of a plan.
 *
 * @returns Its answer, or a refusal in Day0's words when Day0 lacks what the call needs, and
 *   whether the call used the organisation connection's secret.
 */
async function makeCall(
  call: RevocationCall,
  token: string,
  opened: Opened,
  plan: AttemptPlan,
): Promise<CallAnswer> {
  const secrets = secretsOf(opened);
  const direct = (answer: RevocationAnswer): CallAnswer => ({ answer, viaConnection: false });
  switch (call.kind) {
    case 'slack-revoke-token':
      return direct(await send(slackTokenRevocation(token), slackReader('auth.revoke'), secrets));
    case 'slack-delete-app':
      if (opened.configurationToken === undefined) {
        return direct({
          kind: 'refused',
          words: 'Day0 holds no configuration token to delete the app.',
        });
      }
      return {
        answer: await send(
          slackAppDeletion(opened.configurationToken, call.appId),
          slackReader('apps.manifest.delete'),
          secrets,
        ),
        viaConnection: true,
      };
    case 'slack-uninstall-app':
      if (opened.clientSecret === undefined) {
        return direct({ kind: 'refused', words: "Day0 no longer holds the app's client secret." });
      }
      return direct(
        await send(
          slackAppUninstall({ token, clientId: call.clientId, clientSecret: opened.clientSecret }),
          slackReader('apps.uninstall'),
          secrets,
        ),
      );
    case 'linear-revoke':
      return direct(await send(linearTokenRevocation(token, call.hint), readLinearAnswer, secrets));
    case 'oauth-revoke': {
      const request = oauthRequest(call, token, plan, opened);
      if ('refused' in request) return direct({ kind: 'refused', words: request.refused });
      const vendor = new URL(call.endpoint).host;
      return {
        answer: await send(
          request,
          (status, body) => readOAuthRevocationAnswer(vendor, status, body),
          secrets,
        ),
        viaConnection: opened.connectionSecret !== undefined,
      };
    }
  }
}

/**
 * Make a plan's calls in order of preference: the first the vendor does ends it; a failure
 * another attempt may pass ends the attempt there, so a later attempt tries the preferred call
 * again; a refusal moves to the next call; the refusals of every call are the failure's words.
 */
async function runCalls(
  calls: readonly RevocationCall[],
  token: string,
  opened: Opened,
  plan: AttemptPlan,
): Promise<AttemptOutcome> {
  const refusals: string[] = [];
  let viaConnection = false;
  for (const call of calls) {
    const made = await makeCall(call, token, opened, plan);
    viaConnection = viaConnection || made.viaConnection;
    const { answer } = made;
    switch (answer.kind) {
      case 'revoked':
        return { result: { kind: 'final', outcome: callOutcome(call) }, viaConnection };
      case 'gone':
        return { result: { kind: 'final', outcome: 'already-gone' }, viaConnection };
      case 'retry':
        return {
          result: { kind: 'failure', words: answer.words, permanent: false },
          viaConnection,
        };
      case 'refused':
        refusals.push(answer.words);
        break;
      default: {
        const unknown: never = answer;
        throw new Error(`unhandled revocation answer ${String(unknown)}`);
      }
    }
  }
  return {
    result: {
      kind: 'failure',
      words: cleanWords(refusals.join('; '), secretsOf(opened)),
      permanent: true,
    },
    viaConnection,
  };
}

/**
 * The attempt's plans: the held credential's, by its own role (a refresh token held alone is
 * revoked as one), and, for an access token, each refresh token of its pair (L3: revoking the
 * access token is not documented to end it).
 */
function attemptPlans(subject: RevocationSubject, plan: AttemptPlan): AttemptPlans {
  const means: RevocationMeans = {
    configurationToken: plan.configurationTokenCredentialId !== undefined,
    clientSecret: plan.clientSecretCredentialId !== undefined,
    ...(plan.revocationEndpoint !== undefined
      ? { revocationEndpoint: plan.revocationEndpoint }
      : {}),
  };
  return {
    own: revocationPlanFor(subject, plan.end, means),
    refreshes: plan.refreshCredentialIds.map(() =>
      revocationPlanFor({ ...subject, role: 'refresh' }, plan.end, means),
    ),
  };
}

/** One attempt's calls: each refresh token of the pair first, then the held credential's plan. */
async function revoke(
  plans: AttemptPlans,
  plan: AttemptPlan,
  opened: Opened,
): Promise<AttemptOutcome> {
  let viaConnection = false;
  for (const [index, refreshPlan] of plans.refreshes.entries()) {
    const refreshToken = opened.refreshTokens[index];
    if (refreshPlan.kind === 'none' || refreshToken === undefined) continue;
    const made = await runCalls(refreshPlan.calls, refreshToken, opened, plan);
    viaConnection = viaConnection || made.viaConnection;
    if (made.result.kind === 'failure') return { result: made.result, viaConnection };
  }
  if (plans.own.kind === 'none') {
    return {
      result: { kind: 'final', outcome: plans.own.outcome, reason: plans.own.words },
      viaConnection,
    };
  }
  const own = await runCalls(plans.own.calls, opened.token, opened, plan);
  return { result: own.result, viaConnection: viaConnection || own.viaConnection };
}

/**
 * Make one attempt at a held credential's revocation at the vendor.
 *
 * @param ctx - The action's context.
 * @param job - The held credentials and the card they ended.
 */
async function runAttempt(ctx: ActionCtx, job: RevocationJob): Promise<void> {
  const plan: AttemptPlan | null = await ctx.runMutation(
    internal.sourceRevocation.beginAttempt,
    job,
  );
  if (plan === null) return;
  const credential: Doc<'credentials'> | null = await ctx.runQuery(
    internal.credentials.getInternal,
    { credentialId: job.credentialId },
  );
  // beginAttempt admits only a held row Day0 obtained; a row gone since has nothing to revoke.
  if (credential?.issuedBy === undefined) return;
  const plans = attemptPlans(
    {
      issuedBy: credential.issuedBy,
      role: job.primaryIsRefresh === true ? 'refresh' : 'access',
    },
    plan,
  );
  let opened: Opened;
  try {
    opened = await openNeeded(ctx, job, plan, plans);
  } catch (error: unknown) {
    // Opening failed (a rotated key, a row emptied under it): no later attempt opens it either.
    log.warn('revocation at the vendor could not open its credential', {
      credentialId: job.credentialId,
      error: error instanceof Error ? error.message : String(error),
    });
    await ctx.runMutation(internal.sourceRevocation.recordAttempt, {
      job,
      attempt: plan.attempt,
      last: plan.last,
      result: {
        kind: 'failure',
        words: 'Day0 could not open the credential to revoke it.',
        permanent: true,
      },
    });
    return;
  }
  const outcome = await revoke(plans, plan, opened);
  await ctx.runMutation(internal.sourceRevocation.recordAttempt, {
    job,
    attempt: plan.attempt,
    last: plan.last,
    result: outcome.result,
    ...(outcome.viaConnection && plan.organisationConnectionId !== undefined
      ? { viaConnection: plan.organisationConnectionId }
      : {}),
  });
}

/** How many times a token store that could not answer is asked again to forget a connection. */
const FORGET_RETRIES = 5;

/** Whether a failed forgetting may succeed later: the token store could not be reached or was busy. */
function forgetRetryable(error: unknown): boolean {
  return (
    error instanceof TransientProviderError ||
    (error instanceof NangoRefusal && error.reason === 'unavailable')
  );
}

/**
 * Ask the token store to forget the connection of a row whose access ended (11-AT; join 9 of
 * 11-AJ), so Nango neither keeps nor refreshes the token any longer, then delete the location Day0
 * kept. A store that cannot answer is asked again with a growing wait, {@link FORGET_RETRIES}
 * times; any other failure, or the retries running out, is logged and the revoked row keeps its
 * location for the operator. Nango revokes nothing at the vendor. Internal; scheduled by
 * `endAccessAtSource`.
 */
export const forgetInTokenStore = internalAction({
  args: { credentialId: v.id('credentials'), attempt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    const attempt = args.attempt ?? 0;
    try {
      const location: string = await ctx.runAction(internal.credentials.decryptTokenStoreLocation, {
        credentialId: args.credentialId,
      });
      await forgetNangoConnection(
        async (input: URL, init: RequestInit): Promise<Response> => await fetch(input, init),
        nangoConfigFrom(process.env),
        parseNangoLocation(location),
      );
    } catch (error: unknown) {
      const reason = safeFailureMessage(error, '', 'The token store could not be reached.');
      if (forgetRetryable(error) && attempt < FORGET_RETRIES) {
        log.warn('token store did not forget a connection; asking again', {
          credentialId: args.credentialId,
          attempt,
          reason,
        });
        await ctx.scheduler.runAfter(
          60_000 * 2 ** attempt,
          internal.sourceRevocationActions.forgetInTokenStore,
          { credentialId: args.credentialId, attempt: attempt + 1 },
        );
        return;
      }
      log.error('token store did not forget a connection; its location is kept', {
        credentialId: args.credentialId,
        attempt,
        reason,
      });
      return;
    }
    await ctx.runMutation(internal.credentials.forgottenInTokenStore, {
      credentialId: args.credentialId,
      now: Date.now(),
    });
  },
});

/**
 * One attempt at revoking a held credential at its vendor (the access plan, section 4.4).
 *
 * Internal; scheduled by the ending transaction (`sourceRevocation.endAccessAtSource`) and by the
 * attempt before it. Writes the attempt's count, its line and, once final, the held rows' state
 * with their ciphertext deleted.
 */
export const attempt = internalAction({
  args: revocationJobValidator,
  handler: async (ctx, job): Promise<void> => {
    await runAttempt(ctx, job);
  },
});
