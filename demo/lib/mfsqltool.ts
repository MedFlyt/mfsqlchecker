import * as fs from "fs";
import * as pg from "pg";
import * as stackTrace from "stack-trace";
import { calcViewName } from "./view_names";

export type ColumnParser<T> = (value: any) => T;

export class Connection<T> {
    /**
     * Used only to statically identify this type
     */
    protected readonly MfConnectionTypeTag: undefined;

    constructor(client: pg.Client) {
        this.client = client;
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
        let text = "";
        const values: any[] = [];

        text += literals[0];

        for (let i = 0; i < placeholders.length; ++i) {
            const placeholder = placeholders[i];
            if (placeholder instanceof SqlView) {
                if (!placeholder.isResolved()) {
                    throw new Error(`View "${placeholder.getViewName()}" has not been created. Views are only allowed to be defined at module-level scope`);
                }
                text += `"${placeholder.getViewName()}"`;
            } else {
                values.push(this.preparePlaceholder(placeholder));
                text += `($${values.length})`;
            }

            text += literals[i + 1];
        }

        return new SqlQueryExpr(text, values);
    }

    async query<Row extends object = any>(query: SqlQueryExpr<T>): Promise<ResultRow<Row>[]> {
        // Use this instead of the built-in promise support of pg.Client because
        // `connectionLogSQL` (currently) needs an actual callback
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

        const queryResult = await clientQueryPromise(this.client, query.text, query.values);
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

class SqlQueryExpr<T> {
    constructor(text: string, values: any[]) {
        this.text = text;
        this.values = values;
    }

    public readonly text: string;
    public readonly values: any[];

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

class SqlView {
    constructor(viewName: string) {
        this.viewName = viewName;
    }

    getViewName(): string {
        return this.viewName;
    }

    isResolved(): boolean {
        return this.resolved;
    }

    setResolved(): void {
        this.resolved = true;
    }

    private readonly viewName: string;

    /**
     * Will be mutated to "true" in "initAllViews" (So that later during
     * run-time we can validate that "defineSqlView" was called properly (from
     * top-level, and not inside some function)
     */
    private resolved: boolean = false;
}

interface SqlCreateView {
    readonly viewName: string;
    readonly createQuery: string;
}

const allSqlViewCreateStatements: SqlCreateView[] = [];

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

    allSqlViewCreateStatements.push({
        viewName: viewName,
        createQuery:
            `
            CREATE OR REPLACE VIEW ${viewName}
            AS ${query}
            `
    });

    return new SqlView(viewName);
}

export async function dbExecute(_conn: pg.Client, _query: string): Promise<void> {
    throw new Error("TODO");
}

export async function dbQueryFindMissingViews(_conn: pg.Client, _viewNames: string[]): Promise<Set<string>> {
    throw new Error("TODO");
}

export async function initAllViews(conn: pg.Client) {
    // TODO Do this all in a single transaction (or maybe not?)

    const missingViews: Set<string> = await dbQueryFindMissingViews(conn, allSqlViewCreateStatements.map(view => view.viewName));

    for (const view of allSqlViewCreateStatements) {
        if (missingViews.has(view.viewName)) {
            await dbExecute(conn, view.createQuery);
        }
    }

    allSqlViewCreateStatements.splice(0, allSqlViewCreateStatements.length);
}
