/**
 * Sent with every response. The dashboard carries approve, reject and
 * autonomy controls, so no other page may frame it (`X-Frame-Options` for
 * older browsers, `frame-ancestors` for the rest); a response is never
 * re-typed by sniffing; a cross-origin request learns the origin and not the
 * path or query it came from; and of the powerful features only the
 * microphone is allowed, to the app itself, for the voice 1:1.
 */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=(self)' },
];

/**
 * How the app names itself to `pnpm check:setup` (wave 17, 17-P): a customer's reverse proxy can
 * answer at the public address and forward to something else (its default site, the backend's
 * port), and the check reads this to tell. It says nothing the sign-in page does not.
 */
const appMarker = { key: 'X-Day0', value: 'app' };

/**
 * The routes that stream a reply as the model writes it: the 1:1 and the Discuss talk. nginx
 * buffers an upstream's answer unless this header says otherwise, and a buffered reply arrives
 * whole at its end (docs/running/proxy.md, "The app").
 */
const streamedRoutes = ['/api/voice/chat', '/api/reorientation/chat'];
const unbuffered = [{ key: 'X-Accel-Buffering', value: 'no' }];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The demo is recorded from `next dev`; the development badge was in every frame.
  devIndicators: false,
  experimental: {
    // The page transition (`app/MainTransition.tsx`); 16.2.6 reads the key in its schema only.
    viewTransition: true,
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },
  // The walkthrough moved from `/demo` (N29); the README and older links keep working.
  async redirects() {
    return [{ source: '/demo', destination: '/walkthrough', permanent: true }];
  },
  async headers() {
    return [
      { source: '/:path*', headers: [...securityHeaders, appMarker] },
      ...streamedRoutes.map((source) => ({ source, headers: unbuffered })),
    ];
  },
};

export default nextConfig;
