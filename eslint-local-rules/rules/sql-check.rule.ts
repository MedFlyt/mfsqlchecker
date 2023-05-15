import { TSESTree } from "@typescript-eslint/typescript-estree";
import { ParserServices, TSESLint } from "@typescript-eslint/utils";
import * as E from "fp-ts/Either";
import { flow, pipe } from "fp-ts/function";
import path from "path";
import "source-map-support/register";
import { TsRunner, createSyncFn } from "synckit";
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
    SqlType,
    TypeScriptType,
    buildQueryCallExpression,
    resolveQueryFragment
} from "../../mfsqlchecker/queries";
import { getSqlViews } from "../../mfsqlchecker/sqlchecker_engine";
import { QualifiedSqlViewName, SqlViewDefinition } from "../../mfsqlchecker/views";
import { createRule } from "../utils";
import { memoize } from "../utils/memoize";
import { queryAnswerToErrorDiagnostics } from "./DbConnector";
import { InvalidQueryError, RunnerError } from "./sql-check.errors";
import { VALID_METHOD_NAMES, locateNearestPackageJsonDir } from "./sql-check.utils";
import { WorkerParams, WorkerResult } from "./sql-check.worker";
import { TypeChecker } from "typescript";
import { ErrorDiagnostic } from "../../mfsqlchecker/ErrorDiagnostic";

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
        type: "problem",
        schema: [],
        fixable: "code"
    },
    defaultOptions: [],
    create(context) {
        const projectDir = memoize({
            key: context.getFilename(),
            value: () => locateNearestPackageJsonDir(context.getFilename())
        });

        return {
            CallExpression: (node) => checkCallExpression({ node, context, projectDir }),
            TaggedTemplateExpression: (node) =>
                checkTaggedTemplateExpression({ node, context, projectDir })
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
    isInitialView: boolean;
    config: Config;
    tsUniqueTableColumnTypes: Map<TypeScriptType, SqlType>;
    viewLibrary: Map<QualifiedSqlViewName, SqlViewDefinition>;
}> = {
    isInitial: true,
    isInitialView: true,
    viewLibrary: new Map()
};

let checkedViews: Map<string, true> = new Map();

function checkTaggedTemplateExpression(params: {
    node: TSESTree.TaggedTemplateExpression;
    context: RuleContext;
    projectDir: string;
}) {
    const { node, context, projectDir } = params;
    const parser = context.parserServices;
    const program = parser?.program;
    const checker = program?.getTypeChecker();
    const sourceCode = context.getSourceCode();
    const scopeManager = sourceCode.scopeManager;
    const viewDeclaration = node.parent;

    if (
        program === undefined ||
        checker === undefined ||
        parser === undefined ||
        node.tag.type !== TSESTree.AST_NODE_TYPES.Identifier ||
        node.tag.name !== "defineSqlView"
    ) {
        return;
    }

    if (scopeManager === null || viewDeclaration === undefined) {
        return;
    }

    const tsNode = parser.esTreeNodeToTSNodeMap.get(node);
    const fileName = tsNode.getSourceFile().fileName;
    const nodeId = `${fileName}:${node.loc.start.line}`;

    if (cache.isInitial) {
        const initE = runInitialize({
            context,
            node,
            parser,
            checker,
            projectDir,
            force: cache.isInitial === true
        });

        if (E.isLeft(initE)) {
            return;
        }
    }

    let wasInitialView = cache.isInitialView;

    if (cache.isInitialView) {
        cache.isInitialView = false;
    }

    if (!checkedViews.has(nodeId)) {
        checkedViews.set(nodeId, true);

        if (!cache.isInitialView) {
            return;
        }
    }

    pipe(
        E.Do,
        E.bind("sqlViews", () =>
            getSqlViews({
                projectDir,
                checker,
                program,
                sourceFiles: [fileName]
            })
        ),
        E.mapLeft(InvalidQueryError.to),
        E.chainFirst(({ sqlViews }) =>
            runWorker({
                action: "UPDATE_VIEWS",
                viewLibrary: sqlViews.sqlViews,
                strictDateTimeChecking: true
            })
        ),
        E.fold(
            (error) => {
                if (!error.message.includes(nodeId) && !wasInitialView) {
                    // this is really awkward check. should be more robust
                    return;
                }
                context.report({
                    node: node,
                    messageId: "invalid",
                    data: { value: error.message }
                });
            },
            ({ sqlViews }) => {
                cache.viewLibrary = sqlViews.viewLibrary;
            }
        )
    );

    const viewVariable = scopeManager.getDeclaredVariables(viewDeclaration)[0];

    for (const reference of viewVariable.references) {
        const ancestor = reference.identifier.parent?.parent;

        if (ancestor === undefined) {
            continue;
        }

        if (ancestor.type === TSESTree.AST_NODE_TYPES.CallExpression) {
            checkCallExpression({
                node: ancestor,
                context,
                projectDir
            });
            continue;
        }

        if (ancestor.type === TSESTree.AST_NODE_TYPES.TaggedTemplateExpression) {
            checkTaggedTemplateExpression({
                node: ancestor,
                context,
                projectDir
            });
            continue;
        }
    }
}

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
    const { callee, calleeProperty } = callExpressionValidityE.right;
    const tsCallExpression = parser.esTreeNodeToTSNodeMap.get(node);
    const checker = parser.program.getTypeChecker();
    const tsObject = parser.esTreeNodeToTSNodeMap.get(callee.object);
    const tsObjectType = checker.getTypeAtLocation(tsObject);

    if (tsObjectType.getProperty("MfConnectionTypeTag") === undefined) {
        return;
    }

    if (cache.isInitial) {
        const initE = runInitialize({
            context,
            node,
            parser,
            checker,
            projectDir,
            force: cache.isInitial === true
        });

        if (E.isLeft(initE)) {
            return;
        }
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
            messageId: "invalid",
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
                    messageId: "invalid",
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
                    data: { value: diagnostic.messages.join("\n") },
                    fix:
                        diagnostic.quickFix === null
                            ? null
                            : (fixer) => {
                                  const replacement = diagnostic.quickFix?.replacementText ?? "";

                                  return node.typeParameters === undefined
                                      ? fixer.replaceText(calleeProperty, replacement)
                                      : fixer.replaceText(node.typeParameters, replacement);
                              }
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

function runInitialize(params: {
    node: TSESTree.Node;
    context: RuleContext;
    parser: ParserServices;
    checker: TypeChecker;
    projectDir: string;
    force: boolean;
}): E.Either<ErrorDiagnostic | Error | RunnerError, undefined> {
    const { node, context, parser, checker, projectDir } = params;
    const configE = toFpTsEither(loadConfigFile(path.join(projectDir, "demo/mfsqlchecker.json")));

    if (E.isLeft(configE)) {
        context.report({
            node: node,
            messageId: "internal",
            data: { value: JSON.stringify(configE.left) }
        });

        return configE;
    }

    const config = configE.right;
    const uniqueTableColumnTypes = getTSUniqueColumnTypes(config.uniqueTableColumnTypes);
    const program = parser.program;
    const sourceFiles = program.getSourceFiles().filter((s) => !s.isDeclarationFile);

    const initE = pipe(
        E.Do,
        E.bind("sqlViews", () => {
            return getSqlViews({
                projectDir,
                checker,
                program,
                sourceFiles: sourceFiles.map((x) => x.fileName)
            });
        }),
        E.mapLeft(InvalidQueryError.to),
        E.chainFirstW(({ sqlViews }) => {
            return runWorker({
                action: "INITIALIZE",
                projectDir: projectDir,
                strictDateTimeChecking: true,
                uniqueTableColumnTypes: config.uniqueTableColumnTypes,
                viewLibrary: sqlViews.sqlViews,
                force: params.force
            });
        })
    );

    if (E.isLeft(initE)) {
        context.report({
            node: node,
            messageId: "internal",
            data: { value: initE.left.message }
        });

        return initE;
    }

    cache.isInitial = false;
    cache.config = config;
    cache.tsUniqueTableColumnTypes = uniqueTableColumnTypes;
    cache.viewLibrary = initE.right.sqlViews.viewLibrary;

    return E.right(undefined);
}
