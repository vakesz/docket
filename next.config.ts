import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tree-shake the per-icon imports of these packages so client bundles only
  // ship the components actually used. See nextjs.org/docs/.../optimizePackageImports.
  experimental: {
    optimizePackageImports: ["@headlessui/react", "lucide-react"],
  },
};

export default nextConfig;
