import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },

  /*
   * Plan 4, D-H8 invariant 1: no LLM call happens outside the harness loop.
   *
   * Step bodies receive `ctx.llm` (a closure over router.dispatch) and must never reach a
   * provider or the router themselves. This is the boundary that keeps that true as new
   * workflows are added — a comment in loop.ts asks nicely; this fails the build.
   *
   * Scoped to the workflow-step layer. lib/harness/loop.ts is the sanctioned caller of the
   * router, and lib/llm/** is the provider layer itself, so neither is restricted.
   */
  {
    files: ["lib/agents/**/*.ts", "lib/harness/roles/**/*.ts"],
    ignores: [
      "**/*.test.ts",
      // The legacy sequential runner resolves providers itself; that is exactly what the
      // harness loop replaces. It is deleted at milestone H8, and this exemption with it.
      // Do not add entries here — a new file needing one is a design error.
      "lib/agents/orchestrator.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@anthropic-ai/sdk",
              message:
                "Workflow steps must not import a provider SDK. Use ctx.llm, which routes through lib/harness/loop.ts → router.dispatch (Plan 4, D-H8/D-H13).",
            },
          ],
          patterns: [
            {
              group: ["@/lib/llm/providers", "@/lib/llm/providers/*", "@/lib/llm/provider"],
              message:
                "Workflow steps must not reach a provider directly. Use ctx.llm (Plan 4, D-H8).",
            },
            {
              group: ["@/lib/llm/router"],
              message:
                "Only lib/harness/loop.ts dispatches to the router. Step bodies use ctx.llm (Plan 4, D-H13).",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
