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
    getSqlViewsE,
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
    port: z.number().optional(),
    debug: z.boolean().optional(),
    slowThresholdMs: z.number().optional(),
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

        if (context.options[0].debug) {
            process.env.DEBUG_SQL_CHECKER = "true";
        }
        
        if (context.options[0].slowThresholdMs) {
            process.env.TYPE_CHECKING_SLOW_THRESHOLD_MS = context.options[0].slowThresholdMs.toString();
        }

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

const cache: {
    isInitial: boolean;
    isFatal: boolean;
    viewLibrary: Map<QualifiedSqlViewName, SqlViewDefinition>;
    sqlViews: SqlCreateView[];
    viewDiagnostics: Map<string, ErrorDiagnostic[]>;
    checkedViews: Set<string>;
} & Partial<{
    config: Config;
    tsUniqueTableColumnTypes: Map<TypeScriptType, SqlType>;
}> = {
    isInitial: true,
    isFatal: false,
    viewLibrary: new Map(),
    sqlViews: [],
    viewDiagnostics: new Map(),
    checkedViews: new Set()
};

const checkedNodes = new Set<string>();
const checkedFiles = new Map<string, number>();

function wasFileCheckedRecently(fileName: string) {
    const lastChecked = checkedFiles.get(fileName) ?? 0;
    const now = Date.now();

    if (now - lastChecked < 100) {
        return true;
    }

    checkedFiles.set(fileName, now);
    return false;
}

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
        metrics.skipped++;
        return;
    }

    if (scopeManager === null || viewDeclaration === undefined) {
        metrics.skipped++;
        return;
    }

    const tsNode = parser.esTreeNodeToTSNodeMap.get(node);
    const fileName = tsNode.getSourceFile().fileName;

    const reportViewDiagnostics = () => {
        const fileDiagnostics = cache.viewDiagnostics.get(fileName) ?? [];
        const viewDiagnostics = getRelevantDiagnostics({
            node,
            fileName,
            diagnostics: fileDiagnostics
        });

        return reportDiagnostics({
            context,
            node,
            diagnostics: viewDiagnostics,
            calleeProperty: null
        });
    };

    if (isFatal()) {
        reportViewDiagnostics();

        metrics.fatal++;

        return;
    }

    if (wasFileCheckedRecently(fileName)) {
        return;
    }

    if (cache.isInitial) {
        customLog.success("initial load from tagged template expression");
        const initE = runInitialize({
            context,
            node,
            parser,
            checker,
            projectDir
        });

        if (E.isLeft(initE)) {
            checkedFiles.set(fileName, Date.now());
            return;
        }

        customLog.success("initial load done");
    }

    if (!isTerminal()) {
        pipe(
            E.Do,
            E.chain(() =>
                getSqlViewsE({
                    projectDir,
                    checker,
                    program,
                    sourceFiles: [fileName],
                    viewLibrary: cache.viewLibrary
                })
            ),
            E.mapLeft((diagnostics) => InvalidQueryError.to(diagnostics)),
            E.map(({ sqlViews, viewLibrary }) => {
                cache.sqlViews = sqlViews;
                cache.viewLibrary = viewLibrary;

                return {
                    sqlViews: cache.sqlViews,
                    viewLibrary: cache.viewLibrary
                };
            }),
            E.chainFirst(({ sqlViews }) => {
                customLog.info(`updating views (initiator: ${fileName})`);

                return runWorker({
                    action: "UPDATE_VIEWS",
                    sqlViews: sqlViews,
                    strictDateTimeChecking: true
                });
            }),
            E.map(() => {
                cache.viewDiagnostics = new Map();
            }),
            E.mapLeft((error) => {
                customLog.info("setting new view diagnostics");
                if (error._tag === "InvalidQueryError") {
                    setViewsDiagnostic(error);
                    reportViewDiagnostics();
                }

                return reportError({ context, error, node, calleeProperty: null });
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
    }

    metrics.checked++;
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

        const sqlViewsE = getSqlViewsE({
            projectDir,
            checker,
            program,
            viewLibrary: cache.viewLibrary,
            sourceFiles: sourceFiles.map((x) => x.fileName)
        });

        if (E.isRight(sqlViewsE)) {
            const { sqlViews, viewLibrary } = sqlViewsE.right;
            cache.sqlViews = sqlViews;
            cache.viewLibrary = viewLibrary;

            runWorker({
                action: "UPDATE_VIEWS",
                sqlViews: sqlViews,
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
        E.mapLeft((error) => reportError({ context, error, node, calleeProperty }))
    );
}

function getRelevantDiagnostics(params: {
    fileName: string;
    node: TSESTree.TaggedTemplateExpression;
    diagnostics: ErrorDiagnostic[];
}) {
    const { fileName, node, diagnostics } = params;

    return diagnostics.filter((diagnostic) =>
        isDiagnosticInTaggedTemplateExpression({ fileName, node, diagnostic })
    );
}

function isDiagnosticInTaggedTemplateExpression(params: {
    fileName: string;
    node: TSESTree.TaggedTemplateExpression;
    diagnostic: ErrorDiagnostic;
}) {
    const { fileName, node, diagnostic } = params;

    if (fileName !== diagnostic.fileName) {
        return false;
    }

    switch (diagnostic.span.type) {
        case "File":
            return true;
        case "LineAndCol":
            return (
                diagnostic.span.line >= node.loc.start.line &&
                diagnostic.span.line <= node.loc.end.line
            );
        case "LineAndColRange":
            return (
                diagnostic.span.startLine >= node.loc.start.line &&
                diagnostic.span.endLine <= node.loc.end.line
            );
    }
}

function reportError(params: {
    context: RuleContext;
    node: TSESTree.CallExpression | TSESTree.TaggedTemplateExpression;
    error: InvalidQueryError | RunnerError;
    calleeProperty: TSESTree.Identifier | null;
}) {
    const { error, context, node, calleeProperty } = params;

    switch (error._tag) {
        case "InvalidQueryError":
            return reportDiagnostics({
                node,
                context,
                diagnostics: error.diagnostics,
                calleeProperty
            });
        case "RunnerError":
            return context.report({
                node: node,
                messageId: "internal",
                data: { value: printError(error.message, context.options[0].colors) }
            });
    }
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
        E.mapLeft((error) => reportError({ context, error, node, calleeProperty }))
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
        metrics.skipped++;
        return;
    }

    const parser = context.parserServices;
    const checker = parser.program.getTypeChecker();
    const callExpression = callExpressionValidityE.right;
    const tsObject = parser.esTreeNodeToTSNodeMap.get(callExpression.callee.object);
    const tsObjectType = checker.getTypeAtLocation(tsObject);

    if (tsObjectType.getProperty("MfConnectionTypeTag") === undefined) {
        metrics.skipped++;
        return;
    }

    if (isFatal()) {
        metrics.fatal++;
        return;
    }

    const nodeLocation = `${tsObject.getSourceFile().fileName}:${node.loc.start.line}`;

    if (cache.viewDiagnostics.size > 0 && !checkedNodes.has(nodeLocation)) {
        checkedNodes.add(nodeLocation);
        return;
    }

    if (cache.isInitial) {
        customLog.success("initial load from call expression");
        const initE = runInitialize({
            context,
            node,
            parser,
            checker,
            projectDir
        });

        if (E.isLeft(initE)) {
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

    metrics.checked++;
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
    node: TSESTree.CallExpression | TSESTree.TaggedTemplateExpression;
    context: RuleContext;
    parser: ParserServices;
    checker: TypeChecker;
    projectDir: string;
}): E.Either<InvalidQueryError | RunnerError, undefined> {
    const { node, context, parser, checker, projectDir } = params;
    const [{ configFile, port }] = context.options;

    const program = parser.program;
    const sourceFiles = program.getSourceFiles().filter((s) => !s.isDeclarationFile);
    const configFilePath = path.join(projectDir, configFile);

    return pipe(
        E.Do,
        E.bind("config", () => {
            if (cache.config !== undefined) {
                return E.right(cache.config);
            }

            return pipe(
                loadConfigFileE(configFilePath),
                E.map((config) => {
                    cache.config = config;
                    customLog.success("loaded configutation file");
                    return config;
                }),
                E.mapLeft((diagnostic) => [diagnostic])
            );
        }),
        E.bindW("uniqueTableColumnTypes", ({ config }) => {
            if (cache.tsUniqueTableColumnTypes !== undefined) {
                return E.right(cache.tsUniqueTableColumnTypes);
            }

            const uniqueColumnTypes = getTSUniqueColumnTypes(config.uniqueTableColumnTypes);
            cache.tsUniqueTableColumnTypes = uniqueColumnTypes;

            customLog.success("loaded unique table column types");
            return E.right(uniqueColumnTypes);
        }),
        E.bindW("views", () => {
            customLog.success("getting sql views");

            return pipe(
                E.Do,
                E.chain(() =>
                    getSqlViewsE({
                        projectDir,
                        checker,
                        program,
                        viewLibrary: cache.viewLibrary,
                        sourceFiles: sourceFiles.map((x) => x.fileName)
                    })
                ),
                E.map((views) => {
                    cache.sqlViews = views.sqlViews;
                    cache.viewLibrary = views.viewLibrary;
                    customLog.success(`loaded ${views.sqlViews.length} sql views`);
                    return views;
                })
            );
        }),
        E.mapLeft((diagnostics) => new InvalidQueryError(diagnostics)),
        E.chainFirstW(({ views, config }) => {
            customLog.success(`initializing worker`);
            return runWorker({
                action: "INITIALIZE",
                configFilePath: configFilePath,
                projectDir: projectDir,
                config: config,
                port: port,
                strictDateTimeChecking: config.strictDateTimeChecking ?? true,
                uniqueTableColumnTypes: config.uniqueTableColumnTypes,
                sqlViews: views.sqlViews,
                force: true
            });
        }),
        E.fold(
            (error) => {
                if (error._tag === "InvalidQueryError") {
                    setViewsDiagnostic(error);
                }

                customLog.error(`initial load failed: ${error.message}`);
                reportError({ context, error, node, calleeProperty: null });

                return E.left(error);
            },
            () => {
                cache.viewDiagnostics = new Map();
                cache.isInitial = false;

                return E.right(undefined);
            }
        )
    );
}

/**
 * While IDEs can recover from errors, the terminal cannot.
 * This prevents the terminal from being spammed with attempts to reinitialize on each node.
 * As of writing this workaround, only VSCode will be able to recover from errors (on edit).
 */
function isFatal() {
    return isTerminal() && cache.viewDiagnostics.size !== 0;
}

function isTerminal() {
    return process.env.VSCODE_PID === undefined;
}

function setViewsDiagnostic(error: InvalidQueryError) {
    cache.viewDiagnostics = new Map();

    for (const diagnostic of error.diagnostics) {
        cache.viewDiagnostics.has(diagnostic.fileName)
            ? cache.viewDiagnostics.get(diagnostic.fileName)?.push(diagnostic)
            : cache.viewDiagnostics.set(diagnostic.fileName, [diagnostic]);
    }
}

function printError(message: string, colors: boolean | undefined) {
    if (colors === false) {
        // eslint-disable-next-line no-control-regex
        return message.replace(/\x1b\[[0-9;]*[a-zA-Z]/gm, "");
    }

    return message;
}
