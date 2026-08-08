import path from "node:path";

/**
 * Appwrite Sites' Next.js SSR packager expects a root-level configuration
 * file for monorepo deployments. The application-specific build still uses
 * apps/web/next.config.ts.
 */
export default {
  outputFileTracingRoot: path.resolve("."),
};
