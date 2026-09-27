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

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The demo is recorded from `next dev`; the development badge was in every frame.
  devIndicators: false,
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
