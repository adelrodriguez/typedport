import type { KnipConfig } from "knip"
import analyze from "adamantite/analyze"

const config = {
  ...analyze,
  entry: ["examples/**/*.ts"],
  // Knip always analyzes its own config as a production entry, so `--strict` reports the
  // `adamantite` devDependency it imports as unlisted.
  ignore: ["knip.config.ts"],
  // `--strict` skips type-only imports, but the published `.d.ts` imports this package, so
  // consumers need it as a runtime dependency.
  ignoreDependencies: ["@standard-schema/spec"],
  ignoreFiles: [],
  project: ["src/**/*.ts", "examples/**/*.ts", "*.config.ts"],
} satisfies KnipConfig

export default config
