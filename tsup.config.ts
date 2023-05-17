import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        "index": "./eslint-local-rules/index.ts",
        "sql-check.worker": "./eslint-local-rules/rules/sql-check.worker.ts",
    },
    target: "esnext",
    external: ["eslint", "./sql-check.worker", "embedded-postgres", "@embedded-postgres/*"],
    sourcemap: true,
    clean: true,
});
