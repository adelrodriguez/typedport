import type { KnipConfig } from "knip"
import analyze from "adamantite/analyze"

const config = {
  ...analyze,
  entry: ["examples/**/*.ts"],
  ignore: [],
  ignoreFiles: [],
  project: ["src/**/*.ts", "examples/**/*.ts", "*.config.ts"],
} satisfies KnipConfig

export default config
