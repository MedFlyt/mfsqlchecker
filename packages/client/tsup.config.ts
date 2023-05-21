import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "./src/index.ts"
    },
    target: "esnext",
    dts: true,
    sourcemap: true,
    clean: true
});
