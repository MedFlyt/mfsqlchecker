import { TSESTree } from "@typescript-eslint/typescript-estree";
import { ParserServices, TSESLint } from "@typescript-eslint/utils";
import * as E from "fp-ts/Either";
import { flow, pipe } from "fp-ts/function";
import * as J from "fp-ts/Json";
import path from "path";
import "source-map-support/register";
import { createSyncFn, TsRunner } from "synckit";
import invariant from "tiny-invariant";
import { TypeChecker } from "typescript";
import {
    Config, loadConfigFile,
    sqlUniqueTypeName
} from "../../mfsqlchecker/ConfigFile";
import { Either as OldEither } from "../../mfsqlchecker/either";
import { ErrorDiagnostic, SrcSpan } from "../../mfsqlchecker/ErrorDiagnostic";
import { codeFrameFormatter } from "../../mfsqlchecker/formatters/codeFrameFormatter";
import {
    buildInsertCallExpression, buildQueryCallExpression, resolveInsertMany, resolveQueryFragment, SqlType,
    TypeScriptType
} from "../../mfsqlchecker/queries";
import { getSqlViews } from "../../mfsqlchecker/sqlchecker_engine";
import { QualifiedSqlViewName, SqlViewDefinition } from "../../mfsqlchecker/views";
import { createRule } from "../utils";
import { memoize } from "../utils/memoize";
import { InvalidQueryError, RunnerError } from "./sql-check.errors";
import {
    INSERT_METHOD_NAMES, locateNearestPackageJsonDir,
    QUERY_METHOD_NAMES
} from "./sql-check.utils";
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
const runWorkerX = createSyncFn(workerPath, {
    tsRunner: TsRunner.TSX,
    // timeout: 9000
    timeout: 1000 * 60 * 5
});

const runWorker = flow(
    runWorkerX as any,
    E.chain(J.parse),
    E.chainW((parsed) => parsed as unknown as E.Either<unknown, unknown>),
    E.mapLeft((error) => error)
) as <TWorkerParams extends WorkerParams>(
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

function checkQueryExpression(params: {
    context: RuleContext;
    parser: ParserServices;
    checker: TypeChecker;
    projectDir: string;
    node: TSESTree.CallExpression;
    calleeProperty: TSESTree.Identifier;
}) {
    const { context, parser, checker, node, projectDir, calleeProperty } = params;
    const tsCallExpression = parser.esTreeNodeToTSNodeMap.get(node);

    invariant(cache.config !== undefined, "config is undefined");
    invariant(
        cache.tsUniqueTableColumnTypes !== undefined,
        "tsUniqueTableColumnTypes is undefined"
    );
    invariant(cache.viewLibrary !== undefined, "viewLibrary is undefined");

    const { config, tsUniqueTableColumnTypes, viewLibrary } = cache;

    const resolvedE = pipe(
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

    if (E.isLeft(resolvedE)) {
        return context.report({
            node: node,
            messageId: "invalid",
            data: { value: resolvedE.left.message }
        });
    }

    const resolved = resolvedE.right;

    pipe(
        E.Do,
        E.chain(() => runWorker({ action: "CHECK_QUERY", resolved })),
        E.mapLeft((error) => {
            if ("_tag" in error && error._tag === "InvalidQueryError") {
                return reportDiagnostics({
                    context,
                    node,
                    calleeProperty,
                    diagnostics: error.diagnostics
                });
            }

            return context.report({
                node: node,
                messageId: "internal",
                data: { value: error.message }
            });
        })
    );
}

function reportDiagnostics(params: {
    node: TSESTree.CallExpression;
    calleeProperty: TSESTree.Identifier;
    context: RuleContext;
    diagnostics: ErrorDiagnostic[];
}) {
    const { node, context, calleeProperty, diagnostics } = params;

    for (const diagnostic of diagnostics) {
        context.report({
            node: node,
            messageId: "invalid",
            loc: mapSrcSpanToLoc(diagnostic.span),
            data: { value: diagnostics.map(codeFrameFormatter).join("\n") },
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
}

function mapSrcSpanToLoc(
    span: SrcSpan
): Readonly<TSESTree.SourceLocation> | Readonly<TSESTree.Position> | undefined {
    switch (span.type) {
        case "File":
            return undefined;
        case "LineAndCol":
            return {
                line: span.line,
                column: span.col - 1
            };
        case "LineAndColRange":
            return {
                start: {
                    line: span.startLine,
                    column: span.startCol - 1
                },
                end: {
                    line: span.endLine,
                    column: span.endCol - 1
                }
            };
    }
}

function checkInsertExpression(params: {
    context: RuleContext;
    parser: ParserServices;
    checker: TypeChecker;
    node: TSESTree.CallExpression;
    callee: TSESTree.MemberExpression;
    calleeProperty: TSESTree.Identifier;
    projectDir: string;
}) {
    const { context, parser, checker, node, calleeProperty, projectDir } = params;
    const tsNode = parser.esTreeNodeToTSNodeMap.get(node);

    const { tsUniqueTableColumnTypes, viewLibrary } = cache;

    invariant(tsUniqueTableColumnTypes !== undefined, "tsUniqueTableColumnTypes");
    invariant(viewLibrary !== undefined, "viewLibrary");

    const buildInsertCallExpressionE = flow(
        buildInsertCallExpression,
        toFpTsEither,
        E.mapLeft(InvalidQueryError.to)
    );

    const resolveInsertManyE = flow(
        resolveInsertMany,
        toFpTsEither,
        E.mapLeft(InvalidQueryError.to)
    );

    pipe(
        E.Do,
        E.chain(() => buildInsertCallExpressionE(checker, calleeProperty.name, tsNode)),
        E.chain((query) => {
            return resolveInsertManyE(
                tsUniqueTableColumnTypes,
                projectDir,
                checker,
                query,
                (name) => viewLibrary.get(name)?.getName()
            );
        }),
        E.chain((resolved) => {
            return runWorker({ action: "CHECK_INSERT", resolved });
        }),
        E.mapLeft((error) => {
            if ("_tag" in error && error._tag === "InvalidQueryError") {
                return reportDiagnostics({
                    context,
                    node,
                    calleeProperty,
                    diagnostics: error.diagnostics
                });
            }

            return context.report({
                node: node,
                messageId: "invalid",
                data: { value: error.message }
            });
        })
    );
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
    const checker = parser.program.getTypeChecker();
    const callExpression = callExpressionValidityE.right;
    const tsObject = parser.esTreeNodeToTSNodeMap.get(callExpression.callee.object);
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

    switch (callExpression.type) {
        case "QUERY":
            return checkQueryExpression({
                context,
                parser,
                checker,
                node,
                projectDir,
                calleeProperty: callExpression.calleeProperty
            });
        case "INSERT":
            return checkInsertExpression({
                context,
                parser,
                checker,
                node,
                projectDir,
                callee: callExpression.callee,
                calleeProperty: callExpression.calleeProperty
            });
    }
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

    if (QUERY_METHOD_NAMES.has(node.callee.property.name)) {
        const argument = node.arguments[0];

        if (argument === undefined) {
            return E.left("NO_ARGUMENT");
        }

        if (argument.type !== TSESTree.AST_NODE_TYPES.TaggedTemplateExpression) {
            return E.left("ARGUMENT_NOT_TAGGED_TEMPLATE_EXPRESSION");
        }

        return E.right({
            type: "QUERY" as const,
            callee: node.callee,
            calleeProperty: node.callee.property,
            argument: argument
        });
    }
    if (INSERT_METHOD_NAMES.has(node.callee.property.name)) {
        const tableNameArgument = node.arguments.at(0);
        const valueArgument = node.arguments.at(1);
        const epilogueArgument = node.arguments.at(2);

        if (tableNameArgument?.type !== TSESTree.AST_NODE_TYPES.Literal) {
            return E.left("TABLE_NAME_ARGUMENT_NOT_LITERAL");
        }

        if (valueArgument?.type !== TSESTree.AST_NODE_TYPES.ObjectExpression) {
            return E.left("VALUE_ARGUMENT_NOT_OBJECT_EXPRESSION");
        }

        if (
            epilogueArgument !== undefined &&
            epilogueArgument?.type !== TSESTree.AST_NODE_TYPES.TaggedTemplateExpression
        ) {
            return E.left("EPILOGUE_ARGUMENT_NOT_TAGGED_TEMPLATE_EXPRESSION");
        }

        return E.right({
            type: "INSERT" as const,
            callee: node.callee,
            calleeProperty: node.callee.property,
            // TODO @Newbie012 - do we really need this?
            arguments: {
                tableName: tableNameArgument,
                value: valueArgument,
                epilogue: epilogueArgument
            }
        });
    }

    return E.left("CALLEE_PROPERTY_NOT_QUERY_OR_INSERT");
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
