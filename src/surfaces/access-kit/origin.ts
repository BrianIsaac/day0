/** A recipe value the kit cannot use; the message says which and why, never a secret. */
export class AccessKitError extends Error {}

/**
 * Day0's public origin as a vendor's registration needs it: https, no path, no trailing slash, so
 * the redirect a registration declares is the redirect the route later receives. https is Day0's
 * own rule, since codes and tokens come back on the redirect: Linear's form and Slack's manifest
 * check both accepted a plain-http redirect on the real-vendor walk (R41V-2, R41V-R3).
 *
 * @param publicUrl - The configured `DAY0_PUBLIC_URL`.
 * @param vendor - The vendor's name, for the refusal.
 * @throws AccessKitError when the value is not an absolute https URL.
 */
export function httpsOrigin(publicUrl: string, vendor: string): string {
  let parsed: URL;
  try {
    parsed = new URL(publicUrl.trim());
  } catch {
    throw new AccessKitError(
      `DAY0_PUBLIC_URL is not a URL; set it to the public origin ${vendor} redirects back to.`,
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new AccessKitError(
      `DAY0_PUBLIC_URL must be https: Day0 has ${vendor} send its codes and tokens back to an https address only.`,
    );
  }
  return parsed.origin;
}
