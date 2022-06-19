import * as crypto from "crypto";
import * as pg from "pg";

export function connectPg(url: string): Promise<pg.Client> {
    const client = new pg.Client(url);
    return new Promise<pg.Client>((resolve, reject) => {
        client.connect(err => {
            if (<boolean>(<any>err)) {
                reject(err);
                return;
            }
            resolve(client);
        });
    });
}

export function closePg(conn: pg.Client): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        conn.end(err => {
            if (<boolean>(<any>err)) {
                reject(err);
                return;
            }
            resolve();
        });
    });
}

export function escapeIdentifier(str: string) {
    // See:
    // <https://github.com/brianc/node-postgres/blob/60d8df659c5481723abada2344ac14d77377338c/lib/client.js#L401>
    return '"' + str.replace(/"/g, '""') + '"';
}

/**
 * Submits a request to create a prepared statement
 *
 * See:
 * <https://www.postgresql.org/docs/current/libpq-exec.html#LIBPQ-PQPREPARE>
 */
export function pgPrepareQueryCB(client: pg.Client, name: string, text: string, cb: (err: Error | null) => void) {

    const query = new pg.Query({
        name: name,
        text: text
    });

    query.submit = (connection: pg.Connection) => {
        connection.parse({
            name: name,
            text: text,
            types: []
        }, false);

        connection.sync();
    };

    query.on("error", (error) => cb(error));
    query.on("end", () => cb(null));

    client.query(query);
}

export function pgPrepareQuery(client: pg.Client, name: string, text: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        pgPrepareQueryCB(client, name, text, (err) => {
            if (<boolean><any>err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}


/**
 * Patches the connection object so that it won't crash when it receives a
 * `ParameterDescription (B)` message from the backend. (The message will be
 * ignored)
 */
export function pgMonkeyPatchClient(client: pg.Client): void {
    const connection: pg.Connection = (<any>client).connection;

    const origParseMessage = (<any>connection).parseMessage;
    (<any>connection).parseMessage = function (buffer: Buffer) {
        if (this._reader.header === 0x74) { // 't'
            this.offset = 0;
            const length = buffer.length + 4;

            return {
                name: "parameterDescription",
                length: length
            };
        } else {
            return origParseMessage.call(this, buffer);
        }
    };
}

class DescribePrepared extends pg.Query {
    constructor(private name: string, private cb: (res: pg.FieldDef[] | null , err: Error | null) => void) {
      super(<any>{});
    }

    submit = (connection: pg.Connection) => {
      connection.describe({
        type: "S",
        name: this.name
      }, true);

      connection.sync();
    }

    handleError = (err: Error) => {
      this.cb(null, err);
    }

    handleRowDescription = (msg: { fields: pg.FieldDef[] }) => {
      this.cb(msg.fields, null);
    }
  }

export function pgDescribePrepared(client: pg.Client, name: string): Promise<pg.FieldDef[] | null> {
    return new Promise<pg.FieldDef[] | null>((resolve, reject) => {
        client.query(
            new DescribePrepared(name, (res, err) => {
                if (<boolean><any>err) {
                    reject(err);
                } else {
                    resolve(res);
                }
            })
        );
    });
}

export async function pgDescribeQuery(client: pg.Client, text: string): Promise<pg.FieldDef[] | null> {
    // Use the unnamed statement. See:
    // <https://www.postgresql.org/docs/current/libpq-exec.html#LIBPQ-PQPREPARE>
    const stmtName = "";

    await pgPrepareQuery(client, stmtName, text);
    const result = await pgDescribePrepared(client, stmtName);
    return result;
}

/**
 * !!! WARNING !!!
 *
 * Warning this deletes all data in the database!
 *
 * to delete routines, need to run manually:
 * http://www.postgresonline.com/journal/archives/74-How-to-delete-many-functions.html
 */
export async function dropAllTables(client: pg.Client) {
    // http://stackoverflow.com/questions/3327312/drop-all-tables-in-postgresql/36023359#36023359

    await client.query(
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

export async function dropAllSequences(client: pg.Client) {
    await client.query(
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

export async function dropAllFunctions(client: pg.Client) {
    await client.query(
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

export async function dropAllTypes(client: pg.Client) {
    await client.query(
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
export function parsePostgreSqlError(err: any): PostgreSqlError | null {
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

export async function newSavepoint(conn: pg.Client): Promise<Savepoint> {
    const savepointName = await randomSavepointName();

    await conn.query(`SAVEPOINT ${savepointName}`);

    return new Savepoint(savepointName);
}

export async function rollbackToAndReleaseSavepoint(conn: pg.Client, savepoint: Savepoint): Promise<void> {
    await conn.query(`ROLLBACK TO SAVEPOINT ${savepoint.name}; RELEASE SAVEPOINT ${savepoint.name}`);
}
