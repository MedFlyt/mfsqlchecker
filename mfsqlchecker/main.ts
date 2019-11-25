import "source-map-support/register"; // tslint:disable-line:no-import-side-effect

import { assertNever } from "assert-never";
import * as commander from "commander";
import * as fs from "fs";
import * as path from "path";
import { loadConfigFile } from "./ConfigFile";
import { DbConnector } from "./DbConnector";
import { ErrorDiagnostic } from "./ErrorDiagnostic";
import { codeFrameFormatter } from "./formatters/codeFrameFormatter";
import { jsonFormatter } from "./formatters/jsonFormatter";
import { vscodeFormatter } from "./formatters/vscodeFormatter";
import { PostgresServer } from "./launch_postgres";
import { parsePostgreSqlError } from "./pg_extra";
import { isTestDatabaseCluster } from "./pg_test_db";
import { SqlCheckerEngine, typeScriptSingleRunCheck, TypeScriptWatcher } from "./sqlchecker_engine";

interface PostgresConnection {
    readonly url: string;
    readonly databaseName: string | undefined;
}

enum Format {
    CODE_FRAME,
    JSON,
    VSCODE
}

interface Options {
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
    program.version("0.0.16");

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

function formatFunction(format: Format): (errorDiagnostics: ErrorDiagnostic[]) => string {
    switch (format) {
        case Format.CODE_FRAME:
            return e => e.map(codeFrameFormatter).join("\n");
        case Format.JSON:
            return jsonFormatter;
        case Format.VSCODE:
            return e => e.map(vscodeFormatter).join("\n");
        default:
            return assertNever(format);
    }
}

async function main(): Promise<void> {
    const options = parseOptions();

    if (options.postgresConnection !== null && !isTestDatabaseCluster(options.postgresConnection.url)) {
        console.error("Database Cluster url is not a local connection or is invalid:\n" + options.postgresConnection.url);
        process.exit(1);
    }

    let migrationsDir: string | null = null;
    if (options.configFile !== null) {
        const config = loadConfigFile(options.configFile);
        switch (config.type) {
            case "Left":
                console.error(`Error Loading config file: ${options.configFile}`);
                for (const message of config.value.messages) {
                    console.error(message);
                }
                return process.exit(1);
            case "Right":
                if (config.value.migrationsDir !== null) {
                    if (path.isAbsolute(config.value.migrationsDir)) {
                        migrationsDir = config.value.migrationsDir;
                    } else {
                        migrationsDir = path.join(path.dirname(options.configFile), config.value.migrationsDir);
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
        console.error("migrations-dir is missing. Must be set in config file or command line");
        return process.exit(1);
    }

    const m = migrationsDir;
    const migrationsDirExists = await new Promise<boolean>((resolve) => {
        fs.stat(m, (err, stats) => {
            if (<any>err) {
                resolve(false);
                return;
            }
            resolve(stats.isDirectory());
        });
    });
    if (!migrationsDirExists) {
        console.error(`Migrations directory (${migrationsDir}) is not a readable directory`);
        return process.exit(1);
    }

    let pgServer: PostgresServer | null = null;

    let url: string;
    let dbName: string | undefined;
    if (options.postgresConnection !== null) {
        url = options.postgresConnection.url;
        dbName = options.postgresConnection.databaseName;
    } else {
        pgServer = await PostgresServer.start("10.10");
        url = pgServer.url;
        dbName = undefined;
    }
    try {
        process.on(<any>"crash", async () => {
            if (pgServer !== null) {
                await pgServer.close();
                pgServer = null;
            }
            process.exit(1);
        });

        process.on("SIGINT", async () => {
            if (pgServer !== null) {
                await pgServer.close();
                pgServer = null;
            }
            process.exit();
        });

        let dbConnector: DbConnector;
        try {
            dbConnector = await DbConnector.Connect(migrationsDir, url, dbName);
        } catch (err) {
            const perr = parsePostgreSqlError(err);
            if (perr !== null) {
                console.error("Error connecting to database cluster:");
                console.error(perr.message);
                console.error("code: " + perr.code);
                if (perr.detail !== null && perr.detail !== perr.message) {
                    console.error("detail: " + perr.detail);
                }
                if (perr.hint !== null) {
                    console.error("hint: " + perr.hint);
                }
            } else if (err.code) {
                console.error("Error connecting to database cluster:");
                console.error(err.message);
            } else {
                throw err;
            }
            return process.exit(1);
        }
        try {
            const formatter = formatFunction(options.format);
            const e = new SqlCheckerEngine(options.configFile, dbConnector);
            if (options.watchMode) {
                const w = new TypeScriptWatcher(e, formatter);
                w.run(options.projectDir);
                await blockForever();
            } else {
                const success = await typeScriptSingleRunCheck(options.projectDir, e, formatter);
                if (!success) {
                    process.exitCode = 1;
                }
            }
        } finally {
            await dbConnector.close();
        }
    } finally {
        if (pgServer !== null) {
            await pgServer.close();
        }
    }
}

function blockForever(): Promise<void> {
    return new Promise<void>(() => { /* Block Forever */ });
}

main();
