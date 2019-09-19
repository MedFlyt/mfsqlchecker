import { assertNever } from "assert-never";
import chalk from "chalk";
import { Bar, Presets } from "cli-progress";
import * as fs from "fs";
import * as path from "path";
import * as pg from "pg";
import { equalsUniqueTableColumnTypes, makeUniqueColumnTypes, sqlUniqueTypeName, UniqueTableColumnType } from "./ConfigFile";
import { Either } from "./either";
import { ErrorDiagnostic, postgresqlErrorDiagnostic, SrcSpan, toSrcSpan } from "./ErrorDiagnostic";
import { closePg, connectPg, dropAllFunctions, dropAllSequences, dropAllTables, dropAllTypes, parsePostgreSqlError, pgDescribeQuery, pgMonkeyPatchClient, PostgreSqlError } from "./pg_extra";
import { calcDbMigrationsHash, connReplaceDbName, createBlankDatabase, dropDatabase, isMigrationFile, readdirAsync, testDatabaseName } from "./pg_test_db";
import { ColNullability, ResolvedQuery, SqlType, TypeScriptType } from "./queries";
import { resolveFromSourceMap } from "./source_maps";
import { QualifiedSqlViewName, SqlCreateView } from "./views";

export interface Manifest {
    viewLibrary: SqlCreateView[];
    queries: Either<ErrorDiagnostic[], ResolvedQuery>[];
    uniqueTableColumnTypes: UniqueTableColumnType[];
}

export type QueryCheckResult = QueryCheckResult.InvalidText;

namespace QueryCheckResult {
    export interface InvalidText {
        type: "InvalidText";
        error: PostgreSqlError;
    }

    export interface DuplicateResultColumnNames {
        type: "DuplicateResultColumnNames";
        duplicateResultColumnNames: string[];
    }
}

export class DbConnector {
    private constructor(migrationsDir: string, client: pg.Client) {
        this.migrationsDir = migrationsDir;
        this.client = client;
        pgMonkeyPatchClient(this.client);
    }

    static async Connect(migrationsDir: string, adminUrl: string, name?: string): Promise<DbConnector> {
        const client = await newConnect(adminUrl, name);
        return new DbConnector(migrationsDir, client);
    }

    async close(): Promise<void> {
        await closePg(this.client);
    }

    private migrationsDir: string;
    private prevUniqueTableColumnTypes: UniqueTableColumnType[] = [];
    private client: pg.Client;

    private viewNames: [string, ViewAnswer][] = [];

    private dbMigrationsHash: string = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

    private tableColsLibrary = new TableColsLibrary();
    private pgTypes = new Map<number, SqlType>();
    private uniqueColumnTypes = new Map<SqlType, TypeScriptType>();

    private queryCache = new QueryMap<QueryAnswer>();

    async validateManifest(manifest: Manifest): Promise<ErrorDiagnostic[]> {
        const hash = await calcDbMigrationsHash(this.migrationsDir);
        if (this.dbMigrationsHash !== hash || !equalsUniqueTableColumnTypes(manifest.uniqueTableColumnTypes, this.prevUniqueTableColumnTypes)) {
            this.dbMigrationsHash = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
            this.queryCache.clear();
            for (let i = this.viewNames.length - 1; i >= 0; --i) {
                const viewName = this.viewNames[i];
                await dropView(this.client, viewName[0]);
            }
            this.viewNames = [];

            await dropAllTables(this.client);
            await dropAllSequences(this.client);
            await dropAllTypes(this.client);
            await dropAllFunctions(this.client);

            const allFiles = await readdirAsync(this.migrationsDir);
            const matchingFiles = allFiles.filter(isMigrationFile).sort();
            for (const matchingFile of matchingFiles) {
                console.log("Migration file", matchingFile);
                const text = await readFileAsync(path.join(this.migrationsDir, matchingFile));
                try {
                    await this.client.query(text);
                } catch (err) {
                    const perr = parsePostgreSqlError(err);
                    if (perr === null) {
                        throw err;
                    } else {
                        const errorDiagnostic = postgresqlErrorDiagnostic(path.join(this.migrationsDir, matchingFile), text, perr, toSrcSpan(text, perr.position), "Error in migration file");
                        return [errorDiagnostic];
                    }
                }
            }

            this.prevUniqueTableColumnTypes = manifest.uniqueTableColumnTypes;

            this.uniqueColumnTypes = makeUniqueColumnTypes(this.prevUniqueTableColumnTypes);
            await applyUniqueTableColumnTypes(this.client, this.prevUniqueTableColumnTypes);

            await this.tableColsLibrary.refreshTables(this.client);

            this.pgTypes = new Map<number, SqlType>();
            const pgTypesResult = await this.client.query(
                `
                SELECT
                    oid,
                    typname
                FROM pg_type
                ORDER BY oid
                `);
            for (const row of pgTypesResult.rows) {
                const oid: number = row["oid"];
                const typname: string = row["typname"];
                this.pgTypes.set(oid, SqlType.wrap(typname));
            }
            this.dbMigrationsHash = hash;
        }

        let queryErrors: ErrorDiagnostic[] = [];

        const [updated, newViewNames] = await updateViews(this.client, this.viewNames, manifest.viewLibrary);

        if (updated) {
            await this.tableColsLibrary.refreshViews(this.client);
        }

        this.viewNames = newViewNames;

        for (const [viewName, viewAnswer] of this.viewNames) {
            const createView = manifest.viewLibrary.find(x => x.viewName === viewName);
            if (createView === undefined) {
                throw new Error("The Impossible Happened");
            }
            queryErrors = queryErrors.concat(viewAnswerToErrorDiagnostics(createView, viewAnswer));
        }


        const newQueryCache = new QueryMap<QueryAnswer>();

        const queriesProgressBar = new Bar({
            clearOnComplete: true,
            etaBuffer: 50
        }, Presets.legacy);
        queriesProgressBar.start(manifest.queries.length, 0);
        try {
            let i = 0;
            for (const query of manifest.queries) {
                switch (query.type) {
                    case "Left":
                        break;
                    case "Right":
                        const cachedResult = this.queryCache.get(query.value.text, query.value.colTypes);
                        if (cachedResult !== undefined) {
                            queryErrors = queryErrors.concat(queryAnswerToErrorDiagnostics(query.value, cachedResult));
                            newQueryCache.set(query.value.text, query.value.colTypes, cachedResult);
                        } else {
                            const result = await processQuery(this.client, this.pgTypes, this.tableColsLibrary, this.uniqueColumnTypes, query.value);
                            newQueryCache.set(query.value.text, query.value.colTypes, result);
                            queryErrors = queryErrors.concat(queryAnswerToErrorDiagnostics(query.value, result));
                        }
                        break;
                    default:
                        assertNever(query);
                }
                queriesProgressBar.update(++i);
            }
        } finally {
            queriesProgressBar.stop();
        }

        this.queryCache = newQueryCache;

        let finalErrors: ErrorDiagnostic[] = [];
        for (const query of manifest.queries) {
            switch (query.type) {
                case "Left":
                    finalErrors = finalErrors.concat(query.value);
                    break;
                case "Right":
                    finalErrors = finalErrors.concat(query.value.errors);
                    break;
                default:
                    assertNever(query);
            }
        }
        return finalErrors.concat(queryErrors);
    }
}

async function dropView(client: pg.Client, viewName: string): Promise<void> {
    await client.query(`DROP VIEW IF EXISTS "${viewName}"`);
}

/**
 * @returns Array with the same length as `newViews`, with a matching element
 * for each view in `newViews`
 */
async function updateViews(client: pg.Client, oldViews: [string, ViewAnswer][], newViews: SqlCreateView[]): Promise<[boolean, [string, ViewAnswer][]]> {
    let updated: boolean = false;

    const newViewNames = new Set<string>();
    newViews.forEach(v => newViewNames.add(v.viewName));

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
            const answer = await processCreateView(client, view);
            result.push([view.viewName, answer]);
            updated = true;
        }
    }

    return [updated, result];
}

async function processCreateView(client: pg.Client, view: SqlCreateView): Promise<ViewAnswer> {
    try {
        await client.query(`CREATE OR REPLACE VIEW "${view.viewName}" AS ${view.createQuery}`);
    } catch (err) {
        const perr = parsePostgreSqlError(err);
        if (perr === null) {
            throw err;
        } else {
            if (perr.position !== null) {
                // A bit hacky but does the trick:
                perr.position -= `CREATE OR REPLACE VIEW "${view.viewName}" AS `.length;
            }
            return {
                type: "CreateError",
                viewName: QualifiedSqlViewName.viewName(view.qualifiedViewname),
                perr: perr
            };
        }
    }

    return {
        type: "NoErrors"
    };
}

type ViewAnswer =
    ViewAnswer.NoErrors |
    ViewAnswer.CreateError;

namespace ViewAnswer {
    export interface NoErrors {
        type: "NoErrors";
    }

    export interface CreateError {
        type: "CreateError";
        viewName: string;
        perr: PostgreSqlError;
    }
}

function viewAnswerToErrorDiagnostics(createView: SqlCreateView, viewAnswer: ViewAnswer): ErrorDiagnostic[] {
    switch (viewAnswer.type) {
        case "NoErrors":
            return [];
        case "CreateError":
            const message = "Error in view \"" + chalk.bold(viewAnswer.viewName) + "\"";
            if (viewAnswer.perr.position !== null) {
                const p = resolveFromSourceMap(viewAnswer.perr.position, createView.sourceMap);
                return [postgresqlErrorDiagnostic(createView.fileName, createView.fileContents, viewAnswer.perr, toSrcSpan(createView.fileContents, p), message)];
            } else {
                return [postgresqlErrorDiagnostic(createView.fileName, createView.fileContents, viewAnswer.perr, querySourceStart(createView.fileContents, createView.sourceMap), message)];
            }
        default:
            return assertNever(viewAnswer);
    }
}

/**
 * Type safe "Map"-like from queries to some T
 */
class QueryMap<T> {
    set(text: string, colTypes: Map<string, [ColNullability, TypeScriptType]> | null, value: T): void {
        this.internalMap.set(QueryMap.toKey(text, colTypes), value);
    }

    get(text: string, colTypes: Map<string, [ColNullability, TypeScriptType]> | null): T | undefined {
        return this.internalMap.get(QueryMap.toKey(text, colTypes));
    }

    clear(): void {
        this.internalMap = new Map<string, T>();
    }

    private static toKey(text: string, colTypes: Map<string, [ColNullability, TypeScriptType]> | null): string {
        // TODO Will this really always give a properly unique key?
        return text + (colTypes === null ? "" : stringifyColTypes(colTypes));
    }

    private internalMap = new Map<string, T>();
}

type QueryAnswer =
    QueryAnswer.NoErrors |
    QueryAnswer.DescribeError |
    QueryAnswer.DuplicateColNamesError |
    QueryAnswer.WrongColumnTypes;

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
}

function querySourceStart(fileContents: string, sourceMap: [number, number][]): SrcSpan {
    return toSrcSpan(fileContents, fileContents.slice(sourceMap[0][1] + 1).search(/\S/) + sourceMap[0][1] + 2);
}

function queryAnswerToErrorDiagnostics(query: ResolvedQuery, queryAnswer: QueryAnswer): ErrorDiagnostic[] {
    switch (queryAnswer.type) {
        case "NoErrors":
            return [];
        case "DescribeError":
            if (queryAnswer.perr.position !== null) {
                const p = resolveFromSourceMap(queryAnswer.perr.position, query.sourceMap);
                return [postgresqlErrorDiagnostic(query.fileName, query.fileContents, queryAnswer.perr, toSrcSpan(query.fileContents, p), null)];
            } else {
                return [postgresqlErrorDiagnostic(query.fileName, query.fileContents, queryAnswer.perr, querySourceStart(query.fileContents, query.sourceMap), null)];
            }
        case "DuplicateColNamesError":
            return [{
                fileName: query.fileName,
                fileContents: query.fileContents,
                span: querySourceStart(query.fileContents, query.sourceMap),
                messages: [`Query return row contains duplicate column names:\n${JSON.stringify(queryAnswer.duplicateResultColumns, null, 2)}`],
                epilogue: chalk.bold("hint") + ": Specify a different name for the column using the Sql \"AS\" keyword",
                quickFix: null
            }];
        case "WrongColumnTypes":
            let replacementText: string;
            switch (query.colTypeSpan.type) {
                case "File":
                    throw new Error("The Impossible Happened");
                case "LineAndCol":
                    // This is a bit of a hack. We are assuming that if the
                    // SrcSpan is a single character, then the type argument is
                    // completely missing
                    replacementText = "<" + queryAnswer.renderedColTypes + ">";
                    break;
                case "LineAndColRange":
                    replacementText = queryAnswer.renderedColTypes;
                    break;
                default:
                    return assertNever(query.colTypeSpan);
            }

            return [{
                fileName: query.fileName,
                fileContents: query.fileContents,
                span: query.colTypeSpan,
                messages: ["Wrong Column Types"],
                epilogue: chalk.bold("Fix it to:") + "\n" + queryAnswer.renderedColTypes,
                quickFix: {
                    name: "Fix Column Types",
                    replacementText: replacementText
                }
            }];
        default:
            return assertNever(queryAnswer);
    }
}

async function processQuery(client: pg.Client, pgTypes: Map<number, SqlType>, tableColsLibrary: TableColsLibrary, uniqueColumnTypes: Map<SqlType, TypeScriptType>, query: ResolvedQuery): Promise<QueryAnswer> {
    let fields: pg.FieldDef[] | null;
    try {
        fields = await pgDescribeQuery(client, query.text);
    } catch (err) {
        const perr = parsePostgreSqlError(err);
        if (perr === null) {
            throw err;
        } else {
            return {
                type: "DescribeError",
                perr: perr
            };
        }
    }

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
            if (fields.slice(i + 1).findIndex(f => f.name === field.name) >= 0 && duplicateResultColumns.indexOf(field.name) < 0) {
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
        if (query.colTypes !== null && stringifyColTypes(query.colTypes) !== stringifyColTypes(sqlFields)) {
            return {
                type: "WrongColumnTypes",
                renderedColTypes: renderColTypesType(sqlFields)
            };
        }
    }

    return {
        type: "NoErrors"
    };
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
    public async refreshTables(client: pg.Client): Promise<void> {
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

        const queryResult = await client.query(
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
            `);

        for (const row of queryResult.rows) {
            const attrelid: number = row["attrelid"];
            const attnum: number = row["attnum"];
            const attnotnull: boolean = row["attnotnull"];

            this.tableLookupTable.set(`${attrelid}-${attnum}`, attnotnull);
        }
    }

    public async refreshViews(client: pg.Client): Promise<void> {
        this.viewLookupTable = new Map<string, boolean>();

        // This query was taken from here and (slightly) adapted:
        // <https://github.com/PostgREST/postgrest/blob/e83144ce7fc239b3161f53f17ecaf80fbb9e19f8/src/PostgREST/DbStructure.hs#L725>
        const queryResult = await client.query(
            `
            with views as (
                select
                  n.nspname   as view_schema,
                  c.oid       as view_oid,
                  c.relname   as view_name,
                  r.ev_action as view_definition
                from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
                join pg_rewrite r on r.ev_class = c.oid
                where (c.relkind in ('v', 'm')) and n.nspname = 'public'
              ),
              removed_subselects as(
                select
                  view_schema, view_name, view_oid,
                  regexp_replace(view_definition, '{subselectRegex}', '', 'g') as x
                from views
              ),
              target_lists as(
                select
                  view_schema, view_name, view_oid,
                  regexp_split_to_array(x, 'targetList') as x
                from removed_subselects
              ),
              last_target_list_wo_tail as(
                select
                  view_schema, view_name, view_oid,
                  (regexp_split_to_array(x[array_upper(x, 1)], ':onConflict'))[1] as x
                from target_lists
              ),
              target_entries as(
                select
                  view_schema, view_name, view_oid,
                  unnest(regexp_split_to_array(x, 'TARGETENTRY')) as entry
                from last_target_list_wo_tail
              ),
              results as(
                select
                  view_schema, view_name, view_oid,
                  substring(entry from ':resname (.*?) :') as view_colum_name,
                  substring(entry from ':resorigtbl (.*?) :') as resorigtbl,
                  substring(entry from ':resorigcol (.*?) :') as resorigcol
                from target_entries
              )
              select
                -- sch.nspname as table_schema,
                -- tbl.relname as table_name,
                tbl.oid     as table_oid,
                -- col.attname as table_column_name,
                col.attnum  as table_column_num,
                -- res.view_schema,
                -- res.view_name,
                res.view_oid,
                -- res.view_colum_name,
                vcol.attnum as view_colum_num
              from results res
              join pg_class tbl on tbl.oid::text = res.resorigtbl
              join pg_attribute col on col.attrelid = tbl.oid and col.attnum::text = res.resorigcol
              -- join pg_namespace sch on sch.oid = tbl.relnamespace
              join pg_attribute vcol on vcol.attrelid = res.view_oid and vcol.attname::text = res.view_colum_name
              where resorigtbl <> '0'
              order by view_oid;
            `);

        for (const row of queryResult.rows) {
            const viewOid: number = row["view_oid"];
            const viewColumNum: number = row["view_colum_num"];
            const tableOid: number = row["table_oid"];
            const tableColumnNum: number = row["table_column_num"];


            const isNotNull = this.isNotNull(tableOid, tableColumnNum);
            this.viewLookupTable.set(`${viewOid}-${viewColumNum}`, isNotNull);
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

export function resolveFieldDefs(tableColsLibrary: TableColsLibrary, pgTypes: Map<number, SqlType>, uniqueColumnTypes: Map<SqlType, TypeScriptType>, fields: pg.FieldDef[]): Map<string, [ColNullability, TypeScriptType]> {
    const result = new Map<string, [ColNullability, TypeScriptType]>();

    for (const field of fields) {
        const sqlType = psqlOidSqlType(pgTypes, field.dataTypeID);
        let colNullability: ColNullability = ColNullability.OPT;
        if (field.tableID > 0) {
            const notNull = tableColsLibrary.isNotNull(field.tableID, field.columnID);
            if (notNull) {
                colNullability = ColNullability.REQ;
            }
        }
        const typeScriptType = sqlTypeToTypeScriptType(uniqueColumnTypes, sqlType);
        result.set(field.name, [colNullability, typeScriptType]);
    }

    return result;
}

function sqlTypeToTypeScriptType(uniqueColumnTypes: Map<SqlType, TypeScriptType>, sqlType: SqlType): TypeScriptType {
    switch (SqlType.unwrap(sqlType)) {
        case "int2":
        case "int4":
        case "int8":
            return TypeScriptType.wrap("number");
        case "text":
            return TypeScriptType.wrap("string");
        case "bool":
            return TypeScriptType.wrap("boolean");

        // TODO Temporary
        case "jsonb":
            return TypeScriptType.wrap("DbJson");
        case "timestamp":
            return TypeScriptType.wrap("LocalDateTime");
        case "timestamptz":
            return TypeScriptType.wrap("Instant");
        case "date":
            return TypeScriptType.wrap("LocalDate");

        default:
    }

    const uniqueType = uniqueColumnTypes.get(sqlType);

    if (uniqueType !== undefined) {
        return uniqueType;
    }

    throw new Error(`TODO sqlTypeToTypeScriptType ${sqlType}`);
}

function colNullabilityStr(colNullability: ColNullability): string {
    switch (colNullability) {
        case ColNullability.REQ:
            return "Req";
        case ColNullability.OPT:
            return "Opt";
        default:
            return assertNever(colNullability);
    }
}

function renderIdentifier(ident: string): string {
    // TODO wrap key in double quotes if not a valid JavaScript identifier

    return ident;
}

function renderColTypesType(colTypes: Map<string, [ColNullability, TypeScriptType]>): string {
    if (colTypes.size === 0) {
        return "{}";
    }

    let result = "{\n";

    colTypes.forEach((value, key) => {

        result += `  ${renderIdentifier(key)}: ${colNullabilityStr(value[0])}<${TypeScriptType.unwrap(value[1])}>,\n`;
    });

    // Remove trailing comma
    result = result.substr(0, result.length - 2);

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

async function newConnect(adminUrl: string, name?: string): Promise<pg.Client> {
    const newDbName = name !== undefined
        ? name
        : await testDatabaseName();

    const adminConn1 = await connectPg(adminUrl);
    try {
        if (name !== undefined) {
            await dropDatabase(adminConn1, name);
        }

        await createBlankDatabase(adminConn1, newDbName);
    } finally {
        await closePg(adminConn1);
    }

    const client = await connectPg(connReplaceDbName(adminUrl, newDbName));
    return client;
}

function readFileAsync(fileName: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        fs.readFile(fileName, { encoding: "utf-8" }, (err, data) => {
            if (<boolean><any>err) {
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

async function queryTableColumn(client: pg.Client, tableName: string, columnName: string): Promise<TableColumn | null> {
    const result = await client.query(
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
        `, [tableName, columnName]);

    if (result.rows.length === 0) {
        return null;
    } else if (result.rows.length > 1) {
        throw new Error(`Multiple pg_attribute results found for Table "${tableName}" Column "${columnName}"`);
    }

    return {
        tableOid: result.rows[0].tbloid,
        colAttnum: result.rows[0].attnum,
        typeName: result.rows[0].typname
    };
}

async function dropTableConstraints(client: pg.Client) {
    const queryResult = await client.query(
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
        AND pg_constraint.contype = 'c';
        `);

    for (const row of queryResult.rows) {
        const relname: string = row["relname"];
        const conname: string = row["conname"];

        await client.query(
            `
            ALTER TABLE "${relname}" DROP CONSTRAINT IF EXISTS "${conname}" CASCADE
            `);
    }
}

export async function applyUniqueTableColumnTypes(client: pg.Client, uniqueTableColumnTypes: UniqueTableColumnType[]): Promise<void> {
    // We need to drop all table constraints before converting the id columns.
    // This is because some constraints might refer to these table columns and
    // they might not like it if the column type changes.
    //
    // Remember that for our purposes constraints serve no purpose because we
    // never actually insert or update any data in the database.
    await dropTableConstraints(client);

    for (const uniqueTableColumnType of uniqueTableColumnTypes) {
        const tableColumn = await queryTableColumn(client, uniqueTableColumnType.tableName, uniqueTableColumnType.columnName);

        if (tableColumn !== null) {

            const queryResult = await client.query(
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
                `, [uniqueTableColumnType.tableName, uniqueTableColumnType.columnName]);

            for (const row of queryResult.rows) {
                const conname: string = row["conname"];
                const relname: string = row["relname"];

                await client.query(
                    `
                    ALTER TABLE "${relname}" DROP CONSTRAINT "${conname}"
                    `);
            }

            const typeName = sqlUniqueTypeName(uniqueTableColumnType.tableName, uniqueTableColumnType.columnName);

            await client.query(
                `
                CREATE TYPE "${typeName}" AS RANGE (SUBTYPE = "${tableColumn.typeName}")
                `);

            const colName = uniqueTableColumnType.columnName;

            await client.query(
                `
                ALTER TABLE "${uniqueTableColumnType.tableName}"
                    ALTER COLUMN "${colName}" DROP DEFAULT,
                    ALTER COLUMN "${colName}" SET DATA TYPE "${typeName}" USING CASE WHEN "${colName}" IS NULL THEN NULL ELSE "${typeName}"("${colName}", "${colName}", '[]') END
                `);

            for (const row of queryResult.rows) {
                const relname: string = row["relname"];
                const attname: string = row["attname"];

                await client.query(
                    `
                    ALTER TABLE "${relname}"
                        ALTER COLUMN "${attname}" DROP DEFAULT,
                        ALTER COLUMN "${attname}" SET DATA TYPE "${typeName}" USING CASE WHEN "${attname}" IS NULL THEN NULL ELSE "${typeName}"("${attname}", "${attname}", '[]') END
                    `);
            }
        }
    }
}
