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
};

export default nextConfig;
