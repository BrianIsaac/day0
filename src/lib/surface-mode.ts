import { customerOidcIssuer } from './customer-oidc';
import { HOSTED_DEMO_PLATFORM, presentHostedMarkers } from './hosted-markers';

export type SurfaceMode = 'mock' | 'real';

/**
 * Where a deployment runs, which decides what may turn real mode on.
 *
 * - `local-dev`: an operator's machine under `next dev`, signed in by the
 *   local key (`NEXT_PUBLIC_DEV_NO_AUTH=true`). The default, so every
 *   installation from before the profile existed reads as it always did.
 * - `customer-local`: a customer's own machine, typically under `next start`,
 *   where people sign in through the customer's OIDC issuer (A7). The local
 *   key may be on as well; the issuer is what the profile requires.
 */
export const DEPLOYMENT_PROFILES = ['local-dev', 'customer-local'] as const;

/** One of {@link DEPLOYMENT_PROFILES}. */
export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number];

type EnvValues = Partial<Record<string, string>>;

/**
 * Read `DAY0_PROFILE`.
 *
 * @param values - Environment values to inspect.
 * @returns The profile, `local-dev` when unset.
 * @throws Error when the value names no profile.
 */
export function resolveDeploymentProfile(values: EnvValues = process.env): DeploymentProfile {
  const profile = values.DAY0_PROFILE?.trim() || 'local-dev';
  const known = DEPLOYMENT_PROFILES.find((candidate) => candidate === profile);
  if (!known) throw new Error(`DAY0_PROFILE must be ${DEPLOYMENT_PROFILES.join(' or ')}.`);
  return known;
}

/** Why real mode may not run under this profile and environment, or undefined when it may. */
function realModeRefusal(profile: DeploymentProfile, values: EnvValues): string | undefined {
  const read = (name: string): string | undefined => values[name];
  const onHostedDemo = presentHostedMarkers(read, [HOSTED_DEMO_PLATFORM]);
  switch (profile) {
    case 'local-dev':
      if (
        values.NEXT_PUBLIC_DEV_NO_AUTH !== 'true' ||
        values.NODE_ENV !== 'development' ||
        onHostedDemo.length > 0
      ) {
        return (
          'DAY0_SURFACE_MODE=real is restricted to local no-auth development, or to ' +
          'DAY0_PROFILE=customer-local with the customer issuer configured.'
        );
      }
      return undefined;
    case 'customer-local':
      if (onHostedDemo.length > 0) {
        return (
          'DAY0_SURFACE_MODE=real is refused on the platform the hosted demo runs on ' +
          `(${onHostedDemo.join(', ')}): the hosted demo stays in mock mode.`
        );
      }
      if (!customerOidcIssuer(read)) {
        return (
          'DAY0_PROFILE=customer-local runs real mode for people the customer issuer signs in, ' +
          'and DAY0_OIDC_ISSUER is not set.'
        );
      }
      return undefined;
  }
}

/**
 * Resolve and enforce the deployment-only surface mode.
 *
 * Real mode makes the deployment fetch, clone and write to systems the caller
 * names, so it runs only where the profile says who the callers are.
 *
 * @param values - Environment values to inspect.
 * @returns The validated surface mode.
 * @throws Error when the mode or profile is unknown, or real mode is not allowed here.
 */
export function resolveSurfaceMode(values: EnvValues = process.env): SurfaceMode {
  const mode = values.DAY0_SURFACE_MODE || 'mock';
  if (mode !== 'mock' && mode !== 'real')
    throw new Error('DAY0_SURFACE_MODE must be mock or real.');
  const profile = resolveDeploymentProfile(values);
  if (mode === 'real') {
    const refusal = realModeRefusal(profile, values);
    if (refusal) throw new Error(refusal);
  }
  return mode;
}

export const SURFACE_MODE: SurfaceMode = resolveSurfaceMode();

/**
 * Refuse a local-run feature on any deployment that is not in real mode.
 *
 * The hosted mock is reachable by any signed-in user, so features that make
 * the deployment fetch, clone or classify caller-chosen content must be
 * refused server-side rather than merely hidden by the client.
 *
 * Args:
 *   feature: Human-readable feature name for the refusal message.
 *   mode: Surface mode to check, defaulting to the deployment's mode.
 *
 * Raises:
 *   Error: If the mode is not `real`.
 */
export function assertRealMode(feature: string, mode: SurfaceMode = SURFACE_MODE): void {
  if (mode !== 'real') {
    throw new Error(
      `${feature} is a local real-mode feature; this deployment runs in ${mode} mode.`,
    );
  }
}
