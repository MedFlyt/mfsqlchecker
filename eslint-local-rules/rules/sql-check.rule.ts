import { TSESTree } from "@typescript-eslint/typescript-estree";
import { TSESLint } from "@typescript-eslint/utils";
import * as E from "fp-ts/Either";
import { pipe } from "fp-ts/function";
import { createSyncFn, TsRunner } from "synckit";
import invariant from "tiny-invariant";
import ts from "typescript";
import { Config, loadConfigFile, sqlUniqueTypeName } from "../../mfsqlchecker/ConfigFile";
import { Either as OldEither } from "../../mfsqlchecker/either";
import { ErrorDiagnostic } from "../../mfsqlchecker/ErrorDiagnostic";
import {
    buildQueryCallExpression,
    QueryCallExpression,
    resolveQueryFragment,
    SqlType,
    TypeScriptType
} from "../../mfsqlchecker/queries";
import { createRule } from "../utils";
import { memoize } from "../utils/memoize";
import { locateNearestPackageJsonDir, VALID_METHOD_NAMES } from "./sql-check.utils";
import { WorkerParams } from "./sql-check.worker";
import path from "path";
import chalk from "chalk";
import { QualifiedSqlViewName } from "../../mfsqlchecker/views";

export type RuleMessage = keyof typeof messages;
export type RuleOptions = never[];
export type RuleContext = TSESLint.RuleContext<RuleMessage, RuleOptions>;

const messages = {
    missing: "Missing: {{value}}",
    invalid: "Invalid: {{value}}",
    internal: "Internal error: {{value}}"
};

export const sqlCheck = createRule({
    name: "sql-check",
    meta: {
        docs: {
            description:
                "Statically validate correctness of all your SQL queries. TypeScript, PostgreSQL",
            recommended: "error"
        },
        messages: messages,
        type: "suggestion",
        schema: []
    },
    defaultOptions: [],
    create(context) {
        const projectDir = memoize({
            key: context.getFilename(),
            value: () => locateNearestPackageJsonDir(context.getFilename())
        });

        return {
            CallExpression: (node) => checkCallExpression({ node, context, projectDir })
        };
    }
});

const workerPath = require.resolve("./sql-check.worker");
const runWorker = createSyncFn<(params: WorkerParams) => Promise<E.Either<unknown, string>>>(
    workerPath,
    {
        tsRunner: TsRunner.EsbuildRegister,
        timeout: 5000
        // timeout: 1000 * 60 * 5
    }
);

let isInitial = true;
let config: Config | undefined = undefined;

function checkCallExpression(params: {
    node: TSESTree.CallExpression;
    context: RuleContext;
    projectDir: string;
}) {
    const { node, context } = params;
    const callExpressionValidityE = getCallExpressionValidity(node);

    if (E.isLeft(callExpressionValidityE) || context.parserServices === undefined) {
        return;
    }

    if (isInitial) {
        runWorker({ action: "INITIALIZE", projectDir: params.projectDir });
        const configE = toFpTsEither(
            loadConfigFile(path.join(params.projectDir, "demo/mfsqlchecker.json"))
        );

        if (E.isLeft(configE)) {
            return context.report({
                node: node,
                messageId: "internal",
                data: { value: JSON.stringify(configE.left) }
            });
        }

        config = configE.right;
        isInitial = false;
    }

    invariant(config !== undefined, "config should already be defined at this point");

    if (E.isLeft(callExpressionValidityE) || context.parserServices === undefined) {
        return;
    }

    const { callee, calleeProperty } = callExpressionValidityE.right;

    const tsCallExpression = context.parserServices.esTreeNodeToTSNodeMap.get(node);
    const checker = context.parserServices.program.getTypeChecker();
    const tsObject = context.parserServices.esTreeNodeToTSNodeMap.get(callee.object);
    const tsObjectType = checker.getTypeAtLocation(tsObject);

    if (tsObjectType.getProperty("MfConnectionTypeTag") === undefined) {
        return;
    }

    const typeScriptUniqueColumnTypes = new Map<TypeScriptType, SqlType>();
    for (const uniqueTableColumnType of config.uniqueTableColumnTypes) {
        typeScriptUniqueColumnTypes.set(
            uniqueTableColumnType.typeScriptTypeName,
            SqlType.wrap(
                sqlUniqueTypeName(uniqueTableColumnType.tableName, uniqueTableColumnType.columnName)
            )
        );
    }

    const lookupViewName: (qualifiedSqlViewName: QualifiedSqlViewName) => string | undefined = (
        qualifiedSqlViewName
    ) => {
        // TODO: implement
        return undefined;
    };

    const queryFragmentE = pipe(
        E.Do,
        E.bindW("query", () => buildQueryCallExpressionE(calleeProperty.name, tsCallExpression)),
        E.chain(({ query }) => {
            return toFpTsEither(
                resolveQueryFragment(
                    typeScriptUniqueColumnTypes,
                    params.projectDir,
                    checker,
                    query,
                    lookupViewName
                )
            );
        })
    );

    if (queryFragmentE._tag === "Left") {
        queryFragmentE.left.map(l => l.messages).forEach((message) => {
            console.log(chalk(...message));
        });
        // console.log(JSON.stringify(x.left.map(l => l.messages)));
    }

    if (E.isRight(queryFragmentE)) {
        const x = runWorker({ action: "CHECK", query: queryFragmentE.right })
        console.log(x);
    }

    // const { callee, property, argument } = callExpressionValidityE.right;
    // const sourceCode = context.getSourceCode();

    // return context.report({
    //     node: callee,
    //     messageId: "invalid",
    //     data: { value: sourceCode.getText(argument.quasi) }
    // });
}

function toFpTsEither<T, E>(either: OldEither<E, T>): E.Either<E, T> {
    return either.type === "Left" ? E.left(either.value) : E.right(either.value);
}

function buildQueryCallExpressionE(
    methodName: string,
    node: ts.CallExpression
): E.Either<ErrorDiagnostic[], QueryCallExpression> {
    const result = buildQueryCallExpression(methodName, node);
    return result.type === "Left" ? E.left(result.value) : E.right(result.value);
}

function getCallExpressionValidity(node: TSESTree.CallExpression) {
    if (node.callee.type !== TSESTree.AST_NODE_TYPES.MemberExpression) {
        return E.left("CALLEE_NOT_MEMBER_EXPRESSION");
    }

    if (node.callee.property.type !== TSESTree.AST_NODE_TYPES.Identifier) {
        return E.left("CALLEE_PROPERTY_NOT_IDENTIFIER");
    }

    if (!VALID_METHOD_NAMES.has(node.callee.property.name)) {
        return E.left("CALLEE_PROPERTY_NOT_VALID");
    }

    const argument = node.arguments[0];

    if (argument === undefined) {
        return E.left("NO_ARGUMENT");
    }

    if (argument.type !== TSESTree.AST_NODE_TYPES.TaggedTemplateExpression) {
        return E.left("ARGUMENT_NOT_TAGGED_TEMPLATE_EXPRESSION");
    }

    return E.right({
        callee: node.callee,
        calleeProperty: node.callee.property,
        argument: argument
    });
}
