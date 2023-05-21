module.exports = {
    extends: "../.eslintrc.json",
    plugins: ["@mfsqlchecker/eslint-plugin"],
    parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname
    },
    rules: {
        "@typescript-eslint/switch-exhaustiveness-check": "error",
        "@mfsqlchecker/sql-check": ["error", { configFile: "mfsqlchecker.json" }]
    }
};
