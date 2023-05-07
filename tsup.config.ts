import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        "eslint-local-rules": "./eslint-local-rules/index.ts"
    },
    external: ["eslint"],
    clean: true,
    bundle: true
});
