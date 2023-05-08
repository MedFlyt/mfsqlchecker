import { TSESTree } from "@typescript-eslint/typescript-estree";
import { TSESLint } from "@typescript-eslint/utils";
import assertNever from "assert-never";
import * as E from "fp-ts/Either";
import * as TE from "fp-ts/TaskEither";
import * as T from "fp-ts/Task";
import { pipe, identity } from "fp-ts/function";
import fs from "fs";
import path from "path";
import { PostgresError } from "postgres";
import { loadConfigFile } from "../../mfsqlchecker/ConfigFile";
import { PostgresServer, PostgresVersion } from "../../mfsqlchecker/launch_postgres";
import { parsePostgreSqlError } from "../../mfsqlchecker/pg_extra";
import { isTestDatabaseCluster } from "../../mfsqlchecker/pg_test_db";
import { createRule } from "../utils";
import { QueryRunner } from "./DbConnector";

const DEFAULT_POSTGRES_VERSION: PostgresVersion = "10.10";

const messages = {
    missing: "Missing: {{value}}",
    invalid: "Invalid: {{value}}"
};

let postgresServerInstance: PostgresServer | null = null;

const pendingTasks: Promise<unknown>[] = [];

export const sqlCheck = createRule({
    name: "sql-check",
    meta: {
        docs: {
            description:
                "Statically validate correctness of all your SQL queries. TypeScript, PostgreSQL",
            recommended: "error"
        },
        messages: {
            missing: "Missing: {{value}}",
            invalid: "Invalid: {{value}}"
        },
        type: "suggestion",
        schema: []
    },
    defaultOptions: [],
    create(context) {
        return {
            CallExpression: (node) => pendingTasks.push(checkCallExpression({ node, context })),
            "Program:exit": () => Promise.all([...pendingTasks, postgresServerInstance?.close()])
        };
    }
});

type RuleMessage = keyof typeof messages;
type RuleOptions = never[];
type RuleContext = TSESLint.RuleContext<RuleMessage, RuleOptions>;

const queryMethodNames = new Set(["query", "queryOne", "queryOneOrNone"]);
const insertMethodNames = new Set(["insert", "insertMaybe"]);
const validMethodNames = new Set([...queryMethodNames, ...insertMethodNames]);

interface Options {
    readonly projectDir: string;
    readonly migrationsDir: string | null;
    readonly configFile: string | null;
    readonly postgresConnection: PostgresConnection | null;
}

let config: {
    options: Options;
    queryRunner: QueryRunner;
    pgServer: PostgresServer | null;
} | null = null;

let setupPromise: Promise<void> | null = null;

async function checkCallExpression(params: {
    node: TSESTree.CallExpression;
    context: RuleContext;
}) {
    const { node, context } = params;
    const callExpressionValidityE = getCallExpressionValidity(node);

    if (E.isLeft(callExpressionValidityE) || context.parserServices === undefined) {
        return;
    }

    if (setupPromise === null) {
        const program = pipe(
            initializeTE({ context, node }),
            TE.matchW(
                (error) => {
                    context.report({
                        node: node,
                        messageId: "invalid",
                        data: { value: `${error}` }
                    });
                },
                (res) => {
                    console.log("xxx");
                    config = {
                        options: res.options,
                        pgServer: res.server.pgServer,
                        queryRunner: res.runner
                    };
                }
            )
        );
        setupPromise = program();
    }

    console.log("waiting");
    await setupPromise;
    console.log("config resolved", config);

    // const r = initOptions({
    //     projectDir: projectDir,
    //     configFile: "demo/mfsqlchecker.json",
    //     migrationsDir: "demo/migrations",
    //     postgresConnection: null
    // });

    // if (E.isLeft(r)) {
    //     return context.report({
    //         node: node.callee,
    //         messageId: "invalid",
    //         data: { value: r.left }
    //     });
    // }

    // const options = r.right;

    // const r2 = await initPgServerTE(options)();

    // console.log(r2);

    // const callExpressionValidityE = getCallExpressionValidity(node);

    // if (E.isLeft(callExpressionValidityE) || context.parserServices === undefined) {
    //     return;
    // }

    // const { callee, property, argument } = callExpressionValidityE.right;
    // const sourceCode = context.getSourceCode();

    // return context.report({
    //     node: callee,
    //     messageId: "invalid",
    //     data: { value: sourceCode.getText(argument.quasi) }
    // });

    // const program = pipe(
    //     TE.Do,
    //     TE.bindW("settings", () => (settingsCache !== null ? TE.of(settingsCache) : initializeTE)),
    //     // TE.bindW("runner", ({ settings }) => {
    //     //     return TE.of(new SqlCheckerEngine(settings.options.configFile, settings.queryRunner));
    //     // }),
    //     TE.match(
    //         (err) => {
    //             context.report({
    //                 node: callee,
    //                 messageId: "invalid",
    //                 data: { value: sourceCode.getText(argument) }
    //             });
    //         },
    //         () => {
    //             context.report({
    //                 node: callee,
    //                 messageId: "invalid",
    //                 data: { value: sourceCode.getText(argument) }
    //             });
    //         }
    //     )
    // );

    // return program();
}

function initializeTE(params: { context: RuleContext; node: TSESTree.CallExpression }) {
    const { context, node } = params;

    const projectDir = memoize({
        key: context.getFilename(),
        value: () => locateNearestPackageJsonDir(context.getFilename())
    });

    const program = pipe(
        TE.Do,
        TE.chainFirstW(() => {
            console.log("init");
            return TE.of(undefined);
        }),
        TE.bindW("options", () =>
            initOptionsTE({
                projectDir: projectDir,
                configFile: "demo/mfsqlchecker.json",
                migrationsDir: "demo/migrations",
                postgresConnection: null
            })
        ),
        TE.bindW("server", ({ options }) => initPgServerTE(options)),
        TE.bindW("runner", ({ server, options }) => {
            return QueryRunner.ConnectTE({
                adminUrl: server.url,
                name: server.dbName,
                migrationsDir: options.migrationsDir
            });
        })
    );

    return program;
}

function getCallExpressionValidity(node: TSESTree.CallExpression) {
    if (node.callee.type !== "MemberExpression") {
        return E.left("CALLEE_NOT_MEMBER_EXPRESSION");
    }

    if (node.callee.property.type !== "Identifier") {
        return E.left("CALLEE_PROPERTY_NOT_IDENTIFIER");
    }

    if (!validMethodNames.has(node.callee.property.name)) {
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
        property: node.callee.property,
        argument: argument
    });
}

function initQueryRunnerTE(params: {
    migrationsDir: string;
    url: string;
    dbName: string | undefined;
}) {
    return pipe(
        TE.tryCatch(
            () =>
                QueryRunner.Connect({
                    adminUrl: params.url,
                    migrationsDir: params.migrationsDir,
                    name: params.dbName
                }),
            E.toError
        ),
        TE.mapLeft((err: Error | PostgresError) => {
            const errors: string[] = [];
            const pgError = parsePostgreSqlError(err);

            if (pgError !== null) {
                errors.push("Error connecting to database cluster:");
                errors.push(pgError.message);
                errors.push("code: " + pgError.code);

                if (pgError.detail !== null && pgError.detail !== pgError.message) {
                    errors.push("detail: " + pgError.detail);
                }

                if (pgError.hint !== null) {
                    errors.push("hint: " + pgError.hint);
                }

                return errors.join("\n");
            }

            if ("code" in err) {
                errors.push("Error connecting to database cluster:");
                errors.push(err.message);

                return errors.join("\n");
            }

            return err.message;
        })
    );
}

interface PostgresConnection {
    readonly url: string;
    readonly databaseName: string | undefined;
}

interface Options {
    readonly migrationsDir: string | null;
    readonly configFile: string | null;
    readonly postgresConnection: PostgresConnection | null;
}

export function initOptionsTE(options: Options) {
    return TE.fromEither(initOptionsE(options));
}

export function initOptionsE(options: Options) {
    if (
        options.postgresConnection !== null &&
        !isTestDatabaseCluster(options.postgresConnection.url)
    ) {
        return E.left(
            "Database Cluster url is not a local connection or is invalid:\n" +
                options.postgresConnection.url
        );
    }

    if (
        options.postgresConnection !== null &&
        !isTestDatabaseCluster(options.postgresConnection.url)
    ) {
        return E.left(
            "Database Cluster url is not a local connection or is invalid:\n" +
                options.postgresConnection.url
        );
    }

    let migrationsDir: string | null = null;
    let postgresVersion: PostgresVersion = DEFAULT_POSTGRES_VERSION;

    if (options.configFile !== null) {
        const absoluteConfigFile = path.join(options.projectDir, options.configFile);
        const config = loadConfigFile(absoluteConfigFile);
        switch (config.type) {
            case "Left": {
                const errors = [
                    `Error Loading config file: ${absoluteConfigFile}`,
                    ...config.value.messages
                ];
                return E.left(errors.join("\n"));
            }
            case "Right":
                if (config.value.postgresVersion !== null) {
                    postgresVersion = config.value.postgresVersion as PostgresVersion;
                }
                if (config.value.migrationsDir !== null) {
                    if (path.isAbsolute(config.value.migrationsDir)) {
                        migrationsDir = config.value.migrationsDir;
                    } else {
                        migrationsDir = path.join(
                            path.dirname(options.configFile),
                            config.value.migrationsDir
                        );
                    }
                }
                break;
            default:
                return assertNever(config);
        }
    }
    if (options.migrationsDir !== null) {
        migrationsDir = options.migrationsDir;
    }

    if (migrationsDir === null) {
        return E.left("migrations-dir is missing. Must be set in config file or command line");
    }

    return E.right({
        ...options,
        migrationsDir,
        postgresVersion
    });
}

const startOrGetPgServer = (
    options: Pick<Options, "postgresConnection"> & { postgresVersion: PostgresVersion }
): TE.TaskEither<
    Error,
    { url: string; dbName: string | undefined; pgServer: PostgresServer | null }
> => {
    if (options.postgresConnection !== null) {
        return TE.right({
            url: options.postgresConnection.url,
            dbName: options.postgresConnection.databaseName,
            pgServer: null
        });
    } else {
        return pipe(
            TE.tryCatch(() => PostgresServer.start(options.postgresVersion), E.toError),
            TE.map((pgServer) => ({
                url: pgServer.url,
                dbName: undefined,
                pgServer
            }))
        );
    }
};

export function initPgServerTE(options: Options & { postgresVersion: PostgresVersion }) {
    return pipe(
        startOrGetPgServer(options),
        TE.chain((result) => {
            process.on("crash", () => result.pgServer?.close());
            process.on("SIGINT", () => result.pgServer?.close());
            return TE.right(result);
        })
    );
}

const memoized = new Map();

export function memoize<T>(params: { key: string; value: () => T }): T {
    const { key, value } = params;

    if (memoized.has(key)) {
        return memoized.get(key);
    }

    const result = value();

    memoized.set(key, result);

    return result;
}

export function locateNearestPackageJsonDir(filePath: string): string {
    const dir = path.dirname(filePath);
    const packageJsonFile = path.join(dir, "package.json");
    if (fs.existsSync(packageJsonFile)) {
        return dir;
    }
    return locateNearestPackageJsonDir(dir);
}
