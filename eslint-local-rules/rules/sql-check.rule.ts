import { TSESTree } from "@typescript-eslint/typescript-estree";
import { ParserServices, TSESLint } from "@typescript-eslint/utils";
import * as E from "fp-ts/Either";
import * as J from "fp-ts/Json";
import { flow, pipe } from "fp-ts/function";
import path from "path";
import "source-map-support/register";
import { TsRunner, createSyncFn } from "synckit";
import invariant from "tiny-invariant";
import { TypeChecker } from "typescript";
import { Config, loadConfigFile, sqlUniqueTypeName } from "../../mfsqlchecker/ConfigFile";
import { ErrorDiagnostic, SrcSpan } from "../../mfsqlchecker/ErrorDiagnostic";
import { Either as OldEither } from "../../mfsqlchecker/either";
import { codeFrameFormatter } from "../../mfsqlchecker/formatters/codeFrameFormatter";
import zodToJsonSchema from "zod-to-json-schema";
import {
    SqlType,
    TypeScriptType,
    buildInsertCallExpression,
    buildQueryCallExpression,
    resolveInsertMany,
    resolveQueryFragment
} from "../../mfsqlchecker/queries";
import { getSqlViews } from "../../mfsqlchecker/sqlchecker_engine";
import { QualifiedSqlViewName, SqlCreateView, SqlViewDefinition } from "../../mfsqlchecker/views";
import { createRule } from "../utils";
import { memoize } from "../utils/memoize";
import { InvalidQueryError, RunnerError } from "./sql-check.errors";
import {
    INSERT_METHOD_NAMES,
    QUERY_METHOD_NAMES,
    locateNearestPackageJsonDir
} from "./sql-check.utils";
import { WorkerParams, WorkerResult } from "./sql-check.worker";
import { z } from "zod";
import { customLog } from "../utils/log";

const messages = {
    missing: "Missing: {{value}}",
    invalid: "Invalid: {{value}}",
    internal: "Internal error: {{value}}"
};

const zOptions = z.object({
    configFile: z.string(),
    migrationsDir: z.string()
});

export const zRuleOptions = z.tuple([zOptions]);
export type RuleOptions = z.infer<typeof zRuleOptions>;
export type RuleMessage = keyof typeof messages;
export type RuleContext = Readonly<TSESLint.RuleContext<RuleMessage, RuleOptions>>;

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
        schema: zodToJsonSchema(zRuleOptions, { target: "openApi3" }) as object,
        fixable: "code"
    },
    defaultOptions: [{ configFile: "mfsqlchecker.json", migrationsDir: "migrations" }],
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

type FileName = string;

let cache: Partial<{
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
        cache.retries === true ||
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
                data: { value: error.message }
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
            data: { value: diagnostics.map(codeFrameFormatter).join("\n") },
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

function checkInsertExpression(params: {
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
    if (cache.retries === true) {
        return;
    }

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
        customLog.success("initial load from call expression");
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
}): E.Either<InvalidQueryError | RunnerError, undefined> {
    const { node, context, parser, checker, projectDir } = params;
    const [{ configFile, migrationsDir }] = context.options;

    const configE = pipe(
        E.Do,
        E.chain(() => toFpTsEither(loadConfigFile(path.join(projectDir, configFile)))),
        E.mapLeft((diagnostic) => new InvalidQueryError([diagnostic]))
    );

    if (E.isLeft(configE)) {
        cache.retries = true;

        context.report({
            node: node,
            messageId: "internal",
            data: { value: configE.left.message }
        });

        return configE;
    }

    const config = configE.right;
    const uniqueTableColumnTypes = getTSUniqueColumnTypes(config.uniqueTableColumnTypes);
    const program = parser.program;
    const sourceFiles = program.getSourceFiles().filter((s) => !s.isDeclarationFile);

    const initE = pipe(
        E.Do,
        E.chain(() => {
            customLog.success("getting sql views");

            return getSqlViews({
                projectDir,
                checker,
                program,
                sourceFiles: sourceFiles.map((x) => x.fileName)
            });
        }),
        E.mapLeft((diagnostics) => new InvalidQueryError(diagnostics)),
        E.chainFirstW(({ sqlViews }) => {
            const totalSqlViews = [...sqlViews.values()].flat();
            customLog.success(`got ${totalSqlViews.length} sql views. initializing worker.`);
            return runWorker({
                action: "INITIALIZE",
                projectDir: projectDir,
                configFile: configFile,
                migrationsDir: migrationsDir,
                strictDateTimeChecking: config.strictDateTimeChecking ?? true,
                uniqueTableColumnTypes: config.uniqueTableColumnTypes,
                sqlViews: totalSqlViews,
                force: params.force
            });
        })
    );

    if (E.isLeft(initE)) {
        cache.retries = true;
        context.report({
            node: node,
            messageId: "internal",
            data: { value: initE.left.message }
        });

        return initE;
    }

    cache.isInitial = false;
    cache.retries = false;
    cache.config = config;
    cache.tsUniqueTableColumnTypes = uniqueTableColumnTypes;
    cache.sqlViews = initE.right.sqlViews;
    cache.viewLibrary = initE.right.viewLibrary;

    return E.right(undefined);
}
