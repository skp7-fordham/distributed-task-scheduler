import path from "node:path";
import { fileURLToPath } from "node:url";

/** Project root — never rely on `process.cwd()` (wrong under Turbopack / nested lockfiles). */
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const config = {
  plugins: {
    "@tailwindcss/postcss": {
      base: projectRoot,
    },
  },
};

export default config;
