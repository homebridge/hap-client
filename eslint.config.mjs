import { defineConfig, globalIgnores } from "eslint/config";
import tsParser from "@typescript-eslint/parser";
import path from "node:path";
import {fileURLToPath} from 'node:url'
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";
import globals from 'globals'

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default defineConfig([globalIgnores(["**/dist/"]), {
  extends: compat.extends(
    "eslint:recommended",
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:@typescript-eslint/recommended",
  ),

  languageOptions: {
      globals: {
          ...globals.browser,
          ...globals.commonjs,
      },

      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "script",
  },

  rules: {},
}]);
