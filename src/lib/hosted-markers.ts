/**
 * The hosted platforms a day0 deployment could reach by accident, and the
 * environment names that give each one away.
 *
 * One list, read by every check that asks "is this running somewhere hosted":
 * the local issuer refuses every platform on it, and real mode refuses the
 * one the hosted demo runs on. Three lists used to answer that question and
 * disagreed about which names counted.
 */

/** Reads one environment name; may throw for a name the runtime has no value for. */
export type EnvReader = (name: string) => string | undefined;

/** Every hosted-platform marker, each with the platform that sets it. */
export const HOSTED_PLATFORM_MARKERS = [
  { name: 'VERCEL', platform: 'vercel' },
  { name: 'VERCEL_ENV', platform: 'vercel' },
  // The one marker Next inlines into the browser bundle.
  { name: 'NEXT_PUBLIC_VERCEL_ENV', platform: 'vercel' },
  { name: 'AWS_REGION', platform: 'aws' },
  { name: 'AWS_EXECUTION_ENV', platform: 'aws' },
  { name: 'KUBERNETES_SERVICE_HOST', platform: 'kubernetes' },
  { name: 'FLY_APP_NAME', platform: 'fly' },
  { name: 'RENDER', platform: 'render' },
  { name: 'DYNO', platform: 'heroku' },
] as const;

/** A platform some marker belongs to. */
export type HostedPlatform = (typeof HOSTED_PLATFORM_MARKERS)[number]['platform'];

/** The platform the hosted demo runs on, where real mode is never allowed (Q16). */
export const HOSTED_DEMO_PLATFORM: HostedPlatform = 'vercel';

/**
 * The markers this environment carries, in list order.
 *
 * @param read - Reads one name; a reader that throws for an unset name counts it as absent.
 * @param platforms - Only markers of these platforms; every platform when omitted.
 * @returns The names that are set to a non-empty value.
 */
export function presentHostedMarkers(
  read: EnvReader,
  platforms?: readonly HostedPlatform[],
): string[] {
  return HOSTED_PLATFORM_MARKERS.filter(
    (marker) => !platforms || platforms.includes(marker.platform),
  )
    .filter((marker) => {
      try {
        return !!read(marker.name);
      } catch {
        // The Convex runtime throws for a name the deployment has no value for.
        return false;
      }
    })
    .map((marker) => marker.name);
}
