import core from "adamantite/lint"
import strict from "adamantite/lint/strict"
import { defineConfig } from "oxlint"

export default defineConfig({
  extends: [core, strict],
  ignorePatterns: core.ignorePatterns,
  options: {
    respectEslintDisableDirectives: true,
    typeAware: true,
    typeCheck: true,
  },
})
