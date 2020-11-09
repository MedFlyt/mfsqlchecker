import { Opt, sqlFragAuth } from "../../lib/mfsqltool";
import { AuthUser, AuthConn, userIdFrag, defineSqlView } from "../common/auth";

const trueFrag = sqlFragAuth<AuthUser>()("TRUE");

export const employeeName = defineSqlView`SELECT fname AS employee_fname, lname AS lname1, id AS id FROM employee WHERE salary > 10 AND ${trueFrag}`;

export async function testAuthUser(conn: AuthConn<AuthUser>) {
    const rows = await conn.query<{
        n: Opt<number>
    }>(conn.sql
        `
        SELECT 1 AS n
        FROM ${employeeName} employeeName
        WHERE ${trueFrag}
        AND employeeName.employee_fname = 'Smith'
        AND employeeName.id = ${userIdFrag}
        `);

    console.log(rows);
}
