const path = require("path");

const projectRoot = path.resolve(__dirname);

/** Resolve a package root from this app (ignores parent `~/package.json` / wrong cwd). */
function packageRoot(pkg) {
  return path.dirname(
    require.resolve(`${pkg}/package.json`, { paths: [projectRoot] }),
  );
}

const backendOrigin =
  process.env.BACKEND_URL ?? "http://localhost:5050";

/** @type {import("next").NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/jobs",
        destination: `${backendOrigin}/jobs`,
      },
    ];
  },
  turbopack: {
    root: projectRoot,
    resolveAlias: {
      tailwindcss: packageRoot("tailwindcss"),
    },
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      tailwindcss: packageRoot("tailwindcss"),
    };
    return config;
  },
};

module.exports = nextConfig;
