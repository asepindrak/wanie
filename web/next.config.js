const packageJson = require("../package.json");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_OPENWA_VERSION: packageJson.version,
  },
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
