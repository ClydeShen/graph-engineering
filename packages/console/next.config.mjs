/** @type {import('next').NextConfig} */
const nextConfig = {
  // Console is a pure Gateway client (Shell owns no state). The gateway URL
  // is baked at build/start via NEXT_PUBLIC_GATEWAY_URL; same-origin /v1
  // requests are proxied so the dev console works against a local gateway.
  async rewrites() {
    const gateway = process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://127.0.0.1:4000';
    return [{ source: '/v1/:path*', destination: `${gateway}/v1/:path*` }];
  },
};

export default nextConfig;
