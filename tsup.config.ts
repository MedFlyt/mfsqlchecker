import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        "eslint-local-rules": "./eslint-local-rules/index.ts",
        "sql-check.worker": "./eslint-local-rules/rules/sql-check.worker.ts",
    },
    target: "esnext",
    external: ["eslint", "./sql-check.worker", "synckit"],
    clean: true,
    // bundle: true
});
