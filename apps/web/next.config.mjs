/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source; Next compiles them with the app.
  transpilePackages: [
    '@flowpilot/core',
    '@flowpilot/database',
    '@flowpilot/domain',
    '@flowpilot/integrations',
    '@flowpilot/mcp',
    '@flowpilot/shared',
  ],
  serverExternalPackages: ['pg', '@electric-sql/pglite'],
  eslint: { ignoreDuringBuilds: true },

  // Workspace packages are TypeScript source and use explicit `.js` specifiers (required for
  // NodeNext-compatible ESM). Webpack does not rewrite those to `.ts` on its own.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
