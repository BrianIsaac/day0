/** A recipe value the kit cannot use; the message says which and why, never a secret. */
export class AccessKitError extends Error {}

/**
 * Day0's public origin as a vendor's registration needs it: https, no path, no trailing slash, so
 * the redirect a registration declares is the redirect the route later receives.
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
      `DAY0_PUBLIC_URL must be https; ${vendor} refuses a plain-http redirect URL.`,
    );
  }
  return parsed.origin;
}
