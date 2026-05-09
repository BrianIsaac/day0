/**
 * Convex auth bridge to Clerk.
 *
 * To wire up:
 *   1. In your Clerk dashboard, create a JWT template named "convex".
 *   2. Copy the Issuer URL from that template.
 *   3. Set `CLERK_JWT_ISSUER_DOMAIN` in `.env.local` to that URL (no trailing slash).
 *   4. Run `npx convex env set CLERK_JWT_ISSUER_DOMAIN <url>` so the deployment sees it too.
 *
 * After that, `ctx.auth.getUserIdentity()` returns the signed-in Clerk user.
 */
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN ?? 'https://example.clerk.accounts.dev',
      applicationID: 'convex',
    },
  ],
};
