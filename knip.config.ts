import type { KnipConfig } from "knip"
import analyze from "adamantite/analyze"

const config = {
  ...analyze,
  entry: [],
  ignore: [],
  ignoreFiles: [],
  project: ["src/**/*.ts", "*.config.ts"],
} satisfies KnipConfig

export default config
