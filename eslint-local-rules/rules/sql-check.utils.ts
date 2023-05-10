import assertNever from "assert-never";
import * as E from "fp-ts/Either";
import * as TE from "fp-ts/TaskEither";
import { pipe } from "fp-ts/function";
import fs from "fs";
import path from "path";
import { loadConfigFile } from "../../mfsqlchecker/ConfigFile";
// import { PostgresServer, PostgresVersion } from "../../mfsqlchecker/launch_postgres";
import { isTestDatabaseCluster } from "../../mfsqlchecker/pg_test_db";
import { QueryRunner } from "./DbConnector";
import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";

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

export function initializeTE(params: { projectDir: string }) {
    return pipe(
        TE.Do,
        TE.bindW("options", () =>
            initOptionsTE({
                projectDir: params.projectDir,
                configFile: "demo/mfsqlchecker.json",
                migrationsDir: "demo/migrations",
                postgresConnection: null
            })
        ),
        TE.bindW("server", ({ options }) => initPgServerTE(options)),
        TE.bindW("runner", ({ server, options }) => {
            return QueryRunner.ConnectTE({
                adminUrl: server.adminUrl,
                name: server.dbName,
                migrationsDir: options.migrationsDir
            });
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
        persistent: true
    });

    const adminUrl = `postgres://${postgresOptions.user}:${postgresOptions.password}@localhost:${postgresOptions.port}/postgres`;
    const testDbName = "test_eliya";
    const shouldInitialize = !fs.existsSync(databaseDir);
    const initializeAndStartTE = pipe(
        TE.Do,
        TE.chain(() => TE.tryCatch(() => pg.initialise(), E.toError)),
        TE.chain(() => TE.tryCatch(() => pg.start(), E.toError))
    );

    const conditionalInitializeAndStartTE = shouldInitialize
        ? initializeAndStartTE
        : TE.right(undefined);

    const recreateDatabaseTE = (client: Client) =>
        pipe(
            TE.Do,
            TE.bind("dbName", () => TE.right(client.escapeIdentifier(testDbName))),
            TE.chainFirst(({ dbName }) =>
                TE.tryCatch(() => client.query(`DROP DATABASE IF EXISTS ${dbName}`), E.toError)
            ),
            TE.chainFirst(({ dbName }) =>
                TE.tryCatch(() => client.query(`CREATE DATABASE ${dbName}`), E.toError)
            )
        );

    return pipe(
        TE.Do,
        TE.chain(() => conditionalInitializeAndStartTE),
        TE.bind("client", () => TE.right(pg.getPgClient())),
        TE.chainFirst(({ client }) => TE.tryCatch(() => client.connect(), E.toError)),
        TE.chainFirst(({ client }) => recreateDatabaseTE(client)),
        TE.map(() => ({ pg, options: postgresOptions, adminUrl, dbName: testDbName }))
    );
}

// const startOrGetPgServer = (
//     options: Pick<Options, "postgresConnection"> & { postgresVersion: PostgresVersion }
// ): TE.TaskEither<
//     Error,
//     { url: string; dbName: string | undefined; pgServer: PostgresServer | null }
// > => {
//     if (options.postgresConnection !== null) {
//         return TE.right({
//             url: options.postgresConnection.url,
//             dbName: options.postgresConnection.databaseName,
//             pgServer: null
//         });
//     } else {
//         return pipe(
//             TE.tryCatch(() => PostgresServer.start(options.postgresVersion), E.toError),
//             TE.map((pgServer) => ({
//                 url: pgServer.url,
//                 dbName: undefined,
//                 pgServer
//             }))
//         );
//     }
// };

export function initPgServerTE(options: Options & { postgresVersion: PostgresVersion }) {
    return pipe(
        createEmbeddedPostgresTE(options),
        TE.map((result) => {
            process.on("crash", () => result.pg.stop());
            process.on("SIGINT", () => result.pg.stop());
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
