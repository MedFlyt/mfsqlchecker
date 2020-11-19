import { sqlFrag, Connection, Opt, defineSqlViewPrimitive } from "../../lib/mfsqltool";

const trueFrag = sqlFrag("true");

export const employeeName = defineSqlViewPrimitive`SELECT fname AS employee_fname, lname AS lname1 FROM employee WHERE salary > 10`;

export async function test(conn: Connection<void, unknown>) {
    const rows = await conn.query<{
        n: Opt<number>
    }>(conn.sql
        `
        SELECT 1 AS n
        FROM ${employeeName} employeeName
        WHERE ${trueFrag}
        AND employeeName.employee_fname = 'Smith'
        `);

    console.log(rows);
}
