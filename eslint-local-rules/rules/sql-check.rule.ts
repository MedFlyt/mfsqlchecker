import { TSESTree } from "@typescript-eslint/typescript-estree";
import { TSESLint } from "@typescript-eslint/utils";
import * as E from "fp-ts/Either";
import { flow, pipe } from "fp-ts/function";
import path from "path";
import "source-map-support/register";
import { createSyncFn, TsRunner } from "synckit";
import invariant from "tiny-invariant";
import {
    Config,
    defaultColTypesFormat,
    loadConfigFile,
    sqlUniqueTypeName
} from "../../mfsqlchecker/ConfigFile";
import { Either as OldEither } from "../../mfsqlchecker/either";
import { formatJsonDiagnostic } from "../../mfsqlchecker/formatters/jsonFormatter";
import {
    buildQueryCallExpression,
    resolveQueryFragment,
    SqlType,
    TypeScriptType
} from "../../mfsqlchecker/queries";
import { getSqlViews } from "../../mfsqlchecker/sqlchecker_engine";
import { QualifiedSqlViewName, SqlViewDefinition } from "../../mfsqlchecker/views";
import { createRule } from "../utils";
import { memoize } from "../utils/memoize";
import { queryAnswerToErrorDiagnostics } from "./DbConnector";
import { InvalidQueryError } from "./sql-check.errors";
import { locateNearestPackageJsonDir, VALID_METHOD_NAMES } from "./sql-check.utils";
import { WorkerParams, WorkerResult } from "./sql-check.worker";

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
const runWorker = createSyncFn(workerPath, {
    tsRunner: TsRunner.TSX,
    // timeout: 9000
    timeout: 1000 * 60 * 5
}) as <TWorkerParams extends WorkerParams>(
    params: TWorkerParams
) => WorkerResult<TWorkerParams["action"]>;

let cache: Partial<{
    isInitial: boolean;
    config: Config;
    tsUniqueTableColumnTypes: Map<TypeScriptType, SqlType>;
    viewLibrary: Map<QualifiedSqlViewName, SqlViewDefinition>;
}> = {
    isInitial: true,
    viewLibrary: new Map()
};

function checkCallExpression(params: {
    node: TSESTree.CallExpression;
    context: RuleContext;
    projectDir: string;
}) {
    const { node, context, projectDir } = params;
    const callExpressionValidityE = getCallExpressionValidity(node);

    if (E.isLeft(callExpressionValidityE) || context.parserServices === undefined) {
        return;
    }

    const parser = context.parserServices;
    const sourceCode = context.getSourceCode();
    const { callee, calleeProperty } = callExpressionValidityE.right;
    const tsCallExpression = parser.esTreeNodeToTSNodeMap.get(node);
    const checker = parser.program.getTypeChecker();
    const tsObject = parser.esTreeNodeToTSNodeMap.get(callee.object);
    const tsObjectType = checker.getTypeAtLocation(tsObject);

    if (tsObjectType.getProperty("MfConnectionTypeTag") === undefined) {
        return;
    }

    if (cache.isInitial) {
        const configE = toFpTsEither(
            loadConfigFile(path.join(projectDir, "demo/mfsqlchecker.json"))
        );

        if (E.isLeft(configE)) {
            return context.report({
                node: node,
                messageId: "internal",
                data: { value: JSON.stringify(configE.left) }
            });
        }

        const config = configE.right;
        const uniqueTableColumnTypes = getTSUniqueColumnTypes(config.uniqueTableColumnTypes);
        const program = context.parserServices.program;
        const sourceFiles = program.getSourceFiles().filter((s) => !s.isDeclarationFile);

        const initE = pipe(
            E.Do,
            E.chain(() => {
                return getSqlViews({
                    projectDir,
                    checker,
                    program,
                    sourceFiles: sourceFiles.map((x) => x.fileName)
                });
            }),
            E.mapLeft(InvalidQueryError.to),
            E.chainFirst(() => {
                return runWorker({
                    action: "INITIALIZE",
                    projectDir: projectDir,
                    strictDateTimeChecking: true,
                    uniqueTableColumnTypes: config.uniqueTableColumnTypes,
                    viewLibrary: []
                });
            })
        );

        if (E.isLeft(initE)) {
            return context.report({
                node: node,
                messageId: "internal",
                data: { value: initE.left.message }
            });
        }

        cache.isInitial = false;
        cache.config = config;
        cache.tsUniqueTableColumnTypes = uniqueTableColumnTypes;
        cache.viewLibrary = initE.right.viewLibrary;
    }

    invariant(cache.config !== undefined, "config is undefined");
    invariant(
        cache.tsUniqueTableColumnTypes !== undefined,
        "tsUniqueTableColumnTypes is undefined"
    );
    invariant(cache.viewLibrary !== undefined, "viewLibrary is undefined");

    const { config, tsUniqueTableColumnTypes, viewLibrary } = cache;

    const resolvedStmtE = pipe(
        E.Do,
        E.chain(() => buildQueryCallExpressionE(calleeProperty.name, tsCallExpression)),
        E.chainW((query) => {
            return resolveQueryFragmentE(
                tsUniqueTableColumnTypes,
                params.projectDir,
                checker,
                query,
                (name) => viewLibrary.get(name)?.getName()
            );
        })
    );

    if (E.isLeft(resolvedStmtE)) {
        return context.report({
            node: node,
            messageId: "internal",
            data: { value: resolvedStmtE.left.message }
        });
    }

    const resolvedStmt = resolvedStmtE.right;

    pipe(
        E.Do,
        E.chain(() => runWorker({ action: "CHECK", query: resolvedStmt })),
        E.chainW((r) => (r.type === "NoErrors" ? E.right(r) : E.left(r))),
        E.mapLeft((error) => {
            if (error instanceof Error) {
                return context.report({
                    node: node,
                    messageId: "internal",
                    data: { value: error.message }
                });
            }

            const diagnostics = queryAnswerToErrorDiagnostics(
                resolvedStmt,
                error,
                defaultColTypesFormat
            );

            for (const diagnostic of diagnostics) {
                const formatted = formatJsonDiagnostic(diagnostic);
                context.report({
                    node: node,
                    messageId: "internal",
                    loc: {
                        start: {
                            line: formatted.location.startLine + 1,
                            column: formatted.location.startCharacter + 1
                        },
                        end: {
                            line: formatted.location.endLine + 1,
                            column: formatted.location.endCharacter + 1
                        }
                    },
                    data: { value: diagnostic.messages.join("\n") }
                });
            }
        })
    );
}

const resolveQueryFragmentE = flow(
    resolveQueryFragment,
    toFpTsEither,
    E.mapLeft((diagnostics) => new InvalidQueryError(diagnostics))
);

const buildQueryCallExpressionE = flow(
    buildQueryCallExpression,
    toFpTsEither,
    E.mapLeft((diagnostics) => new InvalidQueryError(diagnostics))
);

function getTSUniqueColumnTypes(uniqueTableColumnTypes: Config["uniqueTableColumnTypes"]) {
    const tsUniqueColumnTypes = new Map<TypeScriptType, SqlType>();

    for (const uniqueTableColumnType of uniqueTableColumnTypes) {
        tsUniqueColumnTypes.set(
            uniqueTableColumnType.typeScriptTypeName,
            SqlType.wrap(
                sqlUniqueTypeName(uniqueTableColumnType.tableName, uniqueTableColumnType.columnName)
            )
        );
    }

    return tsUniqueColumnTypes;
}

function toFpTsEither<T, E>(either: OldEither<E, T>): E.Either<E, T> {
    return either.type === "Left" ? E.left(either.value) : E.right(either.value);
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
