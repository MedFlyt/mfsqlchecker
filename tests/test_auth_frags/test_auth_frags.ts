import { Opt, sqlFragAuth } from "../../lib/mfsqltool";
import { AuthUser, AuthConn, userIdFrag, employeeIdFrag, customerIdFrag, AuthEmployee, AuthCustomer, defineSqlView, AuthNone } from "../common/auth";

const trueFrag = sqlFragAuth<AuthUser>()("TRUE");

export const employeeName = defineSqlView`SELECT fname AS employee_fname, lname AS lname1, id FROM employee WHERE salary > 10`;

export async function testAuthNone(conn: AuthConn<AuthNone>) {
    const rows = await conn.query<{
        n: Opt<number>
    }>(conn.sql
        `
        SELECT 1 AS n
        FROM ${employeeName} employeeName
        WHERE employeeName.employee_fname = 'Smith'
        `);

    console.log(rows);
}

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

export async function testAuthEmployee(conn: AuthConn<AuthEmployee>) {
    const rows = await conn.query<{
        n: Opt<number>
    }>(conn.sql
        `
        SELECT 1 AS n
        FROM ${employeeName} employeeName
        WHERE ${trueFrag}
        AND employeeName.employee_fname = 'Smith'
        AND employeeName.id = ${userIdFrag}
        AND employeeName.id = ${employeeIdFrag}
        `);

    console.log(rows);
}

export async function testAuthCustomer(conn: AuthConn<AuthCustomer>) {
    const rows = await conn.query<{
        n: Opt<number>
    }>(conn.sql
        `
        SELECT 1 AS n
        FROM ${employeeName} employeeName
        WHERE ${trueFrag}
        AND employeeName.employee_fname = 'Smith'
        AND employeeName.id = ${userIdFrag}
        AND employeeName.id = ${customerIdFrag}
        `);

    console.log(rows);
}
