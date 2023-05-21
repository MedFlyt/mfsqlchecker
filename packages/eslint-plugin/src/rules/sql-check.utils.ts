import EmbeddedPostgres from "embedded-postgres";
import { E, TE, pipe } from "../utils/fp-ts";
import fs from "fs";
import path from "path";
import { Sql } from "postgres";
import { Config, UniqueTableColumnType } from "@mfsqlchecker/core";
import { connectPg, isTestDatabaseCluster, SqlCreateView } from "@mfsqlchecker/core";
import { QueryRunner } from "../utils/query-runner";
import { RunnerError } from "../utils/errors";
import { customLog } from "../utils/log";

export interface PostgresConnection {
    readonly url: string;
    readonly databaseName: string | undefined;
}

export interface Options {
    readonly projectDir: string;
    readonly config: Config;
    readonly postgresConnection: PostgresConnection | null;
}

export function initializeTE(params: {
    projectDir: string;
    config: Config;
    migrationsDir: string;
    uniqueTableColumnTypes: UniqueTableColumnType[];
    strictDateTimeChecking: boolean;
    sqlViews: SqlCreateView[];
}) {
    return pipe(
        TE.Do,
        TE.bindW("options", () => {
            customLog.success("loading config file");
            return TE.fromEither(
                initOptionsE({
                    projectDir: params.projectDir,
                    config: params.config,
                    postgresConnection: null
                })
            );
        }),
        TE.bindW("server", ({ options }) => {
            customLog.success("initializing pg server");
            return initPgServerTE(options);
        }),
        TE.bindW("runner", ({ server, options }) => {
            customLog.success("connecting to database");
            return QueryRunner.ConnectTE({
                sql: server.sql,
                adminUrl: server.adminUrl,
                name: server.dbName,
                migrationsDir: path.join(params.projectDir, options.config.migrationsDir)
            });
        }),
        TE.chainFirstW(({ runner }) => {
            customLog.success("initializing database");
            return runner.initializeTE({
                strictDateTimeChecking: params.strictDateTimeChecking,
                uniqueTableColumnTypes: params.uniqueTableColumnTypes,
                sqlViews: params.sqlViews
            });
        }),
        TE.mapLeft((x) => {
            return x instanceof Error ? new RunnerError(x.message) : x;
        })
    );
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

    return E.right(options);
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

// See: <https://en.wikipedia.org/wiki/Ephemeral_port>
const MIN_PORT = 49152;
const MAX_PORT = 65534;

function randomPort(): number {
    return MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT));
}

function createEmbeddedPostgresTE(options: { projectDir: string }) {
    const databaseDir = path.join(options.projectDir, "embedded-pg");
    const postgresOptions: Pick<PostgresOptions, "user" | "port" | "password"> = {
        user: "postgres",
        password: "password",
        port: randomPort()
    };

    const pg = new EmbeddedPostgres({
        ...postgresOptions,
        database_dir: databaseDir,
        persistent: false
    });

    const adminUrl = `postgres://${postgresOptions.user}:${postgresOptions.password}@localhost:${postgresOptions.port}/postgres`;
    const testDbName = "shadow_database";
    const shouldInitialize = !fs.existsSync(databaseDir);

    const conditionalInitializeAndStartTE = shouldInitialize
        ? TE.tryCatch(() => pg.initialise(), E.toError)
        : TE.right(undefined);

    const recreateDatabaseTE = (sql: Sql) =>
        pipe(
            TE.Do,
            TE.bind("dbName", () => TE.right(sql(testDbName))),
            TE.chainFirst(({ dbName }) => {
                return TE.tryCatch(
                    () => sql`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`,
                    E.toError
                );
            }),
            TE.chainFirst(({ dbName }) =>
                TE.tryCatch(() => sql`CREATE DATABASE ${dbName}`, E.toError)
            )
        );

    return pipe(
        TE.Do,
        TE.chain(() => conditionalInitializeAndStartTE),
        TE.chainFirstEitherKW(() => tryTerminatePostmaster(databaseDir)),
        TE.chainFirst(() => TE.tryCatch(() => pg.start(), E.toError)),
        TE.chainFirst(() => {
            const x = isPostmasterAlive(databaseDir)
                ? TE.right(undefined)
                : TE.tryCatch(() => pg.start(), E.toError);

            return x;
        }),
        TE.bind("sql", () => TE.right(connectPg(adminUrl))),
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
    const pid = getPostmasterPid(path);

    if (pid !== undefined) {
        customLog.info("terminating postmaster", pid);
        try {
            process.kill(pid, "SIGQUIT");
        } catch {
            // do nothing
        }
    }

    return E.right(undefined);
}

export function initPgServerTE(options: Options) {
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
