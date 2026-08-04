/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Demo mode only (ISSUES_DEMO=1): PGlite loads its WASM assets from
  // node_modules at runtime, so it must stay external to the bundle.
  serverExternalPackages: ['@electric-sql/pglite'],
};

module.exports = nextConfig;
