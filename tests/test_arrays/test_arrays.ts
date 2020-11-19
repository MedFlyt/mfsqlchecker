import { Connection, Opt } from "../../lib/mfsqltool";

export async function test_good(conn: Connection<void, unknown>) {
    const rows = await conn.query<{
        ids: Opt<(number | null)[]>
    }>(conn.sql
        `
        SELECT ARRAY_AGG(id ORDER BY id) AS ids
        FROM employee
        `);

    console.log(rows);
}

export async function test_needs_fix(conn: Connection<void, unknown>) {
    const rows = await conn.query<{
        bad: Opt<string>
    }>(conn.sql
        `
        SELECT ARRAY_AGG(id ORDER BY id) AS ids
        FROM employee
        `);

    console.log(rows);
}
