/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@gcpoker/shared', '@gcpoker/engine'],
  swcMinify: false,
  experimental: {
    webpackBuildWorker: false,
  },
}

module.exports = nextConfig
