import * as stackTrace from "stack-trace";
import * as crypto from "crypto";
import * as fs from "fs";

class SqlQueryExpr {
    private text: string;
    private values: any[];
    protected dummy: SqlQueryExpr[];
}

type SqlQueryPlaceHolder = SqlView | number | string | boolean | null;

export function sql(literals: TemplateStringsArray, ...placeholders: SqlQueryPlaceHolder[]): SqlQueryExpr {
    console.log("sql:");
    console.log("literals", literals);
    console.log("placeholders", placeholders);
    console.log("QUERY", JSON.stringify(literals.join("$1")));
    return {
        x: 0
    };
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
}

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

export function query<Row extends object = any>(_conn: Connection, _query: SqlQueryExpr): ResultRow<Row>[] {
    throw new Error("TODO");
}

interface SqlView {
    type: "SqlView";
    readonly viewName: string;
    resolved: boolean; // Will be mutated to "true" in "initAllViews" (So that later during run-time we can validate that "defineSqlView" was called properly (from top-level, and not inside some function)
}

interface SqlCreateView {
    viewName: string;
    createQuery: string;
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

function calcViewName(varName: string | null, query: string) {
    const hash = crypto.createHash("sha1").update(query).digest("hex");

    const viewName = varName !== null
        ? "view_" + varName.split(/(?=[A-Z])/).join('_').toLowerCase() + "_" + hash.slice(0, 12)
        : "view_" + hash.slice(0, 12);

    return viewName;
}

export function defineSqlView(x: TemplateStringsArray, ...placeholders: SqlView[]): SqlView {
    const varName = peekAssignedVariableName();

    let query: string = x[0];
    for (let i = 0; i < placeholders.length; ++i) {
        query += "\"" + placeholders[i].viewName + "\"";
        query += x[i + 1];
    }

    const viewName = calcViewName(varName, query);

    console.log(varName);

    console.log(JSON.stringify(query), viewName);


    allSqlViewCreateStatements.push({
        viewName: viewName,
        createQuery:
            `
            CREATE OR REPLACE VIEW ${viewName}
            AS ${query}
            `
    });

    return {
        type: "SqlView",
        viewName: viewName,
        resolved: false
    };
}

export interface Connection { }

export async function dbExecute(_conn: Connection, _query: string): Promise<void> {
    throw new Error("TODO");
}

export async function dbQueryFindMissingViews(_conn: Connection, _viewNames: string[]): Promise<Set<string>> {
    throw new Error("TODO");
}

export async function initAllViews(conn: Connection) {
    // TODO Do this all in a single transaction (or maybe not?)

    const missingViews: Set<string> = await dbQueryFindMissingViews(conn, allSqlViewCreateStatements.map(view => view.viewName));

    for (const view of allSqlViewCreateStatements) {
        if (missingViews.has(view.viewName)) {
            await dbExecute(conn, view.createQuery);
        }
    }

    allSqlViewCreateStatements.splice(0, allSqlViewCreateStatements.length);
}
