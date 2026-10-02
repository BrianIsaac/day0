'use node';

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
import { safeFailureMessage } from '../src/surfaces/redact';
import { linearTokenRevocation, readLinearAnswer } from '../src/surfaces/revokers/linear';
import { oauthTokenRevocation, readOAuthRevocationAnswer } from '../src/surfaces/revokers/oauth';
import {
  callOutcome,
  revocationPlanFor,
  type RevocationCall,
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
 * count it and schedule its successor (`sourceRevocation.beginAttempt`), open what the call needs
 * through the internal-only path that admits a held row, make the calls the plan names, and
 * record the answer (`sourceRevocation.recordAttempt`). The tokens live only inside this action
 * and are never logged; a failure's words are the vendor's, with any token taken out.
 */

/** How long one vendor call may take. */
const VENDOR_CALL_TIMEOUT_MS = 30_000;

/** The secrets one attempt opened, by role. */
interface Opened {
  readonly token: string;
  readonly refreshTokens: readonly string[];
  readonly clientSecret?: string;
  readonly configurationToken?: string;
  readonly connectionSecret?: string;
}

/** What a call answered, and the outcome it means when it is done. */
interface CallAnswer {
  readonly answer: RevocationAnswer;
  readonly done: Extract<AttemptResult, { kind: 'final' }>['outcome'];
}

/**
 * Open a held or live row for the call.
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

/** Open every secret the attempt needs, the held token first. */
async function openAll(ctx: ActionCtx, job: RevocationJob, plan: AttemptPlan): Promise<Opened> {
  const token = await open(ctx, job.credentialId);
  const refreshTokens = await Promise.all(
    plan.refreshCredentialIds.map(async (id) => await open(ctx, id)),
  );
  const optional = async (id: Id<'credentials'> | undefined): Promise<string | undefined> =>
    id === undefined ? undefined : await open(ctx, id);
  const [clientSecret, configurationToken, connectionSecret] = await Promise.all([
    optional(plan.clientSecretCredentialId),
    optional(plan.configurationTokenCredentialId),
    optional(plan.connectionSecretCredentialId),
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

/**
 * Send one revocation request and read its answer; a network failure asks for another attempt,
 * in words with the secrets taken out.
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
      signal: AbortSignal.timeout(VENDOR_CALL_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const host = new URL(request.url).host;
    return {
      kind: 'retry',
      words: safeFailureMessage(error, secrets[0] ?? '', `Could not reach ${host}.`, 300, secrets),
    };
  }
  return read(response.status, await bodyOf(response));
}

/** Slack's reader for one method. */
function slackReader(method: SlackRevocationMethod) {
  return (status: number, body: unknown): RevocationAnswer => readSlackAnswer(method, status, body);
}

/**
 * Make one call of a plan.
 *
 * @returns Its answer, or a refusal in Day0's words when Day0 lacks what the call needs.
 */
async function makeCall(
  call: RevocationCall,
  token: string,
  opened: Opened,
  plan: AttemptPlan,
): Promise<RevocationAnswer> {
  const secrets = [
    token,
    ...opened.refreshTokens,
    opened.clientSecret,
    opened.configurationToken,
    opened.connectionSecret,
  ].filter((secret): secret is string => secret !== undefined);
  switch (call.kind) {
    case 'slack-revoke-token':
      return await send(slackTokenRevocation(token), slackReader('auth.revoke'), secrets);
    case 'slack-delete-app':
      if (opened.configurationToken === undefined) {
        return { kind: 'refused', words: 'Day0 holds no configuration token to delete the app.' };
      }
      return await send(
        slackAppDeletion(opened.configurationToken, call.appId),
        slackReader('apps.manifest.delete'),
        secrets,
      );
    case 'slack-uninstall-app':
      if (opened.clientSecret === undefined) {
        return { kind: 'refused', words: "Day0 no longer holds the app's client secret." };
      }
      return await send(
        slackAppUninstall({ token, clientId: call.clientId, clientSecret: opened.clientSecret }),
        slackReader('apps.uninstall'),
        secrets,
      );
    case 'linear-revoke':
      return await send(linearTokenRevocation(token, call.hint), readLinearAnswer, secrets);
    case 'oauth-revoke': {
      const clientId = plan.connectionClientId ?? call.clientId;
      const vendor = new URL(call.endpoint).host;
      return await send(
        oauthTokenRevocation({
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
        }),
        (status, body) => readOAuthRevocationAnswer(vendor, status, body),
        secrets,
      );
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
): Promise<AttemptResult> {
  const refusals: string[] = [];
  for (const call of calls) {
    const answer: CallAnswer = {
      answer: await makeCall(call, token, opened, plan),
      done: callOutcome(call),
    };
    switch (answer.answer.kind) {
      case 'revoked':
        return { kind: 'final', outcome: answer.done };
      case 'gone':
        return { kind: 'final', outcome: 'already-gone' };
      case 'retry':
        return { kind: 'failure', words: answer.answer.words, permanent: false };
      case 'refused':
        refusals.push(answer.answer.words);
        break;
    }
  }
  return { kind: 'failure', words: refusals.join('; '), permanent: true };
}

/**
 * One attempt's calls: each refresh token of the pair first (L3: revoking the access token is not
 * documented to end it), then the held credential's plan.
 */
async function revoke(
  credential: Doc<'credentials'>,
  plan: AttemptPlan,
  opened: Opened,
): Promise<AttemptResult> {
  if (credential.issuedBy === undefined) {
    // decryptForRevocation refuses such a row before this; the plan never names one either.
    return {
      kind: 'failure',
      words: 'A pasted key is never revoked at the vendor.',
      permanent: true,
    };
  }
  const means = {
    configurationToken: opened.configurationToken !== undefined,
    clientSecret: opened.clientSecret !== undefined,
    ...(plan.revocationEndpoint !== undefined
      ? { revocationEndpoint: plan.revocationEndpoint }
      : {}),
  };
  const subject: RevocationSubject = {
    issuedBy: credential.issuedBy,
    role: 'access',
    ...(credential.holder !== undefined ? { holder: credential.holder } : {}),
  };
  for (const refreshToken of opened.refreshTokens) {
    const refreshPlan = revocationPlanFor({ ...subject, role: 'refresh' }, plan.end, means);
    if (refreshPlan.kind === 'none') continue;
    const result = await runCalls(refreshPlan.calls, refreshToken, opened, plan);
    if (result.kind === 'failure') return result;
  }
  const own = revocationPlanFor(subject, plan.end, means);
  if (own.kind === 'none') return { kind: 'final', outcome: own.outcome, reason: own.words };
  return await runCalls(own.calls, opened.token, opened, plan);
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
  if (credential === null) return;
  let result: AttemptResult;
  try {
    const opened = await openAll(ctx, job, plan);
    result = await revoke(credential, plan, opened);
  } catch (error: unknown) {
    // Opening failed (a rotated key, a row emptied under it): no attempt can open it again.
    log.warn('revocation at the vendor could not open its credential', {
      credentialId: job.credentialId,
      error: error instanceof Error ? error.message : String(error),
    });
    result = {
      kind: 'failure',
      words: 'Day0 could not open the credential to revoke it.',
      permanent: true,
    };
  }
  await ctx.runMutation(internal.sourceRevocation.recordAttempt, {
    job,
    attempt: plan.attempt,
    last: plan.last,
    result,
    ...(plan.configurationTokenCredentialId !== undefined ||
    plan.connectionSecretCredentialId !== undefined
      ? { viaConnection: plan.organisationConnectionId }
      : {}),
  });
}

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
