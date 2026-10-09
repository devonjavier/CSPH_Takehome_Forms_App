import javascript from "@eslint/js";
import typescript from "typescript-eslint";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/next-env.d.ts",
    ],
  },
  javascript.configs.recommended,
  ...typescript.configs.recommended,
  {
    files: ["apps/**/*.{ts,tsx}"],
    rules: { "@typescript-eslint/no-non-null-assertion": "error" },
  },
];
