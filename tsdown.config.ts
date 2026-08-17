import { defineConfig } from "tsdown"
import packageJson from "./package.json" with { type: "json" }

export default defineConfig({
  deps: {
    neverBundle: true,
    // Deliberately tracks package.json: adding a peer dependency widens this
    // import guard without a change to the build config.
    onlyImport: Object.keys(packageJson.peerDependencies),
  },
  dts: true,
  entry: ["src/index.ts"],
  fixedExtension: false,
  sourcemap: true,
})
