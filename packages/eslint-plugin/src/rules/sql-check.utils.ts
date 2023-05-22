import EmbeddedPostgres from "embedded-postgres";
import { E, TE, pipe } from "../utils/fp-ts";
import fs from "fs";
import path from "path";
import { Sql } from "postgres";
import { Config, UniqueTableColumnType } from "@mfsqlchecker/core";
import { connectPg, isTestDatabaseCluster, SqlCreateView } from "@mfsqlchecker/core";
import crypto from "crypto";
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
    configFilePath: string;
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
        TE.bindW("absMigrationsDir", ({ options }) => {
            return TE.right(path.join(path.dirname(params.configFilePath), options.config.migrationsDir));
        }),
        TE.bindW("embeddedDir", ({ options }) => {
            return TE.right(path.join(options.projectDir, "embedded-pg"));
        }),
        TE.bind("hash", ({ absMigrationsDir }) => generateFolderHashTE(absMigrationsDir)),
        TE.bind("cachedHash", ({ embeddedDir }) => getMigrationsHashTE(embeddedDir)),
        TE.bind("loadFromCache", ({ cachedHash, hash }) => {
            if (cachedHash === hash) {
                customLog.success("migrations hash matches. loading from cache.");
                return TE.right(true);
            }

            customLog.info("migrations hash does not match. loading from scratch.");
            return TE.right(false);
        }),
        TE.bindW("server", ({ options, loadFromCache }) => {
            customLog.success(`initializing pg server (load from cache: ${loadFromCache})`);
            return createEmbeddedPostgresTE({
                projectDir: options.projectDir,
                shouldRecreateDatabase: !loadFromCache
            });
        }),
        TE.bindW("runner", ({ server, absMigrationsDir }) => {
            customLog.success("connecting to database");
            return QueryRunner.ConnectTE({
                adminUrl: server.adminUrl,
                name: server.dbName,
                migrationsDir: absMigrationsDir
            });
        }),
        TE.chainFirstW(({ runner, hash, loadFromCache, embeddedDir }) => {
            return pipe(
                TE.Do,
                TE.chainFirst(() => {
                    customLog.success(`initializing runner (reset: ${!loadFromCache})`);
                    return runner.initializeTE({
                        strictDateTimeChecking: params.strictDateTimeChecking,
                        uniqueTableColumnTypes: params.uniqueTableColumnTypes,
                        sqlViews: params.sqlViews,
                        reset: !loadFromCache
                    });
                }),
                TE.chainFirst(() => {
                    if (loadFromCache) {
                        return TE.right(null);
                    }

                    customLog.success(`storing migrations hash: ${hash}`);
                    return writeMigrationsHashTE(embeddedDir, hash);
                })
            );
        }),
        TE.mapLeft((x) => {
            return x instanceof Error ? new RunnerError(x.message) : x;
        })
    );
}

function writeMigrationsHashTE(embeddedDir: string, hash: string) {
    return TE.tryCatch(
        () => fs.promises.writeFile(path.join(embeddedDir, "migrations-hash.txt"), hash),
        E.toError
    );
}

function getMigrationsHashTE(embeddedPath: string) {
    return pipe(
        TE.Do,
        TE.bind("exists", () =>
            TE.tryCatch(
                () =>
                    fs.promises
                        .access(path.join(embeddedPath, "migrations-hash.txt"))
                        .then(() => true)
                        .catch(() => false),
                E.toError
            )
        ),
        TE.chain(({ exists }) => {
            if (!exists) {
                return TE.right(null);
            }

            return TE.tryCatch(
                () => fs.promises.readFile(path.join(embeddedPath, "migrations-hash.txt"), "utf-8"),
                E.toError
            );
        })
    );
}

function generateFolderHashTE(folderPath: string) {
    const hash = crypto.createHash("sha256");

    return pipe(
        TE.Do,
        TE.chain(() => TE.tryCatch(() => fs.promises.readdir(folderPath), E.toError)),
        TE.chain((fileList) =>
            TE.tryCatch(
                () =>
                    Promise.all(
                        fileList.map((file) => fs.promises.readFile(path.join(folderPath, file)))
                    ),
                E.toError
            )
        ),
        TE.map((fileBuffers) => fileBuffers.forEach((fileBuffer) => hash.update(fileBuffer))),
        TE.map(() => hash.digest("hex"))
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

function createEmbeddedPostgresTE(options: {
    projectDir: string;
    shouldRecreateDatabase: boolean;
}) {
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
            TE.chainFirst(({ dbName }) => {
                return TE.tryCatch(() => sql`CREATE DATABASE ${dbName}`, E.toError);
            }),
            TE.chainFirst(() => TE.tryCatch(() => sql.end(), E.toError))
        );

    return pipe(
        TE.Do,
        TE.chain(() => conditionalInitializeAndStartTE),
        TE.chainFirst(() => {
            if (isPostmasterAlive(databaseDir)) {
                return TE.right(undefined);
            }

            customLog.info("starting pg server");

            return TE.tryCatch(() => pg.start(), E.toError);
        }),
        TE.bind("sql", () => TE.right(connectPg(adminUrl))),
        TE.chainFirst(({ sql }) => {
            return options.shouldRecreateDatabase ? recreateDatabaseTE(sql) : TE.right(undefined);
        }),
        TE.map(() => ({ pg, options: postgresOptions, adminUrl, dbName: testDbName }))
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
