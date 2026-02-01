/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true, // CLI commands have different types, not used in web app
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
