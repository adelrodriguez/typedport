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
  overrides: [
    {
      files: ["src/__tests__/types.test-d.ts"],
      rules: { "typescript/no-unnecessary-type-parameters": "off" },
    },
  ],
})
