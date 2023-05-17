import { ESLintUtils } from "@typescript-eslint/utils";
import { RuleMessage, RuleOptions } from "./rules/sql-check.rule";

export const createRule = ESLintUtils.RuleCreator(
    (name) => `https://github.com/MedFlyt/mfsqlchecker#${name}`
)<RuleOptions, RuleMessage>;

export function fmap<T>(value: T | null | undefined, f: (value: T) => T): T | null {
    return value === null || value === undefined ? null : f(value);
}