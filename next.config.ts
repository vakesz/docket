import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // React Compiler auto-memoizes component output and hook dependencies, so
  // hand-written useMemo / useCallback wrappers stop being load-bearing.
  // The few remaining manual memos in the tree are kept where the compiler
  // can't see across module boundaries (e.g. derived selectors fed into
  // tRPC query cache keys).
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
