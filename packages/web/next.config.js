/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@gcpoker/shared'],
  // Prevent V8 access violation crash on Windows during production build
  experimental: {
    webpackBuildWorker: false,
  },
}

module.exports = nextConfig
