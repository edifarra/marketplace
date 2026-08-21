/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ["playwright-core"],
    serverActions: {
      bodySizeLimit: "50mb"
    }
  }
};

export default nextConfig;
