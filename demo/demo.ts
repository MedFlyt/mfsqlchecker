import * as pg from "pg";
import { defineSqlView, Connection, Req, Opt, migrateDatabase, sqlFrag } from "./lib/mfsqltool";
import { EmployeeId, CarId, CustomerId, DepartmentId } from "./types";

// import { coolView } from "./blah";

export const oneMore = defineSqlView`SELECT 1, 3 as b`;

const employeeName = defineSqlView`SELECT fname AS employee_fname, lname AS lname1 FROM employee WHERE salary > 10`;

const employeeName2 = defineSqlView`SELECT employee_fname AS fname, lname1 AS lname FROM ${employeeName}`;

const badView = defineSqlView`SELECT 'cool' AS num UNION ALL SELECT NULL`;

export async function test() {
    const conn: Connection<EmployeeId | EmployeeId[]> = null as any;

    // const blah: "blah" | null = "blah";

    await conn.query(conn.sql`

    `);

    await conn.query<{
        fname: Req<string>,
        lname: Req<string>
    }>(conn.sql
        `
        SELECT * FROM ${employeeName2}
        `);

    const goodEmployees: EmployeeId[] = [];
    // const goodCars: CarId[] = [];

    const employees = await conn.query<{
        id: Req<EmployeeId>
    }>(conn.sql
        `
        SELECT
            id
        FROM
            employee
        WHERE salary > ${5}
        AND id = ANY(${goodEmployees})
        `);

    const employeeColsFrag = sqlFrag(
        `
        employee.fname,
        employee.lname,
        employee.phonenumber,
        employee.salary,
        employee.manager_id,
        `);

    // const rows = await query<{ name: string, age: number }>(conn, sql
    const rows = await conn.query<{
        fname: Req<string>,
        lname: Req<string>,
        phonenumber: Opt<string>,
        salary: Req<number>,
        manager_id: Opt<EmployeeId>,
        managername: Req<string>,
        badViewNum: Opt<string>
    }>(conn.sql
        `
        SELECT
            ${employeeColsFrag}
            e.fname AS managerName,
            ${badView}.num AS "badViewNum"
        FROM
        employee
        INNER JOIN ${badView} ON employee.fname = ${badView}.num
        LEFT JOIN employee e ON employee.manager_id = e.id
        WHERE employee.fname = ${"alice"}
        AND employee.salary = ${3}
        AND employee.id = ${employees[0].id.val()}
        `);


    await conn.query<{
        id: Req<CarId>,
        customer_id: Req<CustomerId>,
        employee_id: Req<EmployeeId>,
        model: Req<string>,
        status: Req<string>,
        total_cost: Req<number>
    }>(conn.sql
        ` SELECT * FROM car
        `);


    console.log(rows[0].salary);

    // await query(sql
    //     `
    //     SELECT * FROM ${anotherView}
    //     `);
}

function connectPg(url: string): Promise<pg.Client> {
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

function closePg(conn: pg.Client): Promise<void> {
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

async function logger(msg: string): Promise<void> {
    console.log(msg);
}

interface Department {
    id: DepartmentId;
    name: string;
}

export async function main() {
    console.log("Connecting...");
    const client = await connectPg("postgres://test:password@localhost:6432/test1");
    try {
        console.log("Migrating...");
        await migrateDatabase(client, "demo/migrations", logger);
        console.log("Done");

        const id1: DepartmentId = null as any;

        const values: Department[] = [
            { id: id1, name: "dep1" },
            // { id: 2, name: "dep2" },
            // { id: 6, name: "dep6" },
            // { id: id1, name: "hi" }
        ];

        const conn = new Connection(client);
        const ret = await conn.insertMany("department", values, conn.sql`
        ON CONFLICT(name) DO UPDATE SET id = NULL`);

        console.log(ret);
    } finally {
        await closePg(client);
    }
}

main();
