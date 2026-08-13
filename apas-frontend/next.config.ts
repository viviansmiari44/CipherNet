import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 🔧 FIX: Use standalone output for better deployment on Render
  output: 'standalone',

  // 🔧 FIX: Configure server actions with timeout settings
  experimental: {
    serverActions: {
      allowedOrigins: [
        'localhost:3000',
        process.env.NEXT_PUBLIC_APP_URL?.replace('https://', '') || 'your-app.onrender.com'
      ].filter(Boolean) as string[],
      bodySizeLimit: '2mb',
    },
  },

  // 🔧 FIX: Add security headers and caching
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          { key: 'Access-Control-Allow-Origin', value: process.env.NEXT_PUBLIC_APP_URL || '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,DELETE,PATCH,POST,PUT,OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on'
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload'
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN'
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff'
          },
        ],
      },
    ];
  },

  // 🔧 FIX: Configure image optimization
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },

  // 🔧 FIX: Enable React strict mode for better error catching
  reactStrictMode: true,

  // 🔧 FIX: Disable telemetry in production
  ...(process.env.NODE_ENV === 'production' && {
    env: {
      NEXT_TELEMETRY_DISABLED: '1',
    },
  }),

  // 🔧 FIX: Configure webpack for better performance
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Reduce bundle size on client side
      config.optimization.splitChunks = {
        chunks: 'all',
        cacheGroups: {
          default: false,
          vendors: false,
          vendor: {
            name: 'vendor',
            chunks: 'all',
            test: /node_modules/,
            priority: 20,
          },
          common: {
            name: 'common',
            minChunks: 2,
            chunks: 'all',
            priority: 10,
            reuseExistingChunk: true,
          },
        },
      };
    }
    return config;
  },
};

export default nextConfig;