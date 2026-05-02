import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // React Compiler auto-memoizes component output and hook dependencies,
  // so the codebase intentionally has zero hand-written useMemo /
  // useCallback / React.memo wrappers — the compiler does it all.
  reactCompiler: true,
  reactStrictMode: true,
  typedRoutes: true,
  typescript: {
    ignoreBuildErrors: false,
  },
  // Tree-shake the per-icon imports of these packages so client bundles only
  // ship the components actually used. See nextjs.org/docs/.../optimizePackageImports.
  experimental: {
    optimizePackageImports: ["lucide-react", "radix-ui", "cmdk"],
  },
};

export default nextConfig;
