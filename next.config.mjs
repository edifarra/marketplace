/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["playwright-core"],
  experimental: {

    serverActions: {
      bodySizeLimit: "50mb"
    }
  }
};

export default nextConfig;
