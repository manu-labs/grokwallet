const commit = process.env.SOURCE_COMMIT || "local";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  reactStrictMode: true,
  trailingSlash: true,
  poweredByHeader: false,
  generateBuildId: async () => commit,
  env: {
    NEXT_PUBLIC_BUILD_COMMIT: commit,
  },
};

export default nextConfig;
