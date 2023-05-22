import {
    ColNullability,
    ColTypesFormat,
    connectPg,
    connReplaceDbName,
    defaultColTypesFormat,
    dropAllFunctions,
    dropAllSequences,
    dropAllTables,
    dropAllTypes,
    ErrorDiagnostic,
    escapeIdentifier,
    isMigrationFile,
    makeUniqueColumnTypes,
    parsePostgreSqlError,
    pgDescribeQuery,
    PostgreSqlError,
    postgresqlErrorDiagnostic,
    QualifiedSqlViewName,
    readdirAsync,
    ResolvedInsert,
    ResolvedSelect,
    resolveFromSourceMap,
    SqlCreateView,
    SqlType,
    sqlUniqueTypeName,
    SrcSpan,
    testDatabaseName,
    toSrcSpan,
    TypeScriptType,
    UniqueTableColumnType
} from "@mfsqlchecker/core";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import postgres from "postgres";
import invariant from "tiny-invariant";
import { InvalidQueryError } from "./errors";
import { E, pipe, TE } from "./fp-ts";
import { customLog } from "./log";

type QueryRunnerConfig = {
    migrationsDir: string;
    client: postgres.Sql;
};

export class QueryRunner {
    private migrationsDir: string;
    private client: postgres.Sql;

    constructor(config: QueryRunnerConfig) {
        this.migrationsDir = config.migrationsDir;
        this.client = config.client;
    }

    static async Connect(params: { adminUrl: string; name?: string; migrationsDir: string }) {
        const client = await newConnect(params.adminUrl, params.name);
        return new QueryRunner({ migrationsDir: params.migrationsDir, client });
    }

    static ConnectTE(params: { adminUrl: string; name?: string; migrationsDir: string }) {
        return pipe(
            TE.tryCatch(() => QueryRunner.Connect(params), E.toError),
            TE.mapLeft(formatPgError)
        );
    }

    private prevUniqueTableColumnTypes: UniqueTableColumnType[] = [];
    private queryCache = new QueryMap<SelectAnswer>();
    private insertCache = new InsertMap<InsertAnswer>();
    private viewNames: [string, ViewAnswer][] = [];
    private pgTypes = new Map<number, SqlType>();
    private uniqueColumnTypes = new Map<SqlType, TypeScriptType>();
    private tableColsLibrary = new TableColsLibrary();
    private prevStrictDateTimeChecking: boolean | null = null;

    initializeTE(params: {
        uniqueTableColumnTypes: UniqueTableColumnType[];
        strictDateTimeChecking: boolean;
        sqlViews: SqlCreateView[];
        reset: boolean;
    }): TE.TaskEither<Error | InvalidQueryError, undefined> {
        return pipe(
            TE.Do,
            TE.chain(() => TE.tryCatch(() => this.initialize(params), E.toError)),
            TE.match(
                (error) => E.left(error),
                (result) => {
                    return result.length === 0
                        ? E.right(undefined)
                        : E.left(new InvalidQueryError(result));
                }
            )
        );
    }

    async updateViews(params: { strictDateTimeChecking: boolean; sqlViews: SqlCreateView[] }) {
        if (params.strictDateTimeChecking !== this.prevStrictDateTimeChecking) {
            await this.dropViews();
        }

        this.prevStrictDateTimeChecking = params.strictDateTimeChecking;

        let queryErrors: ErrorDiagnostic[] = [];

        const [updated, newViewNames] = await updateViews(
            this.client,
            params.strictDateTimeChecking,
            this.viewNames,
            params.sqlViews
        );

        if (updated) {
            await this.tableColsLibrary.refreshViews(this.client);
        }

        this.viewNames = newViewNames;

        for (const [viewName, viewAnswer] of this.viewNames) {
            const createView = params.sqlViews.find((x) => x.viewName === viewName);
            invariant(createView !== undefined, `view ${viewName} not found (probably a bug).`);
            queryErrors = queryErrors.concat(viewAnswerToErrorDiagnostics(createView, viewAnswer));
        }

        return queryErrors;
    }

    async initialize(params: {
        uniqueTableColumnTypes: UniqueTableColumnType[];
        strictDateTimeChecking: boolean;
        sqlViews: SqlCreateView[];
        reset: boolean;
    }) {
        if (!params.reset) {
            customLog.info("skipping database reset");
        }

        this.prevUniqueTableColumnTypes = params.uniqueTableColumnTypes;
        this.uniqueColumnTypes = makeUniqueColumnTypes(this.prevUniqueTableColumnTypes);
        customLog.info("done make unique column types");

        if (params.reset) {
            await this.dropViews();

            await dropAllTables(this.client);
            await dropAllSequences(this.client);
            await dropAllTypes(this.client);
            await dropAllFunctions(this.client);

            const allFiles = await readdirAsync(this.migrationsDir);
            const matchingFiles = allFiles.filter(isMigrationFile).sort();
            for (const matchingFile of matchingFiles) {
                customLog.info("running migration", matchingFile);
                const text = await readFileAsync(path.join(this.migrationsDir, matchingFile));
                try {
                    await this.client.unsafe(text);
                } catch (err) {
                    const postgresError = parsePostgreSqlError(err);
                    if (postgresError === null) {
                        throw err;
                    }

                    const errorDiagnostic = postgresqlErrorDiagnostic(
                        path.join(this.migrationsDir, matchingFile),
                        text,
                        postgresError,
                        postgresError.position !== null
                            ? toSrcSpan(text, postgresError.position)
                            : { type: "File" },
                        "Error in migration file"
                    );

                    return [errorDiagnostic];
                }
            }
            customLog.success("start applying unique table column types...");
            await applyUniqueTableColumnTypes(this.client, this.prevUniqueTableColumnTypes);
            customLog.success("done applying unique table column types");
        }

        await this.tableColsLibrary.refreshTables(this.client);
        customLog.info("done refresh tables");

        this.pgTypes = new Map<number, SqlType>();
        const pgTypesResult = await this.client.unsafe(
            `
                SELECT
                    oid,
                    typname
                FROM pg_type
                ORDER BY oid
                `
        );
        for (const row of pgTypesResult) {
            const oid: number = row["oid"];
            const typname: string = row["typname"];
            this.pgTypes.set(oid, SqlType.wrap(typname));
        }
        customLog.info("done pg types");

        // We modify the system catalogs only inside a transaction, so that we
        // can ROLLBACK the changes later. This is needed so that in the
        // future if we need to run our migrations again, they can be run on
        // the original system catalogs.
        // await this.client.unsafe("BEGIN");

        if (params.strictDateTimeChecking) {
            await modifySystemCatalogs(this.client);
            customLog.info("done modify system catalogs");
        }

        const diagnostics = await this.updateViews(params);
        customLog.info("done update views");

        return diagnostics;
    }

    runQueryTE(params: { resolved: ResolvedSelect }) {
        const { resolved } = params;
        const cached = this.queryCache.get(resolved.text, resolved.colTypes);

        if (cached !== undefined) {
            return TE.right(
                queryAnswerToErrorDiagnostics(params.resolved, cached, defaultColTypesFormat)
            );
        }

        return pipe(
            TE.Do,
            TE.chain(() =>
                TE.tryCatch(() => {
                    return processQuery(
                        this.client,
                        defaultColTypesFormat,
                        this.pgTypes,
                        this.tableColsLibrary,
                        this.uniqueColumnTypes,
                        params.resolved
                    );
                }, E.toError)
            ),
            TE.map((answer) => {
                this.queryCache.set(resolved.text, resolved.colTypes, answer);

                return queryAnswerToErrorDiagnostics(
                    params.resolved,
                    answer,
                    defaultColTypesFormat
                );
            })
        );
    }

    runInsertTE(params: { resolved: ResolvedInsert }) {
        const { resolved } = params;

        const cached = this.insertCache.get(
            resolved.text,
            resolved.colTypes,
            resolved.tableName,
            resolved.insertColumns
        );

        if (cached !== undefined) {
            return TE.right(
                insertAnswerToErrorDiagnostics(params.resolved, cached, defaultColTypesFormat)
            );
        }

        return pipe(
            TE.Do,
            TE.chain(() =>
                TE.tryCatch(() => {
                    return processInsert(
                        this.client,
                        defaultColTypesFormat,
                        this.pgTypes,
                        this.tableColsLibrary,
                        this.uniqueColumnTypes,
                        params.resolved
                    );
                }, E.toError)
            ),
            TE.map((answer) => {
                this.insertCache.set(
                    resolved.text,
                    resolved.colTypes,
                    resolved.tableName,
                    resolved.insertColumns,
                    answer
                );

                return insertAnswerToErrorDiagnostics(
                    params.resolved,
                    answer,
                    defaultColTypesFormat
                );
            })
        );
    }

    async end() {
        await this.client.end();
    }

    private async dropViews(): Promise<void> {
        for (let i = this.viewNames.length - 1; i >= 0; --i) {
            const viewName = this.viewNames[i];
            await dropView(this.client, viewName[0]);
        }
        this.viewNames = [];
    }
}

async function dropView(client: postgres.Sql, viewName: string): Promise<void> {
    await client.unsafe(`DROP VIEW IF EXISTS ${escapeIdentifier(viewName)}`);
}

/**
 * @returns Array with the same length as `newViews`, with a matching element
 * for each view in `newViews`
 */
async function updateViews(
    client: postgres.Sql,
    strictDateTimeChecking: boolean,
    oldViews: [string, ViewAnswer][],
    newViews: SqlCreateView[]
): Promise<[boolean, [string, ViewAnswer][]]> {
    let updated: boolean = false;

    const newViewNames = new Set<string>();
    newViews.forEach((v) => newViewNames.add(v.viewName));

    for (let i = oldViews.length - 1; i >= 0; --i) {
        const viewName = oldViews[i];
        if (!newViewNames.has(viewName[0])) {
            await dropView(client, viewName[0]);
            updated = true;
        }
    }

    const oldViewAnswers = new Map<string, ViewAnswer>();
    oldViews.forEach(([viewName, viewAnswer]) => oldViewAnswers.set(viewName, viewAnswer));

    const result: [string, ViewAnswer][] = [];

    for (const view of newViews) {
        const oldAnswer = oldViewAnswers.get(view.viewName);
        if (oldAnswer !== undefined) {
            result.push([view.viewName, oldAnswer]);
        } else {
            const answer = await processCreateView(client, strictDateTimeChecking, view);
            result.push([view.viewName, answer]);
            updated = true;
        }
    }

    return [updated, result];
}

// This regexp is a bit of a hack, but hopefully works. The goal is to still
// allow COUNT(*) as well as multiplication
const SELECT_STAR_REGEX = new RegExp("(select|\\.|\\,)\\s*\\*", "i");

function validateViewFeatures(view: SqlCreateView): ViewAnswer {
    // We don't allow using `SELECT *` in views.
    //
    // The reason is that PostgreSQL will expand the star only once, at
    // view-create time (not each time the view is queried). This can cause bad
    // inconsistencies where old views will not have the expected columns. Even
    // worse, it can cause the DB migration to fail on the "CREATE OR REPLACE
    // VIEW ..." call when an existing view exists but the expanded column lists
    // differ.

    const searchIndex = view.createQuery.search(SELECT_STAR_REGEX);
    if (searchIndex >= 0) {
        return {
            type: "InvalidFeatureError",
            viewName: view.viewName,
            message: "SELECT * not allowed in views. List all columns explicitly",
            position: view.createQuery.indexOf("*", searchIndex) + 1
        };
    }

    return {
        type: "NoErrors"
    };
}

async function processCreateView(
    client: postgres.Sql,
    strictDateTimeChecking: boolean,
    view: SqlCreateView
): Promise<ViewAnswer> {
    // await client.unsafe("BEGIN");
    if (strictDateTimeChecking) {
        await modifySystemCatalogs(client);
    }
    try {
        await client.unsafe(
            `CREATE OR REPLACE VIEW ${escapeIdentifier(view.viewName)} AS ${view.createQuery}`
        );
    } catch (err) {
        const perr = parsePostgreSqlError(err);
        if (perr === null) {
            throw err;
        } else {
            // await client.unsafe("ROLLBACK");
            if (perr.position !== null) {
                // A bit hacky but does the trick:
                perr.position -= `CREATE OR REPLACE VIEW ${escapeIdentifier(
                    view.viewName
                )} AS `.length;
            }
            return {
                type: "CreateError",
                viewName: QualifiedSqlViewName.viewName(view.qualifiedViewname),
                perr: perr
            };
        }
    }

    // We need to ROLLBACK in order to restore the system catalogs, but the
    // rollback will also undo the VIEW we just created. So after the rollback
    // we need to create the VIEW again. Since it succeeded the first time, it
    // should also succeed the second time (the modifications we make to the
    // system catalogs only make things more restrictive)

    // await client.unsafe("ROLLBACK");
    await client.unsafe(
        `CREATE OR REPLACE VIEW ${escapeIdentifier(view.viewName)} AS ${view.createQuery}`
    );

    const invalidFeatureError = validateViewFeatures(view);
    if (invalidFeatureError.type !== "NoErrors") {
        return invalidFeatureError;
    }

    return {
        type: "NoErrors"
    };
}

type ViewAnswer = ViewAnswer.NoErrors | ViewAnswer.CreateError | ViewAnswer.InvalidFeatureError;

namespace ViewAnswer {
    export interface NoErrors {
        type: "NoErrors";
    }

    export interface CreateError {
        type: "CreateError";
        viewName: string;
        perr: PostgreSqlError;
    }

    export interface InvalidFeatureError {
        type: "InvalidFeatureError";
        viewName: string;
        message: string;
        position: number;
    }
}

function viewAnswerToErrorDiagnostics(
    createView: SqlCreateView,
    viewAnswer: ViewAnswer
): ErrorDiagnostic[] {
    switch (viewAnswer.type) {
        case "NoErrors":
            return [];
        case "CreateError": {
            const message = 'Error in view "' + chalk.bold(viewAnswer.viewName) + '"';
            if (viewAnswer.perr.position !== null) {
                const srcSpan = resolveFromSourceMap(
                    createView.fileContents,
                    viewAnswer.perr.position - 1,
                    createView.sourceMap
                );
                return [
                    postgresqlErrorDiagnostic(
                        createView.fileName,
                        createView.fileContents,
                        viewAnswer.perr,
                        srcSpan,
                        message
                    )
                ];
            } else {
                return [
                    postgresqlErrorDiagnostic(
                        createView.fileName,
                        createView.fileContents,
                        viewAnswer.perr,
                        querySourceStart(createView.fileContents, createView.sourceMap),
                        message
                    )
                ];
            }
        }
        case "InvalidFeatureError": {
            const srcSpan = resolveFromSourceMap(
                createView.fileContents,
                viewAnswer.position - 1,
                createView.sourceMap
            );
            return [
                {
                    fileName: createView.fileName,
                    fileContents: createView.fileContents,
                    span: srcSpan,
                    messages: [
                        chalk.bold('Error in view "' + chalk.bold(viewAnswer.viewName) + '"'),
                        viewAnswer.message
                    ],
                    epilogue: null,
                    quickFix: null
                }
            ];
        }
    }
}

/**
 * Type safe "Map"-like from queries to some T
 */
class QueryMap<T> {
    set(
        text: string,
        colTypes: Map<string, [ColNullability, TypeScriptType]> | null,
        value: T
    ): void {
        this.internalMap.set(QueryMap.toKey(text, colTypes), value);
    }

    get(
        text: string,
        colTypes: Map<string, [ColNullability, TypeScriptType]> | null
    ): T | undefined {
        return this.internalMap.get(QueryMap.toKey(text, colTypes));
    }

    clear(): void {
        this.internalMap = new Map<string, T>();
    }

    private static toKey(
        text: string,
        colTypes: Map<string, [ColNullability, TypeScriptType]> | null
    ): string {
        // TODO Will this really always give a properly unique key?
        return text + (colTypes === null ? "[NULL]" : stringifyColTypes(colTypes));
    }

    private internalMap = new Map<string, T>();
}

/**
 * Type safe "Map"-like from insert queries to some T
 */
class InsertMap<T> {
    set(
        text: string,
        colTypes: Map<string, [ColNullability, TypeScriptType]> | null,
        tableName: string,
        insertColumns: Map<string, [TypeScriptType, boolean]>,
        value: T
    ): void {
        this.internalMap.set(InsertMap.toKey(text, colTypes, tableName, insertColumns), value);
    }

    get(
        text: string,
        colTypes: Map<string, [ColNullability, TypeScriptType]> | null,
        tableName: string,
        insertColumns: Map<string, [TypeScriptType, boolean]>
    ): T | undefined {
        return this.internalMap.get(InsertMap.toKey(text, colTypes, tableName, insertColumns));
    }

    clear(): void {
        this.internalMap = new Map<string, T>();
    }

    private static toKey(
        text: string,
        colTypes: Map<string, [ColNullability, TypeScriptType]> | null,
        tableName: string,
        insertColumns: Map<string, [TypeScriptType, boolean]>
    ): string {
        // TODO Will this really always give a properly unique key?
        return (
            text +
            (colTypes === null ? "" : stringifyColTypes(colTypes)) +
            '"' +
            tableName +
            '"' +
            stringifyInsertColumns(insertColumns)
        );
    }

    private internalMap = new Map<string, T>();
}

function stringifyInsertColumns(insertColumns: Map<string, [TypeScriptType, boolean]>): string {
    const keys = [...insertColumns.keys()];
    keys.sort();
    let result = "";
    for (const key of keys) {
        const value = insertColumns.get(key);
        if (value === undefined) {
            throw new Error("The Impossible Happened");
        }
        result += `${JSON.stringify(key)}:[${value[0]}, ${value[1]}]\n`;
    }
    return result;
}

export type SelectAnswer =
    | QueryAnswer.NoErrors
    | QueryAnswer.DescribeError
    | QueryAnswer.DuplicateColNamesError
    | QueryAnswer.WrongColumnTypes;

type InsertAnswer =
    | QueryAnswer.NoErrors
    | QueryAnswer.DescribeError
    | QueryAnswer.DuplicateColNamesError
    | QueryAnswer.WrongColumnTypes
    | QueryAnswer.InvalidTableName
    | QueryAnswer.InvalidInsertCols;

namespace QueryAnswer {
    export interface NoErrors {
        type: "NoErrors";
    }

    export interface DescribeError {
        type: "DescribeError";
        perr: PostgreSqlError;
    }

    export interface DuplicateColNamesError {
        type: "DuplicateColNamesError";
        duplicateResultColumns: string[];
    }

    export interface WrongColumnTypes {
        type: "WrongColumnTypes";
        renderedColTypes: string;
    }

    export interface InvalidTableName {
        type: "InvalidTableName";
    }

    export type InvalidInsertCol =
        | InvalidInsertCol.MissingRequiredCol
        | InvalidInsertCol.ColWrongType
        | InvalidInsertCol.ColNotFound;

    export namespace InvalidInsertCol {
        export interface MissingRequiredCol {
            type: "MissingRequiredCol";
            tableName: string;
            colName: string;
            colType: TypeScriptType;
        }

        export interface ColWrongType {
            type: "ColWrongType";
            tableName: string;
            colName: string;
            colType: TypeScriptType;
            invalidType: TypeScriptType;
        }

        export interface ColNotFound {
            type: "ColNotFound";
            tableName: string;
            colName: string;
            invalidType: TypeScriptType;
        }
    }

    export interface InvalidInsertCols {
        type: "InvalidInsertCols";
        invalidCols: InvalidInsertCol[];
    }
}

function querySourceStart(fileContents: string, sourceMap: [number, number, number][]): SrcSpan {
    return toSrcSpan(
        fileContents,
        fileContents.slice(sourceMap[0][0] + 1).search(/\S/) + sourceMap[0][0] + 2
    );
}

function queryAnswerToErrorDiagnostics(
    query: ResolvedSelect,
    queryAnswer: SelectAnswer,
    colTypesFormat: ColTypesFormat
): ErrorDiagnostic[] {
    switch (queryAnswer.type) {
        case "NoErrors":
            return [];
        case "DescribeError":
            if (queryAnswer.perr.position !== null) {
                const srcSpan = resolveFromSourceMap(
                    query.fileContents,
                    queryAnswer.perr.position - 1,
                    query.sourceMap
                );
                return [
                    postgresqlErrorDiagnostic(
                        query.fileName,
                        query.fileContents,
                        queryAnswer.perr,
                        srcSpan,
                        null
                    )
                ];
            } else {
                return [
                    postgresqlErrorDiagnostic(
                        query.fileName,
                        query.fileContents,
                        queryAnswer.perr,
                        querySourceStart(query.fileContents, query.sourceMap),
                        null
                    )
                ];
            }
        case "DuplicateColNamesError":
            return [
                {
                    fileName: query.fileName,
                    fileContents: query.fileContents,
                    span: querySourceStart(query.fileContents, query.sourceMap),
                    messages: [
                        `Query return row contains duplicate column names:\n${JSON.stringify(
                            queryAnswer.duplicateResultColumns,
                            null,
                            2
                        )}`
                    ],
                    epilogue:
                        chalk.bold("hint") +
                        ': Specify a different name for the column using the Sql "AS" keyword',
                    quickFix: null
                }
            ];
        case "WrongColumnTypes":
            let replacementText: string;

            let colTypes = queryAnswer.renderedColTypes.split("\n");

            // `colTypes` looks something like:
            //
            //     [ "{",
            //       "    foo: Req<number>,",
            //       "    bar: Opt<string>",
            //       "}"
            //     ]

            if (colTypes.length <= 2) {
                // {
                // }
                replacementText = "<{}>";
            } else if (colTypes.length === 3) {
                // {
                //   foo: Req<number>
                // }
                colTypes = colTypes.map((c) => c.trimLeft());
                colTypes[1] = " ".repeat(query.indentLevel + 4) + colTypes[1];
                colTypes[2] = " ".repeat(query.indentLevel) + colTypes[2];
                replacementText = "<" + colTypes.join("\n") + ">";
            } else if (colTypes.length > 3) {
                // {
                //   foo: Req<number>,
                //   bar: Opt<string>
                // }
                colTypes = colTypes.map((c) => c.trimLeft());
                for (let i = 1; i < colTypes.length - 1; ++i) {
                    colTypes[i] = " ".repeat(query.indentLevel + 4) + colTypes[i];
                }
                colTypes[colTypes.length - 1] =
                    " ".repeat(query.indentLevel) + colTypes[colTypes.length - 1];

                if (colTypesFormat.includeRegionMarker) {
                    colTypes.splice(1, 0, " ".repeat(query.indentLevel + 4) + "//#region ColTypes");
                    colTypes.splice(
                        colTypes.length - 1,
                        0,
                        " ".repeat(query.indentLevel + 4) + "//#endregion"
                    );
                }

                replacementText = "<" + colTypes.join("\n") + ">";
            } else {
                throw new Error(`Invalid colTypes.length: ${queryAnswer.renderedColTypes}`);
            }

            if (query.queryMethodName !== null) {
                replacementText = query.queryMethodName + replacementText;
            }

            return [
                {
                    fileName: query.fileName,
                    fileContents: query.fileContents,
                    span: query.colTypeSpan,
                    messages: ["Wrong Column Types"],
                    epilogue: chalk.bold("Fix it to:") + "\n" + queryAnswer.renderedColTypes,
                    quickFix: {
                        name: "Fix Column Types",
                        replacementText: replacementText
                    }
                }
            ];
    }
}

function insertAnswerToErrorDiagnostics(
    query: ResolvedInsert,
    queryAnswer: InsertAnswer,
    colTypesFormat: ColTypesFormat
): ErrorDiagnostic[] {
    switch (queryAnswer.type) {
        case "NoErrors":
            return [];
        case "DescribeError":
        case "DuplicateColNamesError":
        case "WrongColumnTypes":
            return queryAnswerToErrorDiagnostics(query, queryAnswer, colTypesFormat);
        case "InvalidTableName":
            return [
                {
                    fileName: query.fileName,
                    fileContents: query.fileContents,
                    span: query.tableNameExprSpan,
                    messages: [`Table does not exist: "${query.tableName}"`],
                    epilogue: null,
                    quickFix: null
                }
            ];
        case "InvalidInsertCols":
            return [
                {
                    fileName: query.fileName,
                    fileContents: query.fileContents,
                    span: query.insertExprSpan,
                    messages: ["Inserted columns are invalid:"].concat(
                        queryAnswer.invalidCols.map((e) => {
                            switch (e.type) {
                                case "MissingRequiredCol":
                                    return `Insert to table "${e.tableName}" is missing the required column: "${e.colName}" (type "${e.colType}")`;
                                case "ColWrongType":
                                    return `Insert to table "${e.tableName}" has the wrong type for column "${e.colName}". It should be "${e.colType}" (instead of "${e.invalidType}")`;
                                case "ColNotFound":
                                    return `Column "${e.colName}" does not exist on table "${e.tableName}"`;
                            }
                        })
                    ),
                    epilogue: null,
                    quickFix: null
                }
            ];
    }
}

async function processQuery(
    client: postgres.Sql,
    colTypesFormat: ColTypesFormat,
    pgTypes: Map<number, SqlType>,
    tableColsLibrary: TableColsLibrary,
    uniqueColumnTypes: Map<SqlType, TypeScriptType>,
    query: Pick<ResolvedSelect, "colTypes" | "text">
): Promise<SelectAnswer> {
    let fields: postgres.ColumnList<string> | null;
    // const savepoint = await newSavepoint(client);
    try {
        fields = await pgDescribeQuery(client, query.text);
    } catch (err) {
        const perr = parsePostgreSqlError(err);
        if (perr === null) {
            throw err;
        } else {
            // await rollbackToAndReleaseSavepoint(client, savepoint);
            return {
                type: "DescribeError",
                perr: perr
            };
        }
    }
    // await rollbackToAndReleaseSavepoint(client, savepoint);

    const duplicateResultColumns: string[] = [];
    if (fields === null) {
        if (query.colTypes !== null && query.colTypes.size !== 0) {
            return {
                type: "WrongColumnTypes",
                renderedColTypes: "{} (Or no type argument at all)"
            };
        }
    } else {
        for (let i = 0; i < fields.length; ++i) {
            const field = fields[i];
            if (
                fields.slice(i + 1).findIndex((f) => f.name === field.name) >= 0 &&
                duplicateResultColumns.indexOf(field.name) < 0
            ) {
                duplicateResultColumns.push(field.name);
            }
        }

        if (duplicateResultColumns.length > 0) {
            return {
                type: "DuplicateColNamesError",
                duplicateResultColumns: duplicateResultColumns
            };
        }

        const sqlFields = resolveFieldDefs(tableColsLibrary, pgTypes, uniqueColumnTypes, fields);
        if (
            query.colTypes !== null &&
            stringifyColTypes(query.colTypes) !== stringifyColTypes(sqlFields)
        ) {
            return {
                type: "WrongColumnTypes",
                renderedColTypes: renderColTypesType(colTypesFormat, sqlFields)
            };
        }
    }

    return {
        type: "NoErrors"
    };
}

async function processInsert(
    client: postgres.Sql,
    colTypesFormat: ColTypesFormat,
    pgTypes: Map<number, SqlType>,
    tableColsLibrary: TableColsLibrary,
    uniqueColumnTypes: Map<SqlType, TypeScriptType>,
    query: ResolvedInsert
): Promise<InsertAnswer> {
    const tableQuery = await client.unsafe(
        `
        select
            pg_attribute.attname,
            pg_type.typname,
            pg_attribute.atthasdef,
            pg_attribute.attnotnull
        from
            pg_attribute,
            pg_class,
            pg_type
        where
        pg_attribute.attrelid = pg_class.oid
        AND pg_attribute.attnum >= 1
        AND pg_attribute.atttypid = pg_type.oid
        AND pg_class.relname = $1
        ORDER BY pg_attribute.attname
        `,
        [query.tableName]
    );

    // Assume that tables with no columns cannot exist
    if (tableQuery.count === 0) {
        return {
            type: "InvalidTableName"
        };
    }

    const result = await processQuery(
        client,
        colTypesFormat,
        pgTypes,
        tableColsLibrary,
        uniqueColumnTypes,
        query
    );
    if (result.type !== "NoErrors") {
        return result;
    }

    const insertColumnFields = [...query.insertColumns.keys()];
    insertColumnFields.sort();

    const invalidInsertCols: QueryAnswer.InvalidInsertCol[] = [];

    for (const field of insertColumnFields) {
        const suppliedType = query.insertColumns.get(field);
        if (suppliedType === undefined) {
            throw new Error("The Impossible Happened");
        }

        const [suppliedTypeName, suppliedTypeNotNull] = suppliedType;

        const row = tableQuery.find((r) => r["attname"] === field);
        if (row === undefined) {
            invalidInsertCols.push({
                type: "ColNotFound",
                tableName: query.tableName,
                colName: field,
                invalidType: suppliedTypeName
            });
        } else {
            const typname: string = row["typname"];
            const attnotnull: boolean = row["attnotnull"];
            const tblType = sqlTypeToTypeScriptType(uniqueColumnTypes, SqlType.wrap(typname));
            if (
                (suppliedTypeName !== TypeScriptType.wrap("null") &&
                    suppliedTypeName !== tblType) ||
                (attnotnull && !suppliedTypeNotNull)
            ) {
                let suppliedTypeStr = TypeScriptType.unwrap(suppliedTypeName);
                if (!suppliedTypeNotNull && suppliedTypeStr !== "null") {
                    suppliedTypeStr += " | null";
                }

                let typStr = TypeScriptType.unwrap(tblType);
                if (!attnotnull) {
                    typStr += " | null";
                }

                invalidInsertCols.push({
                    type: "ColWrongType",
                    tableName: query.tableName,
                    colName: field,
                    colType: TypeScriptType.wrap(typStr),
                    invalidType: TypeScriptType.wrap(suppliedTypeStr)
                });
            }
        }
    }

    for (const row of tableQuery) {
        const attname: string = row["attname"];
        const typname: string = row["typname"];
        const atthasdef: boolean = row["atthasdef"];
        const attnotnull: boolean = row["attnotnull"];
        if (!atthasdef) {
            if (!query.insertColumns.has(attname)) {
                let typStr = TypeScriptType.unwrap(
                    sqlTypeToTypeScriptType(uniqueColumnTypes, SqlType.wrap(typname))
                );
                if (!attnotnull) {
                    typStr += " | null";
                }

                invalidInsertCols.push({
                    type: "MissingRequiredCol",
                    tableName: query.tableName,
                    colName: attname,
                    colType: TypeScriptType.wrap(typStr)
                });
            }
        }
    }

    if (invalidInsertCols.length > 0) {
        return {
            type: "InvalidInsertCols",
            invalidCols: invalidInsertCols
        };
    } else {
        return {
            type: "NoErrors"
        };
    }
}

function psqlOidSqlType(pgTypes: Map<number, SqlType>, oid: number): SqlType {
    const name = pgTypes.get(oid);
    if (name === undefined) {
        throw new Error(`pg_type oid ${oid} not found`);
    }
    return name;
}

class TableColsLibrary {
    /**
     * After calling this method, you should also call `refreshViews`
     */
    public async refreshTables(client: postgres.Sql): Promise<void> {
        this.tableLookupTable = new Map<string, boolean>();

        // <https://www.postgresql.org/docs/current/catalog-pg-class.html>
        //     pg_catalog.pg_class.relkind char:
        //     r = ordinary table
        //     i = index
        //     S = sequence
        //     t = TOAST table
        //     v = view
        //     m = materialized view
        //     c = composite type
        //     f = foreign table
        //     p = partitioned table
        //     I = partitioned index

        const queryResult = await client.unsafe(
            `
            SELECT
                a.attrelid,
                a.attnum,
                a.attnotnull
            FROM
            pg_catalog.pg_attribute a,
            pg_catalog.pg_class c
            WHERE
            c.oid = a.attrelid
            AND a.attnum > 0
            AND c.relkind = 'r'
            `
        );

        for (const row of queryResult) {
            const attrelid: number = row["attrelid"];
            const attnum: number = row["attnum"];
            const attnotnull: boolean = row["attnotnull"];

            this.tableLookupTable.set(`${attrelid}-${attnum}`, attnotnull);
        }
    }

    public async refreshViews(client: postgres.Sql): Promise<void> {
        this.viewLookupTable = new Map<string, boolean>();

        // This query was taken from here and (slightly) adapted:
        // <https://github.com/PostgREST/postgrest/blob/5c75f0dcc295e6bd847af6d9703fad5b9c3d76c9/src/PostgREST/DbStructure.hs#L782>
        //
        // Changes from the original query:
        //   1. Changed returned columns to oid format instead of names
        //   2. Return all columns (not just primary and foreign keys)
        const queryResult = await client.unsafe(
            `
            with recursive
            views as (
              select
                c.oid       as view_id,
                n.nspname   as view_schema,
                c.relname   as view_name,
                c.oid       as view_oid,
                r.ev_action as view_definition
              from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
              join pg_rewrite r on r.ev_class = c.oid
              where c.relkind in ('v', 'm') and n.nspname = 'public'
            ),
            transform_json as (
              select
                view_id, view_schema, view_name, view_oid,
                -- the following formatting is without indentation on purpose
                -- to allow simple diffs, with less whitespace noise
                replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  regexp_replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                    view_definition::text,
                  -- This conversion to json is heavily optimized for performance.
                  -- The general idea is to use as few regexp_replace() calls as possible.
                  -- Simple replace() is a lot faster, so we jump through some hoops
                  -- to be able to use regexp_replace() only once.
                  -- This has been tested against a huge schema with 250+ different views.
                  -- The unit tests do NOT reflect all possible inputs. Be careful when changing this!
                  -- -----------------------------------------------
                  -- pattern           | replacement         | flags
                  -- -----------------------------------------------
                  -- "," is not part of the pg_node_tree format, but used in the regex.
                  -- This removes all "," that might be part of column names.
                      ','               , ''
                  -- The same applies for "{" and "}", although those are used a lot in pg_node_tree.
                  -- We remove the escaped ones, which might be part of column names again.
                  ), '\\{'              , ''
                  ), '\\}'              , ''
                  -- The fields we need are formatted as json manually to protect them from the regex.
                  ), ' :targetList '   , ',"targetList":'
                  ), ' :resno '        , ',"resno":'
                  ), ' :resorigtbl '   , ',"resorigtbl":'
                  ), ' :resorigcol '   , ',"resorigcol":'
                  -- Make the regex also match the node type, e.g. "{QUERY ...", to remove it in one pass.
                  ), '{'               , '{ :'
                  -- Protect node lists, which start with "({" or "((" from the greedy regex.
                  -- The extra "{" is removed again later.
                  ), '(('              , '{(('
                  ), '({'              , '{({'
                  -- This regex removes all unused fields to avoid the need to format all of them correctly.
                  -- This leads to a smaller json result as well.
                  -- Removal stops at "," for used fields (see above) and "}" for the end of the current node.
                  -- Nesting can't be parsed correctly with a regex, so we stop at "{" as well and
                  -- add an empty key for the followig node.
                  ), ' :[^}{,]+'       , ',"":'              , 'g'
                  -- For performance, the regex also added those empty keys when hitting a "," or "}".
                  -- Those are removed next.
                  ), ',"":}'           , '}'
                  ), ',"":,'           , ','
                  -- This reverses the "node list protection" from above.
                  ), '{('              , '('
                  -- Every key above has been added with a "," so far. The first key in an object doesn't need it.
                  ), '{,'              , '{'
                  -- pg_node_tree has "()" around lists, but JSON uses "[]"
                  ), '('               , '['
                  ), ')'               , ']'
                  -- pg_node_tree has " " between list items, but JSON uses ","
                  ), ' '             , ','
                  -- "<>" in pg_node_tree is the same as "null" in JSON, but due to very poor performance of json_typeof
                  -- we need to make this an empty array here to prevent json_array_elements from throwing an error
                  -- when the targetList is null.
                  ), '<>'              , '[]'
                )::json as view_definition
              from views
            ),
            target_entries as(
              select
                view_id, view_schema, view_name, view_oid,
                json_array_elements(view_definition->0->'targetList') as entry
              from transform_json
            ),
            results as(
              select
                view_id, view_schema, view_name, view_oid,
                (entry->>'resno')::int as view_column,
                (entry->>'resorigtbl')::oid as resorigtbl,
                (entry->>'resorigcol')::int as resorigcol
              from target_entries
            ),
            recursion as(
              select r.*
              from results r
              where view_schema = 'public'
              union all
              select
                view.view_id,
                view.view_schema,
                view.view_name,
                view.view_oid,
                view.view_column,
                tab.resorigtbl,
                tab.resorigcol
              from recursion view
              join results tab on view.resorigtbl=tab.view_id and view.resorigcol=tab.view_column
            )
            select
              -- sch.nspname as table_schema,
              -- tbl.relname as table_name,
              tbl.oid as table_oid,
              -- col.attname as table_column_name,
              col.attnum as table_column_num,
              -- rec.view_schema,
              -- rec.view_name,
              rec.view_oid,
              -- vcol.attname as view_column_name,
              vcol.attnum as view_column_num
            from recursion rec
            join pg_class tbl on tbl.oid = rec.resorigtbl
            join pg_attribute col on col.attrelid = tbl.oid and col.attnum = rec.resorigcol
            join pg_attribute vcol on vcol.attrelid = rec.view_id and vcol.attnum = rec.view_column
            join pg_namespace sch on sch.oid = tbl.relnamespace
            order by view_oid, view_column_num
            `
        );

        for (const row of queryResult) {
            const viewOid: number = row["view_oid"];
            const viewColumnNum: number = row["view_column_num"];
            const tableOid: number = row["table_oid"];
            const tableColumnNum: number = row["table_column_num"];

            const isNotNull = this.isNotNull(tableOid, tableColumnNum);
            this.viewLookupTable.set(`${viewOid}-${viewColumnNum}`, isNotNull);
        }
    }

    public isNotNull(tableID: number, columnID: number): boolean {
        const notNull1 = this.tableLookupTable.get(`${tableID}-${columnID}`);
        if (notNull1 !== undefined) {
            return notNull1;
        }

        const notNull2 = this.viewLookupTable.get(`${tableID}-${columnID}`);
        if (notNull2 !== undefined) {
            return notNull2;
        }

        return false;
    }

    private tableLookupTable = new Map<string, boolean>();
    private viewLookupTable = new Map<string, boolean>();
}

function resolveFieldDefs(
    tableColsLibrary: TableColsLibrary,
    pgTypes: Map<number, SqlType>,
    uniqueColumnTypes: Map<SqlType, TypeScriptType>,
    fields: postgres.ColumnList<string>
): Map<string, [ColNullability, TypeScriptType]> {
    const result = new Map<string, [ColNullability, TypeScriptType]>();

    for (const field of fields) {
        const sqlType = psqlOidSqlType(pgTypes, field.type);
        let colNullability: ColNullability = ColNullability.OPT;
        if (field.table > 0) {
            const notNull = tableColsLibrary.isNotNull(field.table, field.number);
            if (notNull) {
                colNullability = ColNullability.REQ;
            }
        }
        const typeScriptType = sqlTypeToTypeScriptType(uniqueColumnTypes, sqlType);
        result.set(field.name, [colNullability, typeScriptType]);
    }

    return result;
}

function sqlTypeToTypeScriptType(
    uniqueColumnTypes: Map<SqlType, TypeScriptType>,
    sqlType: SqlType
): TypeScriptType {
    // "The array type typically has the same name as the base type with the
    // underscore character (_) prepended."
    //
    // See: <https://www.postgresql.org/docs/12/xtypes.html#id-1.8.3.16.13.1>
    if (SqlType.unwrap(sqlType).startsWith("_")) {
        const elemType = sqlTypeToTypeScriptType(
            uniqueColumnTypes,
            SqlType.wrap(SqlType.unwrap(sqlType).substring(1))
        );
        return TypeScriptType.wrap(`(${TypeScriptType.unwrap(elemType)} | null)[]`);
    }

    switch (SqlType.unwrap(sqlType)) {
        case "int2":
        case "int4":
        case "int8":
        case "numeric":
            return TypeScriptType.wrap("number");
        case "text":
            return TypeScriptType.wrap("string");
        case "bool":
            return TypeScriptType.wrap("boolean");
        case "float4":
        case "float8":
            return TypeScriptType.wrap("number");

        // TODO Temporary
        case "jsonb":
            return TypeScriptType.wrap("DbJson");
        case "timestamp":
            return TypeScriptType.wrap("LocalDateTime");
        case "timestamptz":
            return TypeScriptType.wrap("Instant");
        case "date":
            return TypeScriptType.wrap("LocalDate");
        case "time":
            return TypeScriptType.wrap("LocalTime");
        case "uuid":
            return TypeScriptType.wrap("UUID");

        default:
    }

    const uniqueType = uniqueColumnTypes.get(sqlType);

    if (uniqueType !== undefined) {
        return uniqueType;
    }

    return TypeScriptType.wrap(`/* sqlTypeToTypeScriptType Unknown/Invalid type: "${sqlType}" */`);
}

function colNullabilityStr(colNullability: ColNullability): string {
    switch (colNullability) {
        case ColNullability.REQ:
            return "Req";
        case ColNullability.OPT:
            return "Opt";
    }
}

function renderIdentifier(ident: string): string {
    // TODO wrap key in double quotes if not a valid JavaScript identifier

    return ident;
}

function renderColTypesType(
    colTypesFormat: ColTypesFormat,
    colTypes: Map<string, [ColNullability, TypeScriptType]>
): string {
    if (colTypes.size === 0) {
        return "{}";
    }

    let result = "{\n";

    const delim = colTypesFormat.delimiter;

    colTypes.forEach((value, key) => {
        result += `  ${renderIdentifier(key)}: ${colNullabilityStr(
            value[0]
        )}<${TypeScriptType.unwrap(value[1])}>${delim}\n`;
    });

    switch (delim) {
        case ",":
            // Remove trailing comma and newline
            result = result.substr(0, result.length - 2);
            break;
        case ";":
            // Remove trailing newline
            result = result.substr(0, result.length - 1);
            break;
    }

    result += "\n}";
    return result;
}

/**
 * Will return a canonical representation, that can be used for comparisons
 */
function stringifyColTypes(colTypes: Map<string, [ColNullability, TypeScriptType]>): string {
    const keys = [...colTypes.keys()];
    keys.sort();
    let result = "";
    for (const key of keys) {
        const value = colTypes.get(key);
        if (value === undefined) {
            throw new Error("The Impossible Happened");
        }
        result += `${JSON.stringify(key)}:${value[0]} ${value[1]}\n`;
    }
    return result;
}

async function newConnect(adminUrl: string, name?: string): Promise<postgres.Sql> {
    const newDbName = name !== undefined ? name : await testDatabaseName();

    const client = connectPg(connReplaceDbName(adminUrl, newDbName));

    process.on("exit", () => {
        client.end();
    });

    return client;
}

function readFileAsync(fileName: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        fs.readFile(fileName, { encoding: "utf-8" }, (err, data) => {
            if (<boolean>(<any>err)) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

interface TableColumn {
    tableOid: number;
    colAttnum: number;
    typeName: string;
}

async function queryTableColumn(
    client: postgres.Sql,
    tableName: string,
    columnName: string
): Promise<TableColumn | null> {
    const result = await client.unsafe(
        `
        SELECT
        pg_class.oid AS tbloid,
        pg_attribute.attnum AS attnum,
        pg_type.typname AS typname
        FROM
        pg_attribute,
        pg_class,
        pg_type
        WHERE TRUE
        AND pg_class.oid = pg_attribute.attrelid
        AND pg_type.oid = pg_attribute.atttypid
        AND pg_class.relname = $1
        AND pg_attribute.attname = $2
        `,
        [tableName, columnName]
    );

    if (result.length === 0) {
        return null;
    } else if (result.length > 1) {
        throw new Error(
            `Multiple pg_attribute results found for Table "${tableName}" Column "${columnName}"`
        );
    }

    return {
        tableOid: result[0].tbloid,
        colAttnum: result[0].attnum,
        typeName: result[0].typname
    };
}

async function dropTableConstraints(client: postgres.Sql) {
    // Reference: <https://www.postgresql.org/docs/10/catalog-pg-constraint.html>
    const queryResult = await client.unsafe(
        `
        select
            pg_class.relname,
            pg_constraint.conname
        from
            pg_constraint,
            pg_class
        WHERE TRUE
        AND pg_constraint.conrelid = pg_class.oid
        AND pg_constraint.conrelid > 0
        AND pg_constraint.contype IN ('c', 'x');
        `
    );

    for (const row of queryResult) {
        const relname: string = row["relname"];
        const conname: string = row["conname"];

        await client.unsafe(
            `
            ALTER TABLE ${escapeIdentifier(relname)} DROP CONSTRAINT IF EXISTS ${escapeIdentifier(
                conname
            )} CASCADE
            `
        );
    }
}

async function dropTableIndexes(client: postgres.Sql) {
    const queryResult = await client.unsafe(
        `
        SELECT
            pg_class.relname AS indexname
        FROM
            pg_index,
            pg_class,
            pg_namespace
        WHERE
            pg_class.oid = pg_index.indexrelid
            AND pg_namespace.oid = pg_class.relnamespace
            AND pg_namespace.nspname = 'public'
            AND (
                indpred IS NOT NULL
                OR indexprs IS NOT NULL);
        `
    );

    for (const row of queryResult) {
        const indexname: string = row["indexname"];

        await client.unsafe(
            `
            DROP INDEX IF EXISTS ${escapeIdentifier(indexname)} CASCADE
            `
        );
    }
}

async function applyUniqueTableColumnTypes(
    client: postgres.Sql,
    uniqueTableColumnTypes: UniqueTableColumnType[]
): Promise<void> {
    // We need to drop all table constraints before converting the id columns.
    // This is because some constraints might refer to these table columns and
    // they might not like it if the column type changes.
    //
    // Remember that for our purposes constraints serve no purpose because we
    // never actually insert or update any data in the database.
    await dropTableConstraints(client);
    await dropTableIndexes(client);

    for (const uniqueTableColumnType of uniqueTableColumnTypes) {
        const tableColumn = await queryTableColumn(
            client,
            uniqueTableColumnType.tableName,
            uniqueTableColumnType.columnName
        );

        if (tableColumn !== null) {
            const queryResult = await client.unsafe(
                `
                SELECT
                    pg_constraint.conname,
                    sc.relname,
                    sa.attname
                FROM
                    pg_constraint,
                    pg_class sc,
                    pg_attribute sa,
                    pg_class tc,
                    pg_attribute ta
                WHERE TRUE
                    AND sc.oid = pg_constraint.conrelid
                    AND tc.oid = pg_constraint.confrelid
                    AND sa.attrelid = sc.oid
                    AND ta.attrelid = tc.oid
                    AND sa.attnum = pg_constraint.conkey[1]
                    AND ta.attnum = pg_constraint.confkey[1]
                    AND pg_constraint.contype = 'f'
                    AND array_length(pg_constraint.conkey, 1) = 1
                    AND array_length(pg_constraint.confkey, 1) = 1
                    AND tc.relname = $1
                    AND ta.attname = $2
                `,
                [uniqueTableColumnType.tableName, uniqueTableColumnType.columnName]
            );

            for (const row of queryResult) {
                const conname: string = row["conname"];
                const relname: string = row["relname"];

                await client.unsafe(
                    `
                    ALTER TABLE ${escapeIdentifier(relname)} DROP CONSTRAINT ${escapeIdentifier(
                        conname
                    )}
                    `
                );
            }

            const typeName = sqlUniqueTypeName(
                uniqueTableColumnType.tableName,
                uniqueTableColumnType.columnName
            );

            await client.unsafe(
                `
                CREATE TYPE ${escapeIdentifier(typeName)} AS RANGE (SUBTYPE = ${escapeIdentifier(
                    tableColumn.typeName
                )})
                `
            );

            const colName = uniqueTableColumnType.columnName;

            const colHasDefault = await tableColHasDefault(
                client,
                uniqueTableColumnType.tableName,
                colName
            );

            await client.unsafe(
                `
                ALTER TABLE ${escapeIdentifier(uniqueTableColumnType.tableName)}
                    ALTER COLUMN ${escapeIdentifier(colName)} DROP DEFAULT,
                    ALTER COLUMN ${escapeIdentifier(colName)} SET DATA TYPE ${escapeIdentifier(
                    typeName
                )} USING CASE WHEN ${escapeIdentifier(
                    colName
                )} IS NULL THEN NULL ELSE ${escapeIdentifier(typeName)}(${escapeIdentifier(
                    colName
                )}, ${escapeIdentifier(colName)}, '[]') END
                `
            );

            if (colHasDefault) {
                // Restore the column so that it has a default value
                await client.unsafe(
                    `
                    ALTER TABLE ${escapeIdentifier(uniqueTableColumnType.tableName)}
                        ALTER COLUMN ${escapeIdentifier(colName)} SET DEFAULT 'empty'
                    `
                );
            }

            for (const row of queryResult) {
                const relname: string = row["relname"];
                const attname: string = row["attname"];

                const refColHasDefault = await tableColHasDefault(client, relname, attname);

                await client.unsafe(
                    `
                    ALTER TABLE ${escapeIdentifier(relname)}
                        ALTER COLUMN ${escapeIdentifier(attname)} DROP DEFAULT,
                        ALTER COLUMN ${escapeIdentifier(attname)} SET DATA TYPE ${escapeIdentifier(
                        typeName
                    )} USING CASE WHEN ${escapeIdentifier(
                        attname
                    )} IS NULL THEN NULL ELSE ${escapeIdentifier(typeName)}(${escapeIdentifier(
                        attname
                    )}, ${escapeIdentifier(attname)}, '[]') END
                    `
                );

                if (refColHasDefault) {
                    // Restore the column so that it has a default value
                    await client.unsafe(
                        `
                        ALTER TABLE ${escapeIdentifier(relname)}
                            ALTER COLUMN ${escapeIdentifier(attname)} SET DEFAULT 'empty'
                        `
                    );
                }
            }
        }
    }
}

async function tableColHasDefault(
    client: postgres.Sql,
    tableName: string,
    colName: string
): Promise<boolean> {
    const result = await client.unsafe(
        `
        select pg_attribute.atthasdef
        from
            pg_attribute,
            pg_class
        where
        pg_attribute.attrelid = pg_class.oid
        and pg_attribute.attnum >= 1
        and pg_class.relname = $1
        and pg_attribute.attname = $2
        `,
        [tableName, colName]
    );

    if (result.count === 0) {
        throw new Error(`No pg_attribute row found for "${tableName}"."${colName}"`);
    }
    if (result.count > 1) {
        throw new Error(`Multiple pg_attribute rows found for "${tableName}"."${colName}"`);
    }

    const atthasdef: boolean = result[0]["atthasdef"];
    return atthasdef;
}

async function modifySystemCatalogs(client: postgres.Sql): Promise<void> {
    const operatorOids: number[] = [
        2345, // date_lt_timestamp
        2346, // date_le_timestamp
        2347, // date_eq_timestamp
        2348, // date_ge_timestamp
        2349, // date_gt_timestamp
        2350, // date_ne_timestamp

        2358, // date_lt_timestamptz
        2359, // date_le_timestamptz
        2360, // date_eq_timestamptz
        2361, // date_ge_timestamptz
        2362, // date_gt_timestamptz
        2363, // date_ne_timestamptz

        2371, // timestamp_lt_date
        2372, // timestamp_le_date
        2373, // timestamp_eq_date
        2374, // timestamp_ge_date
        2375, // timestamp_gt_date
        2376, // timestamp_ne_date

        2384, // timestamptz_lt_date
        2385, // timestamptz_le_date
        2386, // timestamptz_eq_date
        2387, // timestamptz_ge_date
        2388, // timestamptz_gt_date
        2389, // timestamptz_ne_date

        2534, // timestamp_lt_timestamptz
        2535, // timestamp_le_timestamptz
        2536, // timestamp_eq_timestamptz
        2537, // timestamp_ge_timestamptz
        2538, // timestamp_gt_timestamptz
        2539, // timestamp_ne_timestamptz

        2540, // timestamptz_lt_timestamp
        2541, // timestamptz_le_timestamp
        2542, // timestamptz_eq_timestamp
        2543, // timestamptz_ge_timestamp
        2544, // timestamptz_gt_timestamp
        2545 // timestamptz_ne_timestamp
    ];

    const explicitCasts: [number, number][] = [
        [1114, 1082], // timestamp -> date
        [1114, 1083] // timestamp -> time
    ];

    const illegalCasts: [number, number][] = [
        [1082, 1114], // date -> timestamp
        [1082, 1184], // date -> timestamptz

        [1114, 1184], // timestamp -> timestamptz

        [1184, 1082], // timestamptz -> date
        [1184, 1083], // timestamptz -> time
        [1184, 1114], // timestamptz -> timestamp
        [1184, 1266] // timestamptz -> timetz
    ];

    await client.unsafe(
        `
        delete from pg_operator
        where oid = any($1)
        `,
        [operatorOids]
    );

    await client.unsafe(
        `
        update pg_cast
        set castcontext = 'e'
        where (castsource, casttarget) in (select * from unnest($1::oid[], $2::oid[]));
        `,
        [explicitCasts.map((c) => c[0]), explicitCasts.map((c) => c[1])]
    );

    await client.unsafe(
        `
        delete from pg_cast
        where (castsource, casttarget) in (select * from unnest($1::oid[], $2::oid[]));
        `,
        [illegalCasts.map((c) => c[0]), illegalCasts.map((c) => c[1])]
    );
}

function formatPgError(error: Error | postgres.PostgresError) {
    const errors: string[] = [];
    const pgError = parsePostgreSqlError(error);

    if (pgError !== null) {
        errors.push(
            "Error connecting to database cluster:",
            pgError.message,
            `code: ${pgError.code}`
        );

        if (pgError.detail !== null && pgError.detail !== pgError.message) {
            errors.push("detail: " + pgError.detail);
        }

        if (pgError.hint !== null) {
            errors.push("hint: " + pgError.hint);
        }

        return new Error(errors.join("\n"));
    }

    if ("code" in error) {
        errors.push("Error connecting to database cluster:", error.message);

        return new Error(errors.join("\n"));
    }

    return error;
}
