import {
    Config,
    ErrorDiagnostic,
    Either as OldEither,
    QualifiedSqlViewName,
    SqlCreateView,
    SqlType,
    SqlViewDefinition,
    SrcSpan,
    TypeScriptType,
    buildInsertCallExpression,
    buildInsertManyCallExpression,
    buildQueryCallExpression,
    codeFrameFormatter,
    getSqlViews,
    loadConfigFileE,
    resolveInsertMany,
    resolveQueryFragment,
    sqlUniqueTypeName
} from "@mfsqlchecker/core";
import { TSESTree } from "@typescript-eslint/typescript-estree";
import { ParserServices, TSESLint } from "@typescript-eslint/utils";
import path from "path";
import "source-map-support/register";
import { TsRunner, createSyncFn } from "synckit";
import invariant from "tiny-invariant";
import { TypeChecker } from "typescript";
import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { createRule } from "../utils/create-rule";
import { InvalidQueryError, RunnerError } from "../utils/errors";
import { E, J, flow, pipe } from "../utils/fp-ts";
import { customLog } from "../utils/log";
import { memoize } from "../utils/memoize";
import { WorkerParams, WorkerResult } from "./sql-check.worker";
import { locateNearestPackageJsonDir } from "../utils/locate-nearest-package-json-dir";
import { metrics, withMetrics } from "../utils/metrics";

const messages = {
    missing: "Missing: {{value}}",
    invalid: "Invalid: {{value}}",
    internal: "Internal error: {{value}}"
};

const zOptions = z.object({
    configFile: z.string(),
    colors: z.boolean().optional(),
    revalidateEachRun: z.boolean().optional(),
    port: z.number().optional()
});

export const zRuleOptions = z.tuple([zOptions]);
export type RuleOptions = z.infer<typeof zRuleOptions>;
export type RuleMessage = keyof typeof messages;
export type RuleContext = Readonly<TSESLint.RuleContext<RuleMessage, RuleOptions>>;

export const sqlCheckRule = createRule({
    name: "sql-check",
    meta: {
        docs: {
            description:
                "Statically validate correctness of all your SQL queries. TypeScript, PostgreSQL",
            recommended: "error"
        },
        messages: messages,
        type: "problem",
        schema: zodToJsonSchema(zRuleOptions, { target: "openApi3" }) as object,
        fixable: "code"
    },
    defaultOptions: [{ configFile: "mfsqlchecker.json" }],
    create(context) {
        const projectDir = memoize({
            key: context.getCwd?.() + "-package-json",
            value: () => locateNearestPackageJsonDir(context.getFilename())
        });

        return {
            CallExpression: (node) => {
                withMetrics(() => checkCallExpression({ node, context, projectDir }));
            },
            TaggedTemplateExpression: (node) => {
                withMetrics(() => checkTaggedTemplateExpression({ node, context, projectDir }));
            }
        };
    }
});

const workerPath = require.resolve("./sql-check.worker");
const runWorkerX = createSyncFn(workerPath, {
    tsRunner: TsRunner.EsbuildRegister,
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

type FileName = string;

const cache: Partial<{
    retries: boolean;
    isInitial: boolean;
    isInitialView: boolean;
    config: Config;
    tsUniqueTableColumnTypes: Map<TypeScriptType, SqlType>;
    viewLibrary: Map<QualifiedSqlViewName, SqlViewDefinition>;
    sqlViews: Map<FileName, SqlCreateView[]>;
}> = {
    retries: false,
    isInitial: true,
    isInitialView: true,
    viewLibrary: new Map(),
    sqlViews: new Map()
};

const checkedViews: Map<string, true> = new Map();

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
        cache.retries === true ||
        program === undefined ||
        checker === undefined ||
        parser === undefined ||
        node.tag.type !== TSESTree.AST_NODE_TYPES.Identifier ||
        node.tag.name !== "defineSqlView"
    ) {
        metrics.no++;
        return;
    }

    if (scopeManager === null || viewDeclaration === undefined) {
        metrics.no++;
        return;
    }

    const tsNode = parser.esTreeNodeToTSNodeMap.get(node);
    const fileName = tsNode.getSourceFile().fileName;
    const nodeId = `${fileName}:${node.loc.start.line}`;

    if (cache.isInitial) {
        customLog.success("initial load from tagged template expression");
        const initE = runInitialize({
            context,
            node,
            parser,
            checker,
            projectDir,
            force: cache.isInitial === true
        });

        if (E.isLeft(initE)) {
            customLog.error(`initial load failed: ${initE.left.message}`);
            return;
        }

        customLog.success("initial load done");
    }

    const wasInitialView = cache.isInitialView;

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
        E.chain(() =>
            getSqlViews({
                projectDir,
                checker,
                program,
                sourceFiles: [fileName]
            })
        ),
        E.mapLeft((diagnostics) => InvalidQueryError.to(diagnostics)),
        E.chain((newSqlViews) => {
            invariant(cache.sqlViews !== undefined);
            invariant(cache.viewLibrary !== undefined);

            cache.sqlViews.set(fileName, newSqlViews.sqlViews.get(fileName) ?? []);
            cache.viewLibrary.forEach((view, name) => {
                if (view.getFileName() === fileName) {
                    cache.viewLibrary?.delete(name);
                }
            });

            newSqlViews.viewLibrary.forEach((view, name) => {
                cache.viewLibrary?.set(name, view);
            });

            return E.right({
                sqlViews: cache.sqlViews,
                viewLibrary: cache.viewLibrary
            });
        }),
        E.chainFirst(({ sqlViews }) =>
            runWorker({
                action: "UPDATE_VIEWS",
                sqlViews: [...sqlViews.values()].flat(),
                strictDateTimeChecking: true
            })
        ),
        E.mapLeft((error) => {
            if (!error.message.includes(nodeId) && !wasInitialView) {
                // this is really awkward check. should be more robust
                return;
            }

            if ("_tag" in error && error._tag === "InvalidQueryError") {
                return reportDiagnostics({
                    node,
                    context,
                    diagnostics: error.diagnostics,
                    calleeProperty: null
                });
            }

            context.report({
                node: node,
                messageId: "invalid",
                data: { value: printError(error.message, context.options[0].colors) }
            });
        })
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

    metrics.ok++;
}

function lookupViewName(params: {
    context: RuleContext;
    parser: ParserServices;
    name: QualifiedSqlViewName;
    projectDir: string;
}) {
    const { context, name, parser, projectDir } = params;
    const { viewLibrary } = cache;

    if (viewLibrary === undefined) {
        return;
    }

    const viewName = viewLibrary.get(name)?.getName();

    if (viewName !== undefined) {
        return viewName;
    }

    if (context.options[0].revalidateEachRun === true) {
        const program = parser.program;
        const checker = program.getTypeChecker();
        const sourceFiles = program.getSourceFiles().filter((s) => !s.isDeclarationFile);

        const sqlViewsE = getSqlViews({
            projectDir,
            checker,
            program,
            sourceFiles: sourceFiles.map((x) => x.fileName)
        });

        if (E.isRight(sqlViewsE)) {
            const { sqlViews, viewLibrary } = sqlViewsE.right;
            cache.sqlViews = sqlViews;
            cache.viewLibrary = viewLibrary;

            runWorker({
                action: "UPDATE_VIEWS",
                sqlViews: [...sqlViews.values()].flat(),
                strictDateTimeChecking: cache.config?.strictDateTimeChecking ?? true
            });

            return sqlViewsE.right.viewLibrary.get(name)?.getName();
        }
    }

    return;
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

    invariant(
        cache.tsUniqueTableColumnTypes !== undefined,
        "tsUniqueTableColumnTypes is undefined"
    );
    invariant(cache.viewLibrary !== undefined, "viewLibrary is undefined");

    const { tsUniqueTableColumnTypes } = cache;

    const resolvedE = pipe(
        E.Do,
        E.chain(() => buildQueryCallExpressionE(calleeProperty.name, tsCallExpression)),
        E.chainW((query) => {
            return resolveQueryFragmentE(
                tsUniqueTableColumnTypes,
                projectDir,
                checker,
                query,
                (name) => lookupViewName({ context, projectDir, parser, name })
            );
        })
    );

    if (E.isLeft(resolvedE)) {
        return reportDiagnostics({
            context,
            node,
            diagnostics: resolvedE.left.diagnostics,
            calleeProperty
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
                data: { value: printError(error.message, context.options[0].colors) }
            });
        })
    );
}

function reportDiagnostics(params: {
    node: TSESTree.CallExpression | TSESTree.TaggedTemplateExpression;
    calleeProperty: TSESTree.Identifier | null;
    context: RuleContext;
    diagnostics: ErrorDiagnostic[];
}) {
    const { node, context, calleeProperty, diagnostics } = params;

    for (const diagnostic of diagnostics) {
        context.report({
            node: node,
            messageId: "invalid",
            loc: mapSrcSpanToLoc(diagnostic.span),
            data: {
                value: printError(
                    diagnostics.map(codeFrameFormatter).join("\n"),
                    context.options[0].colors
                )
            },
            fix:
                diagnostic.quickFix === null || calleeProperty === null
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

const buildInsertCallExpressionE = flow(
    buildInsertCallExpression,
    toFpTsEither,
    E.mapLeft(InvalidQueryError.to)
);

const buildInsertManyCallExpressionE = flow(
    buildInsertManyCallExpression,
    toFpTsEither,
    E.mapLeft(InvalidQueryError.to)
);

const resolveInsertManyE = flow(resolveInsertMany, toFpTsEither, E.mapLeft(InvalidQueryError.to));

function checkInsertExpression(params: {
    type: "INSERT" | "INSERT_MANY";
    context: RuleContext;
    parser: ParserServices;
    checker: TypeChecker;
    node: TSESTree.CallExpression;
    callee: TSESTree.MemberExpression;
    calleeProperty: TSESTree.Identifier;
    projectDir: string;
}) {
    if (cache.retries === true) {
        return;
    }

    const { type, context, parser, checker, node, calleeProperty, projectDir } = params;
    const tsNode = parser.esTreeNodeToTSNodeMap.get(node);

    const { tsUniqueTableColumnTypes, viewLibrary } = cache;

    invariant(tsUniqueTableColumnTypes !== undefined, "tsUniqueTableColumnTypes");
    invariant(viewLibrary !== undefined, "viewLibrary");

    pipe(
        E.Do,
        E.chain(() => {
            switch (type) {
                case "INSERT":
                    return buildInsertCallExpressionE(checker, calleeProperty.name, tsNode);
                case "INSERT_MANY":
                    return buildInsertManyCallExpressionE(checker, calleeProperty.name, tsNode);
            }
        }),
        E.chain((query) => {
            return resolveInsertManyE(
                tsUniqueTableColumnTypes,
                projectDir,
                checker,
                query,
                (name) => lookupViewName({ context, projectDir, parser, name })
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
                data: { value: printError(error.message, context.options[0].colors) }
            });
        })
    );
}

function checkCallExpression(params: {
    node: TSESTree.CallExpression;
    context: RuleContext;
    projectDir: string;
}) {
    if (cache.retries === true) {
        return;
    }

    const { node, context, projectDir } = params;
    const callExpressionValidityE = getCallExpressionValidity(node);

    if (E.isLeft(callExpressionValidityE) || context.parserServices === undefined) {
        metrics.no++;
        return;
    }

    const parser = context.parserServices;
    const checker = parser.program.getTypeChecker();
    const callExpression = callExpressionValidityE.right;
    const tsObject = parser.esTreeNodeToTSNodeMap.get(callExpression.callee.object);
    const tsObjectType = checker.getTypeAtLocation(tsObject);

    if (tsObjectType.getProperty("MfConnectionTypeTag") === undefined) {
        metrics.no++;
        return;
    }

    if (cache.isInitial) {
        customLog.success("initial load from call expression");
        // print tsconfig path
        const initE = runInitialize({
            context,
            node,
            parser,
            checker,
            projectDir,
            force: cache.isInitial === true
        });

        if (E.isLeft(initE)) {
            customLog.error(`initial load failed: ${initE.left.message}`);
            return;
        }

        customLog.success("initial load done");
    }

    switch (callExpression.type) {
        case "QUERY":
            checkQueryExpression({
                context,
                parser,
                checker,
                node,
                projectDir,
                calleeProperty: callExpression.calleeProperty
            });
            break;
        case "INSERT":
        case "INSERT_MANY":
            checkInsertExpression({
                type: callExpression.type,
                context,
                parser,
                checker,
                node,
                projectDir,
                callee: callExpression.callee,
                calleeProperty: callExpression.calleeProperty
            });
    }

    metrics.ok++;
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

const QUERY_METHOD_NAMES = new Set(["query", "queryOne", "queryOneOrNone"]);
const INSERT_METHOD_NAMES = new Set(["insert", "insertMaybe"]);

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
        return E.right({
            type: "INSERT" as const,
            callee: node.callee,
            calleeProperty: node.callee.property
        });
    }

    if (node.callee.property.name === "insertMany") {
        return E.right({
            type: "INSERT_MANY" as const,
            callee: node.callee,
            calleeProperty: node.callee.property
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
}): E.Either<InvalidQueryError | RunnerError, undefined> {
    const { node, context, parser, checker, projectDir } = params;
    const [{ configFile, port }] = context.options;

    const program = parser.program;
    const sourceFiles = program.getSourceFiles().filter((s) => !s.isDeclarationFile);
    const configFilePath = path.join(projectDir, configFile);

    return pipe(
        E.Do,
        E.bind("config", () => {
            customLog.success("loading config file");
            return loadConfigFileE(configFilePath);
        }),
        E.mapLeft((diagnostic) => [diagnostic]),
        E.bindW("uniqueTableColumnTypes", ({ config }) => {
            customLog.success("getting unique table column types");
            return E.right(getTSUniqueColumnTypes(config.uniqueTableColumnTypes));
        }),
        E.bindW("views", () => {
            customLog.success("getting sql views");

            return getSqlViews({
                projectDir,
                checker,
                program,
                sourceFiles: sourceFiles.map((x) => x.fileName)
            });
        }),
        E.mapLeft((diagnostics) => new InvalidQueryError(diagnostics)),
        E.chainFirstW(({ views, config }) => {
            const totalSqlViews = [...views.sqlViews.values()].flat();
            customLog.success(`got ${totalSqlViews.length} sql views. initializing worker.`);
            return runWorker({
                action: "INITIALIZE",
                configFilePath: configFilePath,
                projectDir: projectDir,
                config: config,
                port: port,
                strictDateTimeChecking: config.strictDateTimeChecking ?? true,
                uniqueTableColumnTypes: config.uniqueTableColumnTypes,
                sqlViews: totalSqlViews,
                force: params.force
            });
        }),
        E.fold(
            (error) => {
                cache.retries = true;

                context.report({
                    node: node,
                    messageId: "internal",
                    data: { value: printError(error.message, context.options[0].colors) }
                });

                return E.left(error);
            },
            ({ config, uniqueTableColumnTypes, views }) => {
                cache.isInitial = false;
                cache.retries = false;
                cache.config = config;
                cache.tsUniqueTableColumnTypes = uniqueTableColumnTypes;
                cache.sqlViews = views.sqlViews;
                cache.viewLibrary = views.viewLibrary;

                return E.right(undefined);
            }
        )
    );
}

function printError(message: string, colors: boolean | undefined) {
    if (colors === false) {
        // eslint-disable-next-line no-control-regex
        return message.replace(/\x1b\[[0-9;]*[a-zA-Z]/gm, "");
    }

    return message;
}
