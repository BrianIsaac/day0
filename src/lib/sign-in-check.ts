import { SIGN_IN_REFUSAL_WORDS, signInRefusal } from './customer-oidc';
import { providerOfIssuer } from './customer-oidc-presets';
import { seal, unseal } from './customer-session';

/**
 * The live sign-in check (`pnpm check:sign-in`), the half the app's server
 * runs: a one-time ticket the check mints with the session secret, and the
 * verdict on each claim that matters in the ID token a test person signs in
 * with. The callback, given a ticket, reports these instead of signing anyone
 * in, and posts the report back to the check on this machine.
 */

/** How one claim reads: as it must, worth saying, or a gap. */
export type VerdictStatus = 'ok' | 'warn' | 'gap';

/** One claim's verdict. */
export interface ClaimVerdict {
  readonly claim: string;
  /** The claim's value as shown to the operator, or `(absent)`. */
  readonly value: string;
  readonly status: VerdictStatus;
  readonly note: string;
}

/** What the claims are judged against: the install's own settings. */
export interface ClaimCheckInput {
  readonly issuer: string;
  readonly clientId: string;
  readonly allowedDomains: readonly string[];
  /** `DAY0_OIDC_EMAIL_TRUSTED` as the deployment reads it. */
  readonly emailTrusted: boolean;
  /** Whether the issuer granted a refresh token with the ID token. */
  readonly refreshTokenGranted: boolean;
}

/** What the callback reports to the check. */
export interface SignInCheckReport {
  readonly version: 1;
  readonly checkId: string;
  readonly checkedAt: number;
  readonly verdicts: readonly ClaimVerdict[];
  /** What `config.whoAmI` answered with the token: the owner key, or why there is none. */
  readonly whoAmI:
    | { readonly status: 'ok'; readonly ownerKey: string; readonly verifiedAddress: string | null }
    | { readonly status: 'gap'; readonly detail: string };
}

/** The one-time ticket the check hands the login route. */
export interface CheckTicket {
  readonly checkId: string;
  /** Where on this machine the callback posts the report. */
  readonly reportTo: string;
  readonly expiresAt: number;
}

/** How long a check's link may wait for the test person to sign in. */
export const CHECK_TICKET_SECONDS = 10 * 60;

const ABSENT = '(absent)';

/** A claim's value as text for the operator. */
function shown(value: unknown): string {
  if (value === undefined) return ABSENT;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function verdict(claim: string, value: unknown, status: VerdictStatus, note: string): ClaimVerdict {
  return { claim, value: shown(value), status, note };
}

/** The address verdict: `email_verified`, else Entra's `xms_edov`, else the trust flag. */
function addressVerdict(
  claims: Readonly<Record<string, unknown>>,
  input: ClaimCheckInput,
): ClaimVerdict {
  const entra = providerOfIssuer(input.issuer) === 'entra';
  const unverified =
    'Without a verified address the person can sign in and cannot deploy an employee or take one on.';
  if (claims.email_verified !== undefined) {
    return claims.email_verified === true
      ? verdict('email_verified', true, 'ok', 'The address is verified.')
      : verdict(
          'email_verified',
          claims.email_verified,
          'gap',
          `The issuer says it is not. ${unverified}`,
        );
  }
  if (claims.xms_edov !== undefined || entra) {
    if (claims.xms_edov === true) {
      return verdict('xms_edov', true, 'ok', "The address's domain owner is verified (Entra).");
    }
    if (claims.xms_edov === undefined && input.emailTrusted) {
      return verdict(
        'xms_edov',
        undefined,
        'warn',
        'Believed because DAY0_OIDC_EMAIL_TRUSTED=true. Adding the xms_edov optional claim is better.',
      );
    }
    return verdict(
      'xms_edov',
      claims.xms_edov,
      'gap',
      `${unverified} Add the xms_edov optional claim to the ID token (docs/running/sign-in-entra.md).`,
    );
  }
  return input.emailTrusted
    ? verdict(
        'email_verified',
        undefined,
        'warn',
        'Believed because DAY0_OIDC_EMAIL_TRUSTED=true: keep it only if the issuer controls every address.',
      )
    : verdict(
        'email_verified',
        undefined,
        'gap',
        `${unverified} Ask the issuer to send email_verified.`,
      );
}

/** The provider's own claim: Google's `hd`, Entra's `tid`; none for the others. */
function providerVerdict(
  claims: Readonly<Record<string, unknown>>,
  input: ClaimCheckInput,
): ClaimVerdict | undefined {
  const provider = providerOfIssuer(input.issuer);
  switch (provider) {
    case 'google': {
      const workspace = typeof claims.hd === 'string' ? claims.hd.toLowerCase() : '';
      return input.allowedDomains.includes(workspace)
        ? verdict('hd', claims.hd, 'ok', 'The account belongs to an allowed Google Workspace.')
        : verdict('hd', claims.hd, 'gap', SIGN_IN_REFUSAL_WORDS['foreign-workspace']);
    }
    case 'entra': {
      const tenant = /login\.microsoftonline\.com\/([^/]+)\/v2\.0$/.exec(input.issuer)?.[1];
      return claims.tid === tenant
        ? verdict('tid', claims.tid, 'ok', "The token is from the customer's own tenant.")
        : verdict(
            'tid',
            claims.tid,
            'gap',
            `The token's tenant is not ${tenant ?? 'the issuer’s'}.`,
          );
    }
    case 'okta':
    case 'oidc':
      return undefined;
    default: {
      const unknown: never = provider;
      throw new Error(`unhandled provider ${String(unknown)}`);
    }
  }
}

/**
 * The verdict on each claim that matters, in a fixed order: `iss`, `aud`,
 * `sub`, `email`, the verified-address claim, the provider's own (`hd`,
 * `tid`), the token's lifetime and whether a refresh token came with it.
 *
 * @param claims - The verified ID token's claims.
 * @param input - The install's own settings.
 */
export function claimVerdicts(
  claims: Readonly<Record<string, unknown>>,
  input: ClaimCheckInput,
): ClaimVerdict[] {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const refusal = signInRefusal(
    { email: claims.email, hd: claims.hd },
    input.allowedDomains,
    // The domain rule's own Workspace check is the `hd` line's; this line is the address's.
    'https://issuer.invalid',
  );
  const lifetime =
    typeof claims.exp === 'number' && typeof claims.iat === 'number'
      ? `${Math.round((claims.exp - claims.iat) / 60)} minutes`
      : undefined;
  const provider = providerVerdict(claims, input);
  return [
    claims.iss === input.issuer
      ? verdict('iss', claims.iss, 'ok', 'Equal to DAY0_OIDC_ISSUER byte for byte.')
      : verdict(
          'iss',
          claims.iss,
          'gap',
          `Not ${input.issuer} byte for byte: every token would be refused.`,
        ),
    audiences.includes(input.clientId)
      ? verdict('aud', claims.aud, 'ok', 'Names the client id (DAY0_OIDC_AUDIENCE).')
      : verdict(
          'aud',
          claims.aud,
          'gap',
          `Does not name ${input.clientId}: the deployment refuses it.`,
        ),
    typeof claims.sub === 'string' && claims.sub !== ''
      ? verdict('sub', claims.sub, 'ok', 'The person, as the owner key names them with the issuer.')
      : verdict('sub', claims.sub, 'gap', 'No subject: nobody can own an employee.'),
    refusal === undefined
      ? verdict('email', claims.email, 'ok', 'In an allowed domain.')
      : verdict('email', claims.email, 'gap', SIGN_IN_REFUSAL_WORDS[refusal]),
    addressVerdict(claims, input),
    ...(provider ? [provider] : []),
    lifetime === undefined
      ? verdict('exp', claims.exp, 'gap', 'The token carries no lifetime.')
      : { claim: 'exp', value: lifetime, status: 'ok', note: 'Refreshed in its last minutes.' },
    input.refreshTokenGranted
      ? verdict('refresh_token', 'granted', 'ok', 'The session outlives the ID token.')
      : verdict(
          'refresh_token',
          undefined,
          'gap',
          providerOfIssuer(input.issuer) === 'google'
            ? 'Google granted none: it needs access_type=offline and prompt=consent, which the preset sends; check the consent screen.'
            : 'None granted: the session ends with the ID token. Grant offline_access to the app.',
        ),
  ];
}

/**
 * Seal a check ticket with the session secret.
 *
 * @param secret - `DAY0_SESSION_SECRET`.
 * @param ticket - The ticket.
 */
export async function sealCheckTicket(secret: string, ticket: CheckTicket): Promise<string> {
  return seal(secret, 'sign-in-check', ticket);
}

/** Whether an address is a listener on this machine: the only place a report goes. */
function onThisMachine(address: string): boolean {
  try {
    const url = new URL(address);
    return (
      url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    );
  } catch {
    // Not a URL: not this machine's listener.
    return false;
  }
}

/**
 * The live ticket a check link carries, or undefined: not sealed with this
 * secret, expired, or naming a report address off this machine (a ticket is
 * never a way to make the server post somewhere else).
 *
 * @param secret - `DAY0_SESSION_SECRET`.
 * @param sealed - The ticket as the link carried it.
 * @param now - The current time in milliseconds.
 */
export async function openCheckTicket(
  secret: string | undefined,
  sealed: string | undefined,
  now: number = Date.now(),
): Promise<CheckTicket | undefined> {
  const value = await unseal(secret, 'sign-in-check', sealed);
  if (typeof value !== 'object' || value === null) return undefined;
  const { checkId, reportTo, expiresAt } = value as Record<string, unknown>;
  if (
    typeof checkId !== 'string' ||
    typeof reportTo !== 'string' ||
    typeof expiresAt !== 'number' ||
    expiresAt <= now ||
    !onThisMachine(reportTo)
  ) {
    return undefined;
  }
  return { checkId, reportTo, expiresAt };
}
