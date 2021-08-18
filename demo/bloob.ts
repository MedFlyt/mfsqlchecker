import { Req, Opt } from "../lib/mfsqltool";
import { Conn } from "./core";
import { EmployeeId, CarId, CustomerId } from "./types";

export async function bloob() {
    const conn: Conn<number> = null as any;

    const rows = await conn.query<{
        fname: Req<string>,
        lname: Req<string>,
        phonenumber: Opt<string>,
        salary: Req<number>,
        manager_id: Opt<EmployeeId>,
        managername: Req<string>
    }>(conn.sql
        `
        SELECT
            employee.fname,
            employee.lname,
            employee.phonenumber,
            employee.salary,
            employee.manager_id,
            e.fname AS managerName
        FROM employee
        LEFT JOIN employee e ON employee.manager_id = e.id
        WHERE employee.fname = ${"alice"}
        AND employee.salary = ${5}
        `);


    await conn.query<{
        id: Req<CarId>,
        customer_id: Req<CustomerId>,
        employee_id: Req<EmployeeId>,
        model: Req<string>,
        status: Req<string>,
        total_cost: Req<number>
    }
    >(conn.sql
        ` SELECT * FROM car
        `);


    console.log(rows[0].salary);
}
