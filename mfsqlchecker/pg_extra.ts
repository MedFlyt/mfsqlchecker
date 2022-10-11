import * as crypto from "crypto";
import * as postgres from "postgres";

export function connectPg(url: string): postgres.Sql {
    return postgres(url, {
        max: 1,
        onnotice: () => {
            /* do nothing */
        }
    });
}

export function closePg(conn: postgres.Sql): Promise<void> {
    return conn.end();
}

export function escapeIdentifier(str: string) {
    // See:
    // <https://github.com/brianc/node-postgres/blob/60d8df659c5481723abada2344ac14d77377338c/lib/client.js#L401>
    return '"' + str.replace(/"/g, '""') + '"';
}

export async function pgDescribeQuery(client: postgres.Sql, text: string): Promise<postgres.ColumnList<string> | null> {
    const result = await client.unsafe(text).describe();
    return result.columns;
}

/**
 * !!! WARNING !!!
 *
 * Warning this deletes all data in the database!
 *
 * to delete routines, need to run manually:
 * http://www.postgresonline.com/journal/archives/74-How-to-delete-many-functions.html
 */
export async function dropAllTables(client: postgres.Sql) {
    // http://stackoverflow.com/questions/3327312/drop-all-tables-in-postgresql/36023359#36023359

    await client.unsafe(
        `
        DO $$ DECLARE
            r RECORD;
        BEGIN
            -- if the schema you operate on is not "current", you will want to
            -- replace current_schema() in query with 'schematodeletetablesfrom'
            -- *and* update the generate 'DROP...' accordingly.
            FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = current_schema()) LOOP
                EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
            END LOOP;
        END $$;
        `);
}

export async function dropAllSequences(client: postgres.Sql) {
    await client.unsafe(
        `
        DO $$ DECLARE
            r RECORD;
        BEGIN
            -- if the schema you operate on is not "current", you will want to
            -- replace current_schema() in query with 'schematodeletetablesfrom'
            -- *and* update the generate 'DROP...' accordingly.
            FOR r IN (SELECT pg_class.relname FROM pg_class, pg_namespace WHERE pg_class.relnamespace = pg_namespace.oid AND pg_namespace.nspname = current_schema() AND pg_class.relkind = 'S') LOOP
                EXECUTE 'DROP SEQUENCE IF EXISTS ' || quote_ident(r.relname) || ' CASCADE';
            END LOOP;
        END $$;
        `);
}

export async function dropAllFunctions(client: postgres.Sql) {
    await client.unsafe(
        `
        DO $$ DECLARE
            r RECORD;
        BEGIN
            -- if the schema you operate on is not "current", you will want to
            -- replace current_schema() in query with 'schematodeletetablesfrom'
            -- *and* update the generate 'DROP...' accordingly.
            FOR r IN (SELECT pg_proc.proname, pg_proc.proargtypes FROM pg_proc, pg_namespace WHERE pg_proc.pronamespace = pg_namespace.oid AND pg_namespace.nspname = current_schema()) LOOP
                EXECUTE 'DROP FUNCTION IF EXISTS ' || quote_ident(r.proname) || '(' || oidvectortypes(r.proargtypes) || ')' || ' CASCADE';
            END LOOP;
        END $$;
        `);
}

export async function dropAllTypes(client: postgres.Sql) {
    await client.unsafe(
        `
        DO $$ DECLARE
            r RECORD;
        BEGIN
            -- if the schema you operate on is not "current", you will want to
            -- replace current_schema() in query with 'schematodeletetablesfrom'
            -- *and* update the generate 'DROP...' accordingly.
            FOR r IN (SELECT pg_type.typname FROM pg_type, pg_namespace WHERE pg_namespace.oid = pg_type.typnamespace AND pg_namespace.nspname = current_schema()) LOOP
                EXECUTE 'DROP TYPE IF EXISTS ' || quote_ident(r.typname) || ' CASCADE';
            END LOOP;
        END $$;
        `);
}

/**
 * Checks if `err` is a PostgreSQL error, and returns the error code.
 *
 * See: <https://www.postgresql.org/docs/9.6/static/errcodes-appendix.html>
 *
 * If `err` is not a PostgreSQL error, then returns `null`
 */
export function getPostgreSqlErrorCode(err: any): string | null {
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

export interface PostgreSqlError {
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
export function parsePostgreSqlError(err: unknown): PostgreSqlError | null {
    if (!(err instanceof postgres.PostgresError)) {
        return null;
    }

    return {
        code: err.code,
        position: parseInt(err.position, 10),
        message: err.message,
        detail: err.detail !== undefined ? err.detail : null,
        hint: err.hint !== undefined ? err.hint : null
    };
}

class Savepoint {
    public constructor(public readonly name: string) { }
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

export async function newSavepoint(conn: postgres.Sql): Promise<Savepoint> {
    const savepointName = await randomSavepointName();

    await conn.unsafe(`SAVEPOINT ${savepointName}`);

    return new Savepoint(savepointName);
}

export async function rollbackToAndReleaseSavepoint(conn: postgres.Sql, savepoint: Savepoint): Promise<void> {
    await conn.unsafe(`ROLLBACK TO SAVEPOINT ${savepoint.name}; RELEASE SAVEPOINT ${savepoint.name}`);
}
