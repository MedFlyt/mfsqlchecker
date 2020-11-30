import { Connection, Opt, Req } from "../../lib/mfsqltool";

export interface EmployeeGood {
    id: Req<number>;
    fname: Req<string>;
    lname: Req<string>;
    phonenumber: Opt<string>;
}

export interface EmployeeBad1 {
    id: Req<number>;
    fname: Req<string>;
    phonenumber: Opt<string>;
}

export interface EmployeeBad2 {
    id: Req<number>;
    fname: Req<string>;
    lname: Req<number>;
    phonenumber: Opt<string>;
}

export async function test_good(conn: Connection<void, unknown>) {
    const rows = await conn.query<EmployeeGood>(conn.sql
        `
        SELECT id, fname, lname, phonenumber
        FROM employee
        `);

    console.log(rows);
}

export async function test_needs_fix1(conn: Connection<void, unknown>) {
    const rows = await conn.query<EmployeeBad1>(conn.sql
        `
        SELECT id, fname, lname, phonenumber
        FROM employee
        `);

    console.log(rows);
}

export async function test_needs_fix2(conn: Connection<void, unknown>) {
    const rows = await conn.query<EmployeeBad2>(conn.sql
        `
        SELECT id, fname, lname, phonenumber
        FROM employee
        `);

    console.log(rows);
}
