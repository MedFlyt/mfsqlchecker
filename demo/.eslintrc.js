module.exports = {
    extends: "../.eslintrc.json",
    plugins: ["@medflyt/sql-checker"],
    parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname
    },
    rules: {
        "@typescript-eslint/switch-exhaustiveness-check": "error",
        "@medflyt/sql-checker/sql-check": ["error", { configFile: "mfsqlchecker.json", port: 5430 }]
    }
};
