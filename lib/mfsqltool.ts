import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as pg from "pg";
import * as stackTrace from "stack-trace";
import { fileLinesCrc32 } from "./crc32";
import { isMigrationFile, readdirAsync, readFileAsync } from "./utils";
import { calcViewName, extractViewName } from "./view_names";

export type ColumnParser<T> = (value: any) => T;

export class Connection<T, V> {
    /**
     * Used only to statically identify this type
     */
    protected readonly MfConnectionTypeTag: undefined;

    constructor(client: pg.Client) {
        this.client = client;

        // tslint:disable-next-line:no-unbound-method no-unused-expression
        this.preparePlaceholder;
    }

    readonly client: pg.Client;

    /**
     * May be overriden by child class
     *
     * @param debugContext Human-readable text that should part of any
     * exception message, should describe the name/location of this
     * placeholder
     */
    protected formatPlaceholder(debugContext: string, placeholder: T): any {
        // tslint:disable-next-line:no-unused-expression
        debugContext;

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

    /**
     * @param debugContext Human-readable text that should part of any
     * exception message, should describe the name/location of this
     * placeholder
     */
    private preparePlaceholder(debugContext: string, placeholder: number | number[] | string | string[] | boolean | boolean[] | null | T): any {
        if (Array.isArray(placeholder)) {
            const result: any[] = [];
            for (let i = 0; i < placeholder.length; ++i) {
                const elem = placeholder[i];
                result.push(this.preparePlaceholder(debugContext + `, array index ${i}`, elem));
            }
            return result;
        } else if (typeof placeholder === "number" || typeof placeholder === "string" || typeof placeholder === "boolean" || placeholder === null) {
            return placeholder;
        } else {
            return this.formatPlaceholder(debugContext, placeholder);
        }
    }

    sql(literals: TemplateStringsArray, ...placeholders: (SqlView<V> | SqlFrag<string> | number | number[] | string | string[] | boolean | boolean[] | null | T)[]): SqlQueryExpr<T, V> {
        return new SqlQueryExpr(this, literals, placeholders);
    }

    /**
     * If your query contains an 'ON CONFLICT DO NOTHING' clause, or an 'ON
     * CONFLICT DO UPDATE ... WHERE' clause then you should use `insertMaybe`
     * instead
     */
    async insert<Row extends object = any>(tableName: string, value: object, epilogue?: SqlQueryExpr<T, V>): Promise<ResultRow<Row>> {
        // Cast away the type of "this" so that "mfsqlchecker" doesn't detect
        // this line of code as query that should be analyzed
        const maybeRow: ResultRow<any> | null = (<any>this).insertMaybe(tableName, value, epilogue);
        if (maybeRow === null) {
            throw new Error(`Expected insert query to return 1 row. Got 0 rows`);
        }
        return maybeRow;
    }

    /**
     * Use this only if your query contains an 'ON CONFLICT DO NOTHING' clause
     * or an 'ON CONFLICT DO UPDATE ... WHERE' clause
     */
    async insertMaybe<Row extends object = any>(tableName: string, value: object, epilogue?: SqlQueryExpr<T, V>): Promise<ResultRow<Row | null>> {
        if (Array.isArray(value)) {
            throw new Error("Invalid insert call with value that is an Array (must be a single object)");
        }

        const fields = Object.keys(value);
        fields.sort();

        if (fields.length === 0) {
            // TODO !!!
            throw new Error("TODO Implement inserting 0 column rows");
        }

        // Example result:
        //     "name", "height", "birth_date"
        const fieldsSqlFragment: string = fields.map(escapeIdentifier).join(", ");

        // Example result:
        //     $1, $2, $3
        const paramsSqlFragment: string = fields.map((_f, index) => "$" + (index + 1)).join(", ");

        let text =
            `INSERT INTO ${escapeIdentifier(tableName)} (${fieldsSqlFragment})\n` +
            `VALUES (${paramsSqlFragment})\n`;

        let vals: any[] = [];
        // tslint:disable-next-line:prefer-for-of
        for (let i = 0; i < fields.length; ++i) {
            vals.push(this.preparePlaceholder(`field: "${fields[i]}"`, (<any>value)[fields[i]]));
        }

        let epilogueText: string;
        let epilogueValues: any[];
        if (epilogue !== undefined) {
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

        if (queryResult.rows.length === 0) {
            return null;
        } else if (queryResult.rows.length === 1) {
            return queryResult.rows[0];
        } else {
            throw new Error(`Expected insert query to return 0 or 1 rows. Got ${queryResult.rows.length} rows`);
        }
    }

    async insertMany<Row extends object = any>(tableName: string, values: object[], epilogue?: SqlQueryExpr<T, V>): Promise<ResultRow<Row>[]> {
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
            and pg_attribute.attnum >= 1
            and pg_attribute.atttypid = pg_type.oid;
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
        // tslint:disable-next-line:prefer-for-of
        for (let i = 0; i < fields.length; ++i) {
            vals.push([]);
        }

        for (let i = 0; i < values.length; ++i) {
            const value = values[i];
            for (let j = 0; j < fields.length; ++j) {
                vals[j].push(this.preparePlaceholder(`values array element index ${i}, field: "${fields[j]}"`, (<any>value)[fields[j]]));
            }
        }

        let epilogueText: string;
        let epilogueValues: any[];
        if (epilogue !== undefined) {
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

    protected async executeQuery(text: string, values: any[]) {
        return await clientQueryPromise(this.client, text, values);
    }

    async query<Row extends object = any>(query: SqlQueryExpr<T, V>): Promise<ResultRow<Row>[]> {
        const [text, values] = query.render();
        const queryResult = await this.executeQuery(text, values);
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

    async queryOne<Row extends object = any>(query: SqlQueryExpr<T, V>): Promise<ResultRow<Row>> {
        // Cast away the type of "this" so that "mfsqlchecker" doesn't detect
        // this line of code as query that should be analyzed
        const rows: ResultRow<any>[] = await (<any>this).query(query);
        if (rows.length !== 1) {
            throw new Error(`Expected query to return 1 row. Got ${rows.length} rows`);
        }
        return rows[0];
    }

    /**
     *
     * @param query SQL query string
     * @returns The first ROW of queried dataset or NULL if query didnt return rows
     */
    async queryOneOrNone<Row extends object = any>(query: SqlQueryExpr<T, V>): Promise<ResultRow<Row> | null> {
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

    async unsafeQuery(text: string, values?: any[]): Promise<pg.QueryResult> {
        const vals: any[] = values !== undefined ? values : [];
        const queryResult = await clientQueryPromise(this.client, text, vals);
        return queryResult;
    }
}

export function escapeIdentifier(str: string) {
    // See:
    // <https://github.com/brianc/node-postgres/blob/60d8df659c5481723abada2344ac14d77377338c/lib/client.js#L401>
    return '"' + str.replace(/"/g, '""') + '"';
}

/**
 * Use this instead of the built-in promise support of pg.Client because
 * `connectionLogSQL` (currently) needs an actual callback
 */
async function clientQueryPromise(client: pg.Client, text: string, values: any[]): Promise<pg.QueryResult> {
    return await new Promise<pg.QueryResult>((resolve, reject) => {
        client.query(text, values, (err: Error, result: pg.QueryResult): void => {
            if (<boolean>(<any>err)) {
                reject(err);
                return;
            }

            resolve(result);
        });
    });
}

export class SqlQueryExpr<T, V> {
    constructor(private conn: Connection<T, V>, private literals: TemplateStringsArray, private placeholders: (SqlView<V> | SqlFrag<string> | number | number[] | string | string[] | boolean | boolean[] | null | T)[]) {
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
            } else if (isSqlFrag(placeholder)) {
                text += placeholder.runtimeText;
            } else {
                values.push((<any>this.conn).preparePlaceholder(`query placeholder index ${i}`, placeholder));
                text += "($" + (values.length + paramNumOffset) + ")";
            }

            text += this.literals[i + 1];
        }

        return [text, values];
    }

    protected dummy: [SqlQueryExpr<T, V>[], T, V];
}

export interface SqlParameter {
    type: "SqlParameter";
}

export type ResultRow<T> = {
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

export type Req<T> = {
    /**
     * Retrieve the value of the column
     */
    val(): T;

    /**
     * Retrieve the value of the column when it may be null. Use this when the
     * column is the result of a LEFT JOIN
     */
    forceNullable(): T | null;
} &
    (T extends (infer K | null)[]
        ? {
            /**
             * Retrieve the value of the column, assuming that none of the elements
             * in the array are null. It is an error if any of the elements are null.
             */
            forceArrayNoNulls(): K[];

            /**
             * Retrieve the (possible NULL) value of the column, assuming that
             * none of the elements in the array are null. It is an error if any
             * of the elements are null.
             */
            forceNullableArrayNoNulls(): K[] | null;
        }
        : {});

export type Opt<T> = {
    /**
     * Retreive the value of the column
     */
    valOpt(): T | null;

    /**
     * Retreive the value of the column when you are sure that it cannot be
     * null. This is appropriate to use on columns that are a result of some
     * computation that you know cannot return a null result.
     */
    forceNotNull(): T;
} &
    (T extends (infer K | null)[]
        ? {
            /**
             * Retrieve the (possible NULL) value of the column, assuming that
             * none of the elements in the array are null. It is an error if any
             * of the elements are null.
             */
            optForceArrayNoNulls(): K[] | null;

            /**
             * Retrieve the value of the column when you are sure that it cannot
             * be null, and assuming that none of the elements in the array are
             * null. It is an error if any of the elements are null.
             */
            forceNotNullArrayNoNulls(): K[];
        }
        : {});

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
     * Implementation of Req<T>.forceArrayNoNulls
     */
    forceArrayNoNulls(): any[] {
        if (this.v === null) {
            throw new Error(`Column "${this.c}" is NULL!\nTwo fixes:\n1. Use "forceNullableArrayNoNulls" (instead of "forceArrayNoNulls")\n2. Modify your SQL query to return an "Opt<T>" column\nFull row:\n${stringifyRealValRow(this.r)}`);
        }
        if (!Array.isArray(this.v)) {
            throw new Error(`Column "${this.c}" is not an array!\nThis is a bug in mfsqlchecker\nFull row:\n${stringifyRealValRow(this.r)}`);
        }
        const l = this.v.length;
        for (let i = 0; i < l; ++i) {
            if (this.v[i] === null) {
                throw new Error(`Column "${this.c} contains a NULL value (at index ${i})!\nUse "val" (instead of "forceArrayNoNulls")\nFull row:\n${stringifyRealValRow(this.r)}`);
            }
        }
        return this.v;
    }

    /**
     * Implementation of Req<T>.forceNullableArrayNoNulls
     */
    forceNullableArrayNoNulls(): any[] | null {
        if (this.v === null) {
            return null;
        }
        if (!Array.isArray(this.v)) {
            throw new Error(`Column "${this.c}" is not an array!\nThis is a bug in mfsqlchecker\nFull row:\n${stringifyRealValRow(this.r)}`);
        }
        const l = this.v.length;
        for (let i = 0; i < l; ++i) {
            if (this.v[i] === null) {
                throw new Error(`Column "${this.c}" contains a NULL value (at index ${i})!\nUse "forceNullable" (instead of "forceNullableArrayNoNulls")\nFull row:\n${stringifyRealValRow(this.r)}`);
            }
        }
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

    /**
     * Implementation of Opt<T>.optForceArrayNoNulls
     */
    optForceArrayNoNulls(): any[] | null {
        if (this.v === null) {
            return null;
        }
        if (!Array.isArray(this.v)) {
            throw new Error(`Column "${this.c}" is not an array!\nThis is a bug in mfsqlchecker\nFull row:\n${stringifyRealValRow(this.r)}`);
        }
        const l = this.v.length;
        for (let i = 0; i < l; ++i) {
            if (this.v[i] === null) {
                throw new Error(`Column "${this.c}" contains a NULL value (at index ${i})!\nUse "valOpt" (instead of "optForceArrayNoNulls")\nFull row:\n${stringifyRealValRow(this.r)}`);
            }
        }
        return this.v;
    }

    /**
     * Implementation of Opt<T>.forceNotNullArrayNoNulls
     */
    forceNotNullArrayNoNulls(): any[] {
        if (this.v === null) {
            throw new Error(`Column "${this.c}" is NULL!\nUse "optForceArrayNoNulls" (instead of "forceNotNullArrayNoNulls")\nFull row:\n${stringifyRealValRow(this.r)}`);
        }
        if (!Array.isArray(this.v)) {
            throw new Error(`Column "${this.c}" is not an array!\nThis is a bug in mfsqlchecker\nFull row:\n${stringifyRealValRow(this.r)}`);
        }
        const l = this.v.length;
        for (let i = 0; i < l; ++i) {
            if (this.v[i] === null) {
                throw new Error(`Column "${this.c}" contains a NULL value (at index ${i})!\nUse "forceNotNull" (instead of "forceNotNullArrayNoNulls")\nFull row:\n${stringifyRealValRow(this.r)}`);
            }
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

export class SqlFrag<T extends string> {
    protected constructor(text: string, runtimeText: string | undefined) {
        this.text = text;
        this.runtimeText = runtimeText !== undefined ? runtimeText : text;
    }

    readonly text: string;
    readonly runtimeText: string;

    protected dummy: [SqlFrag<T>[], T];
    protected tag: T;

    protected static Create<S extends string>(text: string, runtimeText: string | undefined): SqlFrag<S> {
        SqlFrag.Create; // tslint:disable-line:no-unused-expression
        return new SqlFrag<S>(text, runtimeText);
    }
}

export function sqlFrag<T extends string>(text: T, runtimeText?: string): SqlFrag<T> {
    return (<any>SqlFrag).Create(text, runtimeText);
}

export class SqlFragAuth<T extends string, Auth> {
    protected dummy: [SqlFragAuth<T, Auth>[], T, Auth];
}

export function sqlFragAuth<Auth>(): <T extends string>(text: T, runtimeText?: string) => SqlFragAuth<T, Auth> {
    return <T extends string>(text: T, runtimeText?: string): SqlFragAuth<T, Auth> => {
        return <any>sqlFrag(text, runtimeText);
    };
}

function isSqlFrag(obj: any): obj is SqlFrag<string> {
    return obj instanceof SqlFrag;
}

export abstract class SqlView<Auth> {
    private constructor() { }

    abstract getViewName(): string;

    protected dummy: [SqlView<Auth>[], Auth];
}

function isSqlView(obj: any): obj is SqlView<unknown> {
    return obj instanceof SqlViewPrivate;
}

function newSqlView<V>(viewName: string, createQuery: string): SqlView<V> {
    const view = new SqlViewPrivate(viewName, createQuery);
    return <any>view;
}

function sqlViewPrivate(view: SqlView<unknown>): SqlViewPrivate {
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

const allSqlViewCreateStatements: SqlView<unknown>[] = [];

/**
 * Very hacky
 */
function peekAssignedVariableName(): string | null {
    // TODO Instead of hardcoding index 3, we need to search the stacktrace for
    // "defineSqlViewPrimitive" and then take one above that
    const stackFrame = stackTrace.parse(new Error())[3];
    const file = fs.readFileSync(stackFrame.getFileName(), { encoding: "utf8" });
    const lines = file.split("\n");
    const line = lines[stackFrame.getLineNumber() - 1];

    const r = /(var|let|const)(\s+)(\w+)[\s=]/.exec(line);
    if (r !== null) {
        return r[3];
    }

    const r2 = /exports\.(\w+)[\s=]/.exec(line);
    if (r2 !== null) {
        return r2[1];
    }

    return null;
}

export function defineSqlViewPrimitive<V>(x: TemplateStringsArray, ...placeholders: (SqlView<unknown> | SqlFrag<string> | SqlFragAuth<string, unknown>)[]): SqlView<V> {
    const varName = peekAssignedVariableName();

    let query: string = x[0];
    for (let i = 0; i < placeholders.length; ++i) {
        const placeholder = placeholders[i];
        if (isSqlView(placeholder)) {
            query += escapeIdentifier(placeholder.getViewName());
        } else if (isSqlFrag(placeholder)) {
            query += placeholder.runtimeText;
        }
        query += x[i + 1];
    }

    const viewName = calcViewName(varName, query);

    const sqlView = newSqlView<V>(viewName, `CREATE VIEW ${escapeIdentifier(viewName)} AS\n${query}`);

    allSqlViewCreateStatements.push(sqlView);

    return sqlView;
}

export class MigrationError extends Error {
    constructor(message: string) {
        super("Error Running Database Migrations\n" + message);
    }
}

export interface MigrationHooks {
    preMigrateHook?: (conn: pg.Client, logger: (message: string) => Promise<void>) => Promise<void>;
    postMigrateHook?: (conn: pg.Client, logger: (message: string) => Promise<void>) => Promise<void>;
}

/**
 * Determines which migration files have not yet been run on the database, and
 * executes them. Will also create all of the mfsqlchecker views. Everything
 * will be run inside a transaction.
 *
 * @throws `MigrationError` If the migration failed for any reason. The database
 * will be left in its original state
 */
export async function migrateDatabase(conn: pg.Client, migrationsDir: string, logger: (message: string) => Promise<void>, hooks?: MigrationHooks): Promise<void> {
    await Migrate.migrate(conn, migrationsDir, allSqlViewCreateStatements.map(sqlViewPrivate), logger, hooks !== undefined ? hooks : {});
}

/**
 * When the code of a view is changed, its hash will change, so a new view will
 * be created in the database.
 *
 * The old view (with the previous hash) will still remain. Over time, many of
 * these old unused used build up inside the database.
 *
 * Run this function periodically to delete these old views.
 *
 * Note: This is purposefully not run automatically during the migration step.
 * The reason is that we might have multiple servers in operation. When a new
 * app version is deployed, they are not all updated exactly together. Some of
 * the servers might continue running the old code for several minutes until it
 * is there turn to be updated. If we were to drop the views too early, these
 * tardy servers would break (the views they are looking for would not be found)
 */
export async function dropUnusedViews(conn: pg.Client, logger: (message: string) => Promise<void>): Promise<void> {
    await Migrate.dropUnusedViews(conn, allSqlViewCreateStatements.map(sqlViewPrivate), logger);
}

/**
 * This drops ALL of the auto generated views. I can't think of a reason why you
 * would need this. The `dropUnusedViews` function should always be sufficient.
 * But the function is here in case for some reason you do need to do this.
 *
 * Note: This should never be run on production!
 */
export async function dropAllViews(conn: pg.Client, logger: (message: string) => Promise<void>): Promise<void> {
    await Migrate.dropAllViews(conn, logger);
}

/**
 * Create all of the mfsqlchecker views. Normally you should just use
 * `migrateDatabase`, which will also take care of this step.
 *
 * One valid use for this function is when you have cloned a database that you
 * are sure already has all of the migrations applied to it, but might be
 * missing the views.
 *
 * After you call this function you must call `setAllViewsResolved`.
 */
export async function createAllViews(conn: pg.Client) {
    await Migrate.createViews(conn, allSqlViewCreateStatements.map(sqlViewPrivate));
}

/**
 * You must call this if you use `createAllViews`. The reason this is a separate
 * function is in case you call `createAllViews` inside a transaction, then you
 * should call this only after the transaction succesfully commits.
 */
export function setAllViewsResolved(): void {
    Migrate.setViewsResolved(allSqlViewCreateStatements.map(sqlViewPrivate));
}

/**
 * It is recommended to use `migrateDatabase` instead of this. Only use this
 * function if you have some other process that always runs `migrateDatabase`
 */
export function markAllViewsResolved() {
    for (const view of allSqlViewCreateStatements) {
        sqlViewPrivate(view).setResolved();
    }
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

    async function runAndDropDependentViewsImpl<A>(conn: pg.Client, action: () => Promise<A>, droppingViewName: string | null): Promise<A> {
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

                        if (viewName !== null && viewName !== droppingViewName) {
                            await rollbackToAndReleaseSavepoint(conn, savepoint);

                            await runAndDropDependentViewsImpl(conn, async () => {
                                await conn.query(`DROP VIEW IF EXISTS ${escapeIdentifier(viewName)}`);
                            }, viewName);

                            return runAndDropDependentViewsImpl(conn, action, null);
                        }
                    }
                }

                throw err;
            }
        }
        await releaseSavepoint(conn, savepoint);
        return result;
    }

    async function runAndDropDependentViews<A>(conn: pg.Client, action: () => Promise<A>): Promise<A> {
        return await runAndDropDependentViewsImpl(conn, action, null);
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
                    ` * table: ${pgErr.table}\n` +
                    ` * hint: ${pgErr.hint}`);
            }
        }
        return result;
    }

    export async function migrate(conn: pg.Client, migrationsDir: string, views: SqlViewPrivate[], logger: (message: string) => Promise<void>, hooks: MigrationHooks): Promise<void> {
        const availableMigrations = await loadMigrationFiles(migrationsDir);
        await logger(`Found ${availableMigrations.length} migration files in current project`);

        await tryRunPg("create schema_version table", () => createSchemaVersionTable(conn));

        await withTransaction(conn, async () => {
            await logger("Acquiring schema_version table lock...");
            await tryRunPg("lock \"schema_version\" table", () => conn.query("LOCK TABLE schema_version IN SHARE UPDATE EXCLUSIVE MODE"));

            // The "schema_version_s_idx" index is created here, inside the
            // transaction, after we have acquired the table lock. This is
            // because otherwise another process holding the table lock would
            // block this query (yes, even if the index does already exists).
            await tryRunPg("create schema_version_s_idx index", () => conn.query("CREATE INDEX IF NOT EXISTS \"schema_version_s_idx\" ON \"schema_version\" USING btree (\"success\")"));

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

            if (hooks.preMigrateHook !== undefined) {
                const preMigrateHook = hooks.preMigrateHook;
                await logger(`Running preMigrateHook...`);
                await tryRunPg("run preMigrateHook", () => preMigrateHook(conn, logger));
                await logger(`preMigrateHook done`);
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

            // Create new views:

            await createNewViews(conn, views, logger);
            setViewsResolved(views);

            if (hooks.postMigrateHook !== undefined) {
                const postMigrateHook = hooks.postMigrateHook;
                await logger(`Running postMigrateHook...`);
                await tryRunPg("run postMigrateHook", () => postMigrateHook(conn, logger));
                await logger(`postMigrateHook done`);
            }
        });

        await logger("Migration complete");
    }

    export async function createNewViews(conn: pg.Client, views: SqlViewPrivate[], logger: (message: string) => Promise<void>): Promise<void> {
        const existingViews = await tryRunPg("list all existing views", () => selectAllSqlViews(conn));

        const existingViewsSet = new Set<string>(existingViews);

        const newViews: SqlViewPrivate[] = [];
        for (const view of views) {
            if (!existingViewsSet.has(view.getViewName())) {
                newViews.push(view);
            }
        }

        await logger(`Database has ${existingViews.length} views. Code has ${views.length} views. Creating ${newViews.length} new views...`);
        await tryRunPg("run combined CREATE VIEW statements", () => createViews(conn, newViews));
    }

    export async function createViews(conn: pg.Client, views: SqlViewPrivate[]): Promise<void> {
        if (views.length === 0) {
            return;
        }

        let combinedCreateVewsQuery: string = "";
        for (const v of views) {
            combinedCreateVewsQuery += v.getCreateQuery() + ";\n";
        }

        await conn.query(combinedCreateVewsQuery);
    }

    export function setViewsResolved(views: SqlViewPrivate[]): void {
        for (const v of views) {
            v.setResolved();
        }
    }

    async function createSchemaVersionTable(conn: pg.Client): Promise<void> {
        // Table schema is the same that is used in flyway:
        // <https://github.com/flyway/flyway/blob/master/flyway-core/src/main/java/org/flywaydb/core/internal/database/postgresql/PostgreSQLDatabase.java>

        // NOTE: To be consistent with flyway, there is also an index on the
        // table called "schema_version_s_idx". We create this index separately
        // (inside a transaction, because of tricky locking behaviour)

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
            )
            `);
    }

    async function queryAppliedMigrations(conn: pg.Client): Promise<MigrationMetadata[]> {
        const queryResult = await conn.query(
            `
            SELECT
                "installed_rank",
                "version",
                "description",
                "script",
                "checksum"
            FROM "schema_version"
            ORDER BY "installed_rank"
            `);

        let expectedInstallRank = 1;

        const result: MigrationMetadata[] = [];
        for (const row of queryResult.rows) {
            const installedRank: number = row["installed_rank"];
            const version: string = row["version"];
            const description: string = row["description"];
            const script: string = row["script"];
            const checksum: number | null = row["checksum"];

            if (installedRank !== expectedInstallRank) {
                throw new MigrationError(
                    `Previously applied migrations have a gap in the rank.\n` +
                    `Rank ${expectedInstallRank} is missing. Found: ${installedRank} ${script}`);
            }
            expectedInstallRank++;

            if (checksum === null) {
                throw new MigrationError(
                    `Previously applied migration ${installedRank} ${script} has NULL checksum value`);
            }

            const migrationCols = parseMigrationCols(script);

            if (version !== migrationCols.version) {
                throw new MigrationError(
                    `Previously applied migration ${installedRank} ${script} has wrong migration version\n` +
                    `Found: ${version}\n` +
                    `Should be: ${migrationCols.version}`);
            }

            if (description !== migrationCols.description) {
                throw new MigrationError(
                    `Previously applied migration ${installedRank} ${script} has wrong migration description\n` +
                    `Found: ${description}\n` +
                    `Should be: ${migrationCols.description}`);
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
        const description = matches[2].replace(/_/g, " ");

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

    export async function dropUnusedViews(conn: pg.Client, views: SqlViewPrivate[], logger: (message: string) => Promise<void>): Promise<void> {
        await withTransaction(conn, async () => {
            await logger("Acquiring schema_version table lock...");
            await tryRunPg("lock \"schema_version\" table", () => conn.query("LOCK TABLE schema_version IN SHARE UPDATE EXCLUSIVE MODE"));

            const existingViews = await tryRunPg("list all existing views", () => selectAllSqlViews(conn));

            const newViewNamesSet = new Set<string>(views.map(v => v.getViewName()));

            const expiredViews: string[] = [];
            for (const viewName of existingViews) {
                if (!newViewNamesSet.has(viewName)) {
                    expiredViews.push(viewName);
                }
            }

            await logger(`Need to drop ${expiredViews.length} views`);

            await dropViews(conn, expiredViews, logger);

            await createNewViews(conn, views, logger);
        });
    }

    export async function dropAllViews(conn: pg.Client, logger: (message: string) => Promise<void>): Promise<void> {
        await withTransaction(conn, async () => {
            await logger("Acquiring schema_version table lock...");
            await tryRunPg("lock \"schema_version\" table", () => conn.query("LOCK TABLE schema_version IN SHARE UPDATE EXCLUSIVE MODE"));

            const viewNames = await selectAllSqlViews(conn);
            await dropViews(conn, viewNames, logger);
        });
    }

    export async function dropViews(conn: pg.Client, viewNames: string[], logger: (message: string) => Promise<void>): Promise<void> {
        let i = 0;
        for (const viewName of viewNames) {
            await logger(`(${++i}/${viewNames.length}) Dropping view ${escapeIdentifier(viewName)}`);
            await runAndDropDependentViews(conn, async () => {
                await conn.query(`DROP VIEW IF EXISTS ${escapeIdentifier(viewName)}`);
            });
        }
    }
}

async function selectAllSqlViews(conn: pg.Client): Promise<string[]> {
    const queryResult = await conn.query(
        `
        select
            relname
        from
            pg_class
        where
            relkind = 'v'
            and relname::text like '$$mfv_%'
        order by relname
        `);

    const viewNames: string[] = [];
    for (const row of queryResult.rows) {
        viewNames.push(row["relname"]);
    }

    return viewNames;
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
    table: string | null;
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
        table: err.table !== undefined ? err.table : null,
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
async function randomSavepointName(): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
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
