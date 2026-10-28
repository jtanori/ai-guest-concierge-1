// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    // web/ is the Next.js app (S04-01): it has its own build and its own
    // lint story, and the root config's Node globals do not describe it.
    ignores: ["node_modules/", "dist/", "coverage/", "docs/", "web/", ".vercel/"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
