import "source-map-support/register"; // tslint:disable-line:no-import-side-effect

import { assertNever } from "assert-never";
import * as commander from "commander";
import * as E from "fp-ts/Either";
import { pipe } from "fp-ts/function";
import * as TE from "fp-ts/TaskEither";
import * as path from "path";
import { PostgresError } from "postgres";
import { loadConfigFile } from "./ConfigFile";
import { DbConnector } from "./DbConnector";
import { PostgresServer, PostgresVersion } from "./launch_postgres";
import { parsePostgreSqlError } from "./pg_extra";
import { isTestDatabaseCluster } from "./pg_test_db";

const DEFAULT_POSTGRES_VERSION: PostgresVersion = "10.10";

interface PostgresConnection {
    readonly url: string;
    readonly databaseName: string | undefined;
}

enum Format {
    CODE_FRAME,
    JSON,
    VSCODE
}

export interface Options {
    readonly watchMode: boolean;
    readonly projectDir: string;
    readonly migrationsDir: string | null;
    readonly configFile: string | null;
    readonly postgresConnection: PostgresConnection | null;
    readonly format: Format;
}

export class ParseError extends Error {
    constructor(public readonly message: string) {
        super(message);
    }
}

function parseFormat(value: string): Format {
    switch (value) {
        case "code-frame":
            return Format.CODE_FRAME;
        case "json":
            return Format.JSON;
        case "vscode":
            return Format.VSCODE;
        default:
            throw new ParseError(`invalid format: "${value}"`);
    }
}

function parseOptions(): Options {
    const program = new commander.Command();
    program.version("0.0.23");

    program
        .option("-w, --watch", "watch mode")
        .option("-p, --project <dir>", "Project directory that should be checked")
        .option("-m, --migrations <dir>", "Migrations directory that should be used")
        .option("-c, --config <file>", "Project config file")
        .option("-u, --postgres-url <url>", "PostgreSQL connection string")
        .option("-d, --db-name <name>", "Name of database to use")
        .option("--postgres-version <version>", "Version of PostgreSQL server to test against")
        .option("-t, --format <format>", "code-frame", parseFormat, Format.CODE_FRAME);

    try {
        program.parse(process.argv);
    } catch (err) {
        if (err instanceof ParseError) {
            console.error("error: " + err.message);
            process.exit(1);
        } else {
            throw err;
        }
    }

    if (process.argv.slice(2).length === 0) {
        program.outputHelp();
        process.exit(1);
    }

    function required(arg: string, argFlag: string) {
        if (!program[arg]) {
            console.error(`error: missing required argument: ${argFlag}`);
            process.exit(1);
        }
    }

    required("project", "--project");

    if (program.dbName && !program.postgresUrl) {
        console.error(`error: --db-name argument can only be used together with --postgres-url`);
        process.exit(1);
    }

    let postgres: PostgresConnection | null;
    if (program.postgresUrl) {
        postgres = {
            url: program.postgresUrl,
            databaseName: program.dbName ? program.dbName : undefined
        };
    } else {
        postgres = null;
    }

    const options: Options = {
        watchMode: program.watch === true,
        projectDir: program.project,
        migrationsDir: program.migrations ? program.migrations : null,
        configFile: program.config ? program.config : null,
        postgresConnection: postgres,
        format: program.format
    };
    return options;
}

function initOptions() {
    const options = parseOptions();

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
        const config = loadConfigFile(options.configFile);
        switch (config.type) {
            case "Left": {
                const errors = [
                    `Error Loading config file: ${options.configFile}`,
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
    options: Options & { postgresVersion: PostgresVersion }
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

function initPgServerTE(options: Options & { postgresVersion: PostgresVersion }) {
    return pipe(
        startOrGetPgServer(options),
        TE.chain((result) => {
            process.on("crash", () => result.pgServer?.close());
            process.on("SIGINT", () => result.pgServer?.close());
            return TE.right(result);
        })
    );
}

function initDbConnectorTE(params: {
    migrationsDir: string;
    url: string;
    dbName: string | undefined;
}) {
    return pipe(
        TE.tryCatch(
            () => DbConnector.Connect(params.migrationsDir, params.url, params.dbName),
            E.toError
        ),
        TE.mapLeft((err: Error | PostgresError) => {
            const errors = [];
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

export const initialize = pipe(
    TE.Do,
    TE.bindW("options", () => TE.fromEither(initOptions())),
    TE.bindW("pgServer", ({ options }) => initPgServerTE(options)),
    TE.bindW("dbConnector", ({ options, pgServer }) => {
        return initDbConnectorTE({
            migrationsDir: options.migrationsDir,
            url: pgServer.url,
            dbName: pgServer.dbName
        });
    })
);
