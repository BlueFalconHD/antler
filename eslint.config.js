import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "dist/**",
      "reference/**",
      "integrations/**/.venv/**",
      "integrations/**/dist/**",
      "integrations/**/.pytest_cache/**",
      "integrations/**/.ruff_cache/**",
    ],
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
