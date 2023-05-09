import { TSESTree } from "@typescript-eslint/typescript-estree";
import assertNever from "assert-never";
import * as E from "fp-ts/Either";
import { pipe } from "fp-ts/function";
import * as TE from "fp-ts/TaskEither";
import fs from "fs";
import path from "path";
import { loadConfigFile } from "../../mfsqlchecker/ConfigFile";
import { PostgresServer, PostgresVersion } from "../../mfsqlchecker/launch_postgres";
import { isTestDatabaseCluster } from "../../mfsqlchecker/pg_test_db";
import { memoize } from "../utils/memoize";
import { QueryRunner } from "./DbConnector";
import { RuleContext } from "./sql-check.rule";

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

export const DEFAULT_POSTGRES_VERSION: PostgresVersion = "10.10";
export const QUERY_METHOD_NAMES = new Set(["query", "queryOne", "queryOneOrNone"]);
export const INSERT_METHOD_NAMES = new Set(["insert", "insertMaybe"]);
export const VALID_METHOD_NAMES = new Set([...QUERY_METHOD_NAMES, ...INSERT_METHOD_NAMES]);

export function initializeTE(params: { projectDir: string }) {
    return pipe(
        TE.Do,
        TE.chainFirstW(() => {
            console.log("init");
            return TE.of(undefined);
        }),
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
                adminUrl: server.url,
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

export function locateNearestPackageJsonDir(filePath: string): string {
    const dir = path.dirname(filePath);
    const packageJsonFile = path.join(dir, "package.json");
    if (fs.existsSync(packageJsonFile)) {
        return dir;
    }
    return locateNearestPackageJsonDir(dir);
}
