import { defineConfig } from "tsup";
import path from "path";

console.log(path.resolve(__dirname, "..", "**/*.ts"));

export default defineConfig({
    entry: {
        "index": "src/index.ts",
        "sql-check.worker": "src/rules/sql-check.worker.ts",
    },
    target: "esnext",
    external: ["eslint", "typescript", "./sql-check.worker", "embedded-postgres"],
    sourcemap: true,
    clean: true,
});
