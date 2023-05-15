import assertNever from "assert-never";
import EmbeddedPostgres from "embedded-postgres";
import * as E from "fp-ts/Either";
import { pipe } from "fp-ts/function";
import * as TE from "fp-ts/TaskEither";
import fs from "fs";
import path from "path";
import { Sql } from "postgres";
import { loadConfigFile, UniqueTableColumnType } from "../../mfsqlchecker/ConfigFile";
import { connectPg } from "../../mfsqlchecker/pg_extra";
import { isTestDatabaseCluster } from "../../mfsqlchecker/pg_test_db";
import { SqlCreateView } from "../../mfsqlchecker/views";
import { QueryRunner } from "./DbConnector";
import { RunnerError } from "./sql-check.errors";

type PostgresVersion = "14.6.0";

export interface PostgresConnection {
    readonly url: string;
    readonly databaseName: string | undefined;
}

export interface Options {
    readonly projectDir: string;
    readonly migrationsDir: string | null;
    readonly configFile: string | null;
    readonly postgresConnection: PostgresConnection | null;
}

export const DEFAULT_POSTGRES_VERSION: PostgresVersion = "14.6.0";
export const QUERY_METHOD_NAMES = new Set(["query", "queryOne", "queryOneOrNone"]);
export const INSERT_METHOD_NAMES = new Set(["insert", "insertMaybe"]);
export const VALID_METHOD_NAMES = new Set([...QUERY_METHOD_NAMES, ...INSERT_METHOD_NAMES]);

export function initializeTE(params: {
    projectDir: string;
    uniqueTableColumnTypes: UniqueTableColumnType[];
    strictDateTimeChecking: boolean;
    viewLibrary: SqlCreateView[];
}) {
    return pipe(
        TE.Do,
        TE.bindW("options", () => {
            console.log("Loading config file...");
            return initOptionsTE({
                projectDir: params.projectDir,
                configFile: "demo/mfsqlchecker.json",
                migrationsDir: "demo/migrations",
                postgresConnection: null
            });
        }),
        TE.bindW("server", ({ options }) => {
            return initPgServerTE(options);
        }),
        TE.bindW("runner", ({ server, options }) => {
            console.log("Connecting to database...");
            return QueryRunner.ConnectTE({
                sql: server.sql,
                adminUrl: server.adminUrl,
                name: server.dbName,
                migrationsDir: options.migrationsDir
            });
        }),
        TE.chainFirstW(({ runner }) => {
            console.log("Initializing database...");
            return runner.initializeTE({
                strictDateTimeChecking: params.strictDateTimeChecking,
                uniqueTableColumnTypes: params.uniqueTableColumnTypes,
                viewLibrary: params.viewLibrary
            });
        }),
        TE.mapLeft((x) => {
            return x instanceof Error ? new RunnerError(x.message) : x;
        })
    );
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
            new Error(
                "Database Cluster url is not a local connection or is invalid:\n" +
                    options.postgresConnection.url
            )
        );
    }

    if (
        options.postgresConnection !== null &&
        !isTestDatabaseCluster(options.postgresConnection.url)
    ) {
        return E.left(
            new Error(
                "Database Cluster url is not a local connection or is invalid:\n" +
                    options.postgresConnection.url
            )
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
                return E.left(new Error(errors.join("\n")));
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
        return E.left(
            new Error("migrations-dir is missing. Must be set in config file or command line")
        );
    }

    return E.right({
        ...options,
        migrationsDir,
        postgresVersion
    });
}

export interface PostgresOptions {
    /** The location where the data should be persisted to. Defaults to: `./data/db` */
    database_dir: string;
    /** The port where the Postgres database should be listening. Defaults to:
     *  `5432` */
    port: number;
    /** The username for logging into the Postgres database. Defaults to `postgres` */
    user: string;
    /** The password for logging into the Postgres database. Defaults to `password` */
    password: string;
    /** The authentication method to use when authenticating against Postgres.
     * Defaults to `password`  */
    auth_method: "scram-sha-256" | "password" | "md5";
    /** Whether all data should be left in place when the database is shut down.
     * Defaults to true. */
    persistent: boolean;
}

function createEmbeddedPostgresTE(options: { projectDir: string }) {
    const databaseDir = path.join(options.projectDir, "embedded-pg");
    const postgresOptions: Pick<PostgresOptions, "user" | "port" | "password"> = {
        user: "postgres",
        password: "password",
        port: 5431
    };

    const pg = new EmbeddedPostgres({
        ...postgresOptions,
        database_dir: databaseDir,
        persistent: false
    });

    const adminUrl = `postgres://${postgresOptions.user}:${postgresOptions.password}@localhost:${postgresOptions.port}/postgres`;
    const testDbName = "test_eliya";
    const shouldInitialize = !fs.existsSync(databaseDir);

    const conditionalInitializeAndStartTE = shouldInitialize
        ? TE.tryCatch(() => pg.initialise(), E.toError)
        : TE.right(undefined);

    const recreateDatabaseTE = (sql: Sql) =>
        pipe(
            TE.Do,
            TE.bind("dbName", () => TE.right((sql(testDbName) as any).value)),
            TE.chainFirst(({ dbName }) => {
                return TE.tryCatch(
                    () => sql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`),
                    E.toError
                );
            }),
            TE.chainFirst(({ dbName }) =>
                TE.tryCatch(() => sql.unsafe(`CREATE DATABASE ${dbName}`), E.toError)
            )
        );

    return pipe(
        TE.Do,
        TE.chain(() => conditionalInitializeAndStartTE),
        // TE.chainFirstEitherKW(() => tryTerminatePostmaster(databaseDir)),
        // TE.chainFirst(() => TE.tryCatch(() => pg.start(), E.toError)),
        TE.chainFirst(() => {
            const x = isPostmasterAlive(databaseDir)
                ? TE.right(undefined)
                : TE.tryCatch(() => pg.start(), E.toError);

            return x;
        }),
        TE.bind("sql", () => TE.right(connectPg(adminUrl))),
        // TE.chainFirst(({ client }) => TE.tryCatch(() => client.connect(), E.toError)),
        TE.chainFirst(({ sql }) => {
            return recreateDatabaseTE(sql);
        }),
        TE.map(({ sql }) => ({ pg, options: postgresOptions, adminUrl, dbName: testDbName, sql }))
    );
}

function isPostmasterAlive(path: string) {
    const pid = getPostmasterPid(path);

    if (pid === undefined) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

function tryTerminatePostmaster(path: string) {
    console.log("Terminating postmaster");
    const pid = getPostmasterPid(path);
    console.log("Terminating postmaster", pid);

    if (pid !== undefined) {
        console.log(`Terminating postmaster with pid: ${pid}`);
        process.kill(pid, "SIGQUIT");
    }

    return E.right(undefined);
}

export function initPgServerTE(options: Options & { postgresVersion: PostgresVersion }) {
    return pipe(
        createEmbeddedPostgresTE(options),
        TE.map((result) => {
            process.on("exit", () => {
                result.sql.end();
                result.pg.stop();
            });

            return result;
        })
    );
}

export function locateNearestPackageJsonDir(filePath: string): string {
    const dir = path.dirname(filePath);
    const packageJsonFile = path.join(dir, "package.json");
    if (fs.existsSync(packageJsonFile)) {
        return dir;
    }
    return locateNearestPackageJsonDir(dir);
}

function getPostmasterPid(filePath: string): number | undefined {
    const pidFile = path.join(filePath, "postmaster.pid");

    if (!fs.existsSync(pidFile)) {
        return;
    }

    const fileContents = fs.readFileSync(pidFile, "utf8");
    const lines = fileContents.split("\n");
    const pid = parseInt(lines[0]);

    if (isNaN(pid)) {
        return;
    }

    return pid;
}
