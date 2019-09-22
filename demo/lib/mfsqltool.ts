import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as pg from "pg";
import * as stackTrace from "stack-trace";
import { fileLinesCrc32 } from "./crc32";
import { isMigrationFile, readdirAsync, readFileAsync } from "./utils";
import { calcViewName, extractViewName } from "./view_names";

export type ColumnParser<T> = (value: any) => T;

export class Connection<T> {
    /**
     * Used only to statically identify this type
     */
    protected readonly MfConnectionTypeTag: undefined;

    constructor(client: pg.Client) {
        this.client = client;
        this.preparePlaceholder;
    }

    readonly client: pg.Client;

    /**
     * May be overriden by child class
     */
    protected formatPlaceholder(placeholder: T): any {
        return placeholder;
    }

    /**
     * May be overriden by child class
     *
     * @param columnType PostgreSQL field type. See "pg-types" package
     * @param val The value from the database. This is after "pg" has already
     * handled it using its default parser
     */
    protected parseColumn(_columnType: number, val: any): any {
        return val;
    }

    private preparePlaceholder(placeholder: number | number[] | string | string[] | boolean | boolean[] | null | T): any {
        if (Array.isArray(placeholder)) {
            const result: any[] = [];
            for (const elem of placeholder) {
                result.push(this.preparePlaceholder(elem));
            }
            return result;
        } else if (typeof placeholder === "number" || typeof placeholder === "string" || typeof placeholder === "boolean" || placeholder === null) {
            return placeholder;
        } else {
            return this.formatPlaceholder(placeholder);
        }
    }

    sql(literals: TemplateStringsArray, ...placeholders: (SqlView | number | number[] | string | string[] | boolean | boolean[] | null | T)[]): SqlQueryExpr<T> {
        return new SqlQueryExpr(this, literals, placeholders);
    }

    async insertMany<Row extends object = any>(tableName: string, values: any[], epilogue?: SqlQueryExpr<T>): Promise<ResultRow<Row>[]> {
        if (values.length === 0) {
            return [];
        }

        const fields = Object.keys(values[0]);
        fields.sort();

        if (fields.length === 0) {
            // TODO !!!
            throw new Error("TODO Implement inserting 0 column rows");
        }

        const colTypesQuery = await clientQueryPromise(this.client,
            `
            select
                pg_attribute.attname,
                pg_type.typname
            from
                pg_attribute,
                pg_class,
                pg_type
            where
            pg_attribute.attrelid = pg_class.oid
            and pg_class.relname = $1
            AND pg_attribute.attnum >= 1
            AND pg_attribute.atttypid = pg_type.oid;
            `, [tableName]);

        const columnTypes = new Map<string, string>();
        for (const row of colTypesQuery.rows) {
            const attname: string = row["attname"];
            const typname: string = row["typname"];
            columnTypes.set(attname, typname);
        }

        // Example result:
        //     "name", "height", "birth_date"
        const fieldsSqlFragment: string = fields.map(escapeIdentifier).join(", ");

        // Example result:
        //     $1::text, $2::int4, $3::date
        const paramsSqlFragment: string = fields.map((f, index) => {
            let typ = columnTypes.get(f);
            if (typ === undefined) {
                typ = "unknown";
            }
            return "$" + (index + 1) + "::" + escapeIdentifier(typ) + "[]";
        }).join(", ");


        let text =
            `INSERT INTO ${escapeIdentifier(tableName)} (${fieldsSqlFragment})\n` +
            "SELECT *\n" +
            `FROM unnest(${paramsSqlFragment})\n`;

        let vals: any[] = [];
        for (let i = 0; i < fields.length; ++i) {
            vals.push([]);
        }

        for (const value of values) {
            for (let i = 0; i < fields.length; ++i) {
                vals[i].push((<any>value)[fields[i]]);
            }
        }

        let epilogueText: string;
        let epilogueValues: any[];
        if (epilogue) {
            [epilogueText, epilogueValues] = epilogue.render(vals.length);
        } else {
            [epilogueText, epilogueValues] = ["", []];
        }

        text += epilogueText;
        vals = vals.concat(epilogueValues);

        const queryResult = await clientQueryPromise(this.client, text, vals);

        for (const row of queryResult.rows) {
            for (const field of queryResult.fields) {
                const fieldName = field.name;
                const oldVal = row[fieldName];
                try {
                    row[fieldName] = new RealVal(oldVal !== null ? this.parseColumn(field.dataTypeID, oldVal) : null, fieldName, row);
                } catch (err) {
                    throw new Error(`Error parsing column "${fieldName}" containing value "${oldVal}": ${err.message}`);
                }
            }
        }

        return queryResult.rows;
    }

    async query<Row extends object = any>(query: SqlQueryExpr<T>): Promise<ResultRow<Row>[]> {
        const [text, values] = query.render();
        const queryResult = await clientQueryPromise(this.client, text, values);
        for (const row of queryResult.rows) {
            for (const field of queryResult.fields) {
                const fieldName = field.name;
                const oldVal = row[fieldName];
                try {
                    row[fieldName] = new RealVal(oldVal !== null ? this.parseColumn(field.dataTypeID, oldVal) : null, fieldName, row);
                } catch (err) {
                    throw new Error(`Error parsing column "${fieldName}" containing value "${oldVal}": ${err.message}`);
                }
            }
        }

        return queryResult.rows;
    }

    async queryOne<Row extends object = any>(query: SqlQueryExpr<T>): Promise<ResultRow<Row>> {
        // Cast away the type of "this" so that "mfsqlchecker" doesn't detect
        // this line of code as query that should be analyzed
        const rows: ResultRow<any>[] = await (<any>this).query(query);
        if (rows.length !== 1) {
            throw new Error(`Expected query to return 1 row. Got ${rows.length} rows`);
        }
        return rows[0];
    }

    async queryOneOrNone<Row extends object = any>(query: SqlQueryExpr<T>): Promise<ResultRow<Row> | null> {
        // Cast away the type of "this" so that "mfsqlchecker" doesn't detect
        // this line of code as query that should be analyzed
        const rows: ResultRow<any>[] = await (<any>this).query(query);
        if (rows.length === 0) {
            return null;
        } else if (rows.length === 1) {
            return rows[0];
        } else {
            throw new Error(`Expected query to return 0 or 1 rows. Got ${rows.length} rows`);
        }
    }
}

function escapeIdentifier(str: string) {
    // See:
    // <https://github.com/brianc/node-postgres/blob/60d8df659c5481723abada2344ac14d77377338c/lib/client.js#L401>
    return '"' + str.replace(/"/g, '""') + '"'
}

/**
 * Use this instead of the built-in promise support of pg.Client because
 * `connectionLogSQL` (currently) needs an actual callback
 */
function clientQueryPromise(client: pg.Client, text: string, values: any[]) {
    return new Promise<pg.QueryResult>((resolve, reject) => {
        client.query(text, values, (err: Error, result: pg.QueryResult): void => {
            if (<boolean>(<any>err)) {
                reject(err);
                return;
            }

            resolve(result);
        });
    });
}

class SqlQueryExpr<T> {
    constructor(private conn: Connection<T>, private literals: TemplateStringsArray, private placeholders: (string | number | boolean | SqlView | number[] | string[] | boolean[] | T | null)[]) {
    }

    render(paramNumOffset: number = 0): [string, any[]] {
        let text = "";
        const values: any[] = [];

        text += this.literals[0];

        for (let i = 0; i < this.placeholders.length; ++i) {
            const placeholder = this.placeholders[i];
            if (isSqlView(placeholder)) {
                if (!sqlViewPrivate(placeholder).isResolved()) {
                    throw new Error(`View "${placeholder.getViewName()}" has not been created. Views are only allowed to be defined at module-level scope`);
                }
                text += escapeIdentifier(placeholder.getViewName());
            } else {
                values.push((<any>this.conn).preparePlaceholder(placeholder));
                text += "($" + (values.length + paramNumOffset) + ")";
            }

            text += this.literals[i + 1];
        }

        return [text, values];
    }

    protected dummy: SqlQueryExpr<T>[];
}

export interface SqlParameter {
    type: "SqlParameter";
}

type ResultRow<T> = {
    [P in keyof T]: (
        T[P] extends Req<any> ? (
            T[P]
        ) : (
            T[P] extends Opt<any> ? (
                T[P]
            ) : (
                // TODO If TypeScript ever adds the "invalid" type then use it
                // here instead of "never"
                // <https://github.com/microsoft/TypeScript/issues/23689>
                never
            )
        )
    );
};

export abstract class Req<T> {
    /**
     * Retrieve the value of the column
     */
    abstract val(): T;

    /**
     * Retrieve the value of the column when it may be null. Use this when the
     * column is the result of a LEFT JOIN
     */
    abstract forceNullable(): T | null;

    protected dummy: Req<T>[];
}

export abstract class Opt<T> {
    /**
     * Retreive the value of the column
     */
    abstract valOpt(): T | null;

    /**
     * Retreive the value of the column when you are sure that it cannot be
     * null. This is appropriate to use on columns that are a result of some
     * computation that you know cannot return a null result.
     */
    abstract forceNotNull(): T;

    protected dummy: Opt<T>[];
}

/**
 * A bizarre hybrid implementation of both `Req` and `Opt`
 */
class RealVal {
    // Micro-optimization: short variable names to save memory (we might have
    // thousands of these objects)
    constructor(private readonly v: any,
        private readonly c: string,
        private readonly r: any) { }

    /**
     * Implementation of Req<T>.val
     */
    val(): any {
        if (this.v === null) {
            throw new Error(`Column "${this.c}" is NULL!\nTwo fixes:\n1. Use "forceNullable" (instead of "val")\n2. Modify your SQL query to return an "Opt<T>" column\nFull row:\n${stringifyRealValRow(this.r)}`);
        }
        return this.v;
    }

    /**
     * Implementation of Req<T>.forceNullable
     */
    forceNullable(): any | null {
        return this.v;
    }

    /**
     * Implementation of Opt<T>.valOpt
     */
    valOpt(): any | null {
        return this.v;
    }

    /**
     * Implementation of Opt<T>.forceNotNull
     */
    forceNotNull(): any {
        if (this.v === null) {
            throw new Error(`Column "${this.c}" is NULL!\nUse "valOpt" (instead of "forceNotNull")\nFull row:\n${stringifyRealValRow(this.r)}`);
        }
        return this.v;
    }
}

/**
 * Used for error messages
 */
function stringifyRealValRow(obj: any): string {
    const obj2: any = {};
    for (const key of Object.keys(obj)) {
        obj2[key] = obj[key].v;
    }
    return JSON.stringify(obj2);
}

export abstract class SqlView {
    private constructor() { }

    abstract getViewName(): string;

    protected dummy: SqlView[];
}

function isSqlView(obj: any): obj is SqlView {
    return obj instanceof SqlViewPrivate;
}

function newSqlView(viewName: string, createQuery: string): SqlView {
    const view = new SqlViewPrivate(viewName, createQuery);
    return <any>view;
}

function sqlViewPrivate(view: SqlView): SqlViewPrivate {
    return <any>view;
}

class SqlViewPrivate {
    constructor(viewName: string, createQuery: string) {
        this.viewName = viewName;
        this.createQuery = createQuery;
    }

    getViewName(): string {
        return this.viewName;
    }

    isResolved(): boolean {
        return this.resolved;
    }

    getCreateQuery(): string {
        return this.createQuery;
    }

    setResolved(): void {
        this.resolved = true;
    }

    private readonly viewName: string;
    private createQuery: string;

    /**
     * Will be mutated to "true" in "initAllViews" (So that later during
     * run-time we can validate that "defineSqlView" was called properly (from
     * top-level, and not inside some function)
     */
    private resolved: boolean = false;
}

const allSqlViewCreateStatements: SqlView[] = [];

/**
 * Very hacky
 */
function peekAssignedVariableName(): string | null {
    const stackFrame = stackTrace.parse(new Error())[2];
    const file = fs.readFileSync(stackFrame.getFileName(), { encoding: "utf8" });
    const lines = file.split("\n");
    const line = lines[stackFrame.getLineNumber() - 1];

    const r = /(var|let|const)(\s+)(\w+)[\s=]/.exec(line);
    if (r === null) {
        return null;
    }
    return r[3];
}

export function defineSqlView(x: TemplateStringsArray, ...placeholders: SqlView[]): SqlView {
    const varName = peekAssignedVariableName();

    let query: string = x[0];
    for (let i = 0; i < placeholders.length; ++i) {
        query += "\"" + placeholders[i].getViewName() + "\"";
        query += x[i + 1];
    }

    const viewName = calcViewName(varName, query);

    const sqlView = newSqlView(viewName, `CREATE OR REPLACE VIEW ${escapeIdentifier(viewName)} AS\n${query}`);

    allSqlViewCreateStatements.push(sqlView);

    return sqlView;
}

export class MigrationError extends Error {
    constructor(message: string) {
        super("Error Running Database Migrations\n" + message);
    }
}

/**
 * @throws `MigrationError` If the migration failed for any reason. The
 * database will be left in its original state
 */
export async function migrateDatabase(conn: pg.Client, migrationsDir: string, logger: (message: string) => Promise<void>): Promise<void> {
    await Migrate.migrate(conn, migrationsDir, allSqlViewCreateStatements.map(sqlViewPrivate), logger);
}

namespace Migrate {
    interface AvailableMigration {
        fileContents: string;
        metadata: MigrationMetadata;
    }

    interface MigrationMetadata {
        checksum: number;
        fileName: string;
    }

    export async function loadMigrationFiles(migrationsDir: string): Promise<AvailableMigration[]> {
        let allFiles: string[];
        try {
            allFiles = await readdirAsync(migrationsDir);
        } catch (err) {
            throw new MigrationError(
                "Error Loading Migrations files:\n" +
                `Error listing directory contents of '${migrationsDir}': ${err.message}`);
        }
        const matchingFiles = allFiles.filter(isMigrationFile).sort();

        const availableMigrations: AvailableMigration[] = [];

        for (const matchingFile of matchingFiles) {
            const fileName = path.join(migrationsDir, matchingFile);
            let fileContents: string;
            try {
                fileContents = await readFileAsync(fileName);
            } catch (err) {
                throw new MigrationError(
                    "Error Loading Migration files:\n" +
                    `Error reading file: '${fileName}': ${err.message}`);
            }
            availableMigrations.push({
                fileContents: fileContents,
                metadata: {
                    fileName: matchingFile,
                    checksum: fileLinesCrc32(fileContents)
                }
            });
        }

        return availableMigrations;
    }

    /**
     * Will throw a `MigrationError` if their is an inconsistency of any applied migration
     */
    function findUnappliedMigrations(availableMigrations: AvailableMigration[], appliedMigrations: MigrationMetadata[]): AvailableMigration[] {
        const result: AvailableMigration[] = [];

        const inconsitencyErrors: string[] = [];
        const maxLen = Math.max(availableMigrations.length, appliedMigrations.length);

        for (let i = 0; i < maxLen; ++i) {
            const rank = i + 1;

            if (i >= availableMigrations.length) {
                inconsitencyErrors.push(`The database has the following migration applied to it, which does not appear in the migrations dir: ${rank} ${appliedMigrations[i].fileName}`);
                continue;
            }

            if (i >= appliedMigrations.length) {
                result.push(availableMigrations[i]);
                continue;
            }

            if (appliedMigrations[i].fileName !== availableMigrations[i].metadata.fileName) {
                inconsitencyErrors.push(`Migration filename mismatch at rank ${rank}: ${appliedMigrations[i].fileName} (${appliedMigrations[i].checksum}) != ${availableMigrations[i].metadata.fileName} (${availableMigrations[i].metadata.checksum})`);
            } else if (appliedMigrations[i].checksum !== availableMigrations[i].metadata.checksum) {
                inconsitencyErrors.push(`Checksum mismatch for ${rank} ${appliedMigrations[i].fileName}: ${appliedMigrations[i].checksum} != ${availableMigrations[i].metadata.checksum}`);
            }
        }

        if (inconsitencyErrors.length > 0) {
            throw new MigrationError(
                "The database has migrations applied to it that are inconsistent with the available migrations:\n" +
                inconsitencyErrors.map(e => ` * ${e}`).join("\n"));
        }

        return result;
    }

    async function runAndDropDependentViews<A>(conn: pg.Client, action: () => Promise<A>): Promise<A> {
        const savepoint = await newSavepoint(conn);
        let result: A;
        try {
            result = await action();
        } catch (err) {
            const pgErr = parsePostgreSqlError(err);
            if (pgErr === null) {
                throw err;
            } else {
                // This can happen when we try to "DROP TABLE foo" or "ALTER
                // TABLE foo DROP COLUMN bar" and a view depends on the table
                // or column
                const POSTGRESQL_ERROR_DEPENDENT_OBJECTS_STILL_EXIST = "2BP01";

                // This can happen when we try to alter the type of a table
                // column that is used by a view
                const POSTGRESQL_ERROR_FEATURE_NOT_SUPPORTED = "0A000";

                if (pgErr.code === POSTGRESQL_ERROR_DEPENDENT_OBJECTS_STILL_EXIST ||
                    pgErr.code === POSTGRESQL_ERROR_FEATURE_NOT_SUPPORTED) {
                    if (pgErr.detail !== null) {
                        const viewName = extractViewName(pgErr.detail);

                        if (viewName !== null) {
                            await rollbackToAndReleaseSavepoint(conn, savepoint);

                            await runAndDropDependentViews(conn, async () => {
                                await conn.query(`DROP VIEW IF EXISTS ${escapeIdentifier(viewName)}`);
                            });

                            return runAndDropDependentViews(conn, action);
                        }
                    }
                }

                throw err;
            }
        }
        await releaseSavepoint(conn, savepoint);
        return result;
    }

    async function tryRunPg<A>(description: string, action: () => Promise<A>): Promise<A> {
        let result: A;
        try {
            result = await action();
        } catch (err) {
            const pgErr = parsePostgreSqlError(err);
            if (pgErr === null) {
                throw err;
            } else {
                throw new MigrationError(
                    `Database error when trying to ${description}:\n` +
                    ` * code: ${pgErr.code}\n` +
                    ` * position: ${pgErr.position}\n` +
                    ` * message: ${pgErr.message}\n` +
                    ` * detail: ${pgErr.detail}\n` +
                    ` * hint: ${pgErr.hint}`);
            }
        }
        return result;
    }

    export async function migrate(conn: pg.Client, migrationsDir: string, views: SqlViewPrivate[], logger: (message: string) => Promise<void>): Promise<void> {
        const availableMigrations = await loadMigrationFiles(migrationsDir);
        await logger(`Found ${availableMigrations.length} migration files in current project`);

        await tryRunPg("create schema_version table", () => createSchemaVersionTable(conn));

        await withTransaction(conn, async () => {
            await tryRunPg("lock \"schema_version\" table", () => conn.query("LOCK TABLE schema_version IN ACCESS EXCLUSIVE MODE"));

            const appliedMigrations = await tryRunPg("query database for applied migrations", () => queryAppliedMigrations(conn));
            await logger(`Database has ${appliedMigrations.length} migrations already applied`);

            const unappliedMigrations = findUnappliedMigrations(availableMigrations, appliedMigrations);

            if (unappliedMigrations.length === 0) {
                await logger(`No new migrations need to be applied`);
            } else {
                await logger(`The following new migrations will be applied:`);
                for (const unappliedMigration of unappliedMigrations) {
                    await logger(`${unappliedMigration.metadata.fileName} (${unappliedMigration.metadata.checksum})`);
                }
            }

            // Apply the migrations:

            for (const unappliedMigration of unappliedMigrations) {
                await logger(`Running migration file ${unappliedMigration.metadata.fileName}`);

                const beforeMigrationTime = new Date().getTime();
                await tryRunPg(`apply migration file ${unappliedMigration.metadata.fileName}`, async () => {
                    await runAndDropDependentViews(conn, async () => {
                        await conn.query(unappliedMigration.fileContents);
                    });
                });
                const afterMigrationTime = new Date().getTime();

                const executionTime = Math.max(afterMigrationTime - beforeMigrationTime, 0);
                await tryRunPg(`insert row to schema_version table`, async () => {
                    await insertSchemaVersionRow(conn, unappliedMigration.metadata, executionTime);
                });
            }

            // Create all of the views:

            let combinedCreateVewsQuery: string = "";
            for (const v of views) {
                combinedCreateVewsQuery += v.getCreateQuery() + ";\n";
            }
            await logger(`Creating ${views.length} views...`);
            await tryRunPg("run combined CREATE VIEW statements", () => conn.query(combinedCreateVewsQuery));
        });

        for (const v of views) {
            v.setResolved();
        }

        await logger("Migration complete");
    }

    async function createSchemaVersionTable(conn: pg.Client): Promise<void> {
        // Table schema is the same that is used in flyway:
        // <https://github.com/flyway/flyway/blob/master/flyway-core/src/main/java/org/flywaydb/core/internal/database/postgresql/PostgreSQLDatabase.java>

        await conn.query(
            `
            CREATE TABLE IF NOT EXISTS "schema_version"
            (
                "installed_rank" INT CONSTRAINT "schema_version_pk" PRIMARY KEY,
                "version" VARCHAR(50),
                "description" VARCHAR(200) NOT NULL,
                "type" VARCHAR(20) NOT NULL,
                "script" VARCHAR(1000) NOT NULL,
                "checksum" INTEGER,
                "installed_by" VARCHAR(100) NOT NULL,
                "installed_on" TIMESTAMP NOT NULL DEFAULT now(),
                "execution_time" INTEGER NOT NULL,
                "success" BOOLEAN NOT NULL
            );

            CREATE INDEX IF NOT EXISTS "schema_version_s_idx" ON "schema_version" USING btree ("success");
            `);
    }

    async function queryAppliedMigrations(conn: pg.Client): Promise<MigrationMetadata[]> {
        const queryResult = await conn.query(
            `
            SELECT
                "installed_rank",
                "script",
                "checksum"
            FROM "schema_version"
            ORDER BY "installed_rank"
            `);

        const result: MigrationMetadata[] = [];
        for (const row of queryResult.rows) {
            const installedRank: number = row["installed_rank"];
            const checksum: number | null = row["checksum"];
            const script: string = row["script"];

            if (checksum === null) {
                throw new MigrationError(
                    `Previously applied migration ${installedRank} ${script} has NULL checksum value`);
            }

            result.push({
                checksum: checksum,
                fileName: script
            });
        }
        return result;
    }

    interface MigrationCols {
        version: string;
        description: string;
    }

    function parseMigrationCols(fileName: string): MigrationCols {
        const matches = /^V(\d+)__(.*)\.sql$/.exec(fileName);

        if (matches === null) {
            return {
                version: "",
                description: ""
            };
        }

        const version = matches[1];
        const description = matches[2].replace("_", " ");

        return {
            version: version,
            description: description
        };
    }

    async function insertSchemaVersionRow(conn: pg.Client, metadata: MigrationMetadata, executionTime: number): Promise<void> {
        const migrationCols = parseMigrationCols(metadata.fileName);

        await conn.query(
            `
            INSERT INTO "schema_version"
            (
                "installed_rank",
                "version",
                "description",
                "type",
                "script",
                "checksum",
                "installed_by",
                "installed_on",
                "execution_time",
                "success"
            )
            VALUES
            (
                COALESCE((SELECT MAX(installed_rank) FROM schema_version), 0) + 1,
                $1,
                $2,
                'SQL',
                $3,
                $4,
                (SELECT user),
                now() AT TIME ZONE 'utc',
                $5,
                TRUE
            )
            `, [
                migrationCols.version,
                migrationCols.description,
                metadata.fileName,
                metadata.checksum,
                executionTime
            ]);
    }
}

/**
 * Checks if `err` is a PostgreSQL error, and returns the error code.
 *
 * See: <https://www.postgresql.org/docs/9.6/static/errcodes-appendix.html>
 *
 * If `err` is not a PostgreSQL error, then returns `null`
 */
function getPostgreSqlErrorCode(err: any): string | null {
    if (typeof err !== "object") {
        return null;
    }

    // The best technique I could think of to check if this is a pg error
    // (rather than some other type of error), is to see if it is an object with
    // all of the following fields that are always set

    // List of fields is from the "parseE" function from "connection.js" file
    // from "node-pg" npm package:
    const pgErrFields = [
        "severity",
        "code",
        "detail",
        "hint",
        "position",
        "internalPosition",
        "internalQuery",
        "where",
        "schema",
        "table",
        "column",
        "dataType",
        "constraint",
        "file",
        "line",
        "routine"
    ];

    for (const field of pgErrFields) {
        if (!(field in err)) {
            return null;
        }
    }

    const code = err.code;
    if (typeof code !== "string") {
        return null;
    }

    return err.code;
}

interface PostgreSqlError {
    code: string;
    position: number | null;
    message: string;
    detail: string | null;
    hint: string | null;
}

/**
 *
 * If `err` is not a PostgreSQL error, then returns `null`
 */
function parsePostgreSqlError(err: any): PostgreSqlError | null {
    const code = getPostgreSqlErrorCode(err);
    if (code === null) {
        return null;
    }

    return {
        code: code,
        position: err.position !== undefined ? parseInt(err.position, 10) : null,
        message: err.message,
        detail: err.detail !== undefined ? err.detail : null,
        hint: err.hint !== undefined ? err.hint : null
    };
}

async function withTransaction<A>(conn: pg.Client, action: () => Promise<A>): Promise<A> {
    await conn.query("BEGIN");

    let result: A;
    try {
        result = await action();
    } catch (e) {
        try {
            await conn.query("ROLLBACK");
        } catch (e2) {
            console.error("ERROR PERFORMING ROLLBACK", e2);
            // A connection error could potentially cause also the rollback to
            // fail. Always prefer to re-throw the original error.
        }
        throw e;
    }
    await conn.query("COMMIT");
    return result;
}

/**
 * Generates a cryptographically random token
 */
function randomSavepointName(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        crypto.randomBytes(24, (err, buf) => {
            if (<boolean>(<any>err)) {
                reject(err);
                return;
            }

            const token = buf.toString("hex");
            resolve("savepoint_" + token);
        });
    });
}

class Savepoint {
    public constructor(public readonly name: string) { }
}

async function newSavepoint(conn: pg.Client): Promise<Savepoint> {
    const savepointName = await randomSavepointName();

    await conn.query(`SAVEPOINT ${savepointName}`);

    return new Savepoint(savepointName);
}

async function releaseSavepoint(conn: pg.Client, savepoint: Savepoint): Promise<void> {
    await conn.query(`RELEASE SAVEPOINT ${savepoint.name}`);
}

async function rollbackToAndReleaseSavepoint(conn: pg.Client, savepoint: Savepoint): Promise<void> {
    await conn.query(`ROLLBACK TO SAVEPOINT ${savepoint.name}; RELEASE SAVEPOINT ${savepoint.name}`);
}
