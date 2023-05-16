import { LocalDate } from "@js-joda/core";
import { Req, Opt } from "../lib/mfsqltool";
import { Conn, defineSqlView } from "./core";
import { DepartmentId, EmployeeId } from "./types";

interface Employee {
    name: string;
    departmentName: string;
    phoneNumber: string | null;
    salary: number;
}

const myView = defineSqlView`SELECT fname, phonenumber FROM employee`;

async function main() {
    const conn: Conn<{}> = null as any;

    const rows = await conn.query<{
        fname: Req<string>;
        phonenumber: Opt<string>;
    }>(conn.sql`SELECT * from ${myView}`);

    const name = rows[0].fname.val();
    const phone = rows[0].phonenumber.valOpt();
    console.log(name, phone);
}

export async function insertEmployee(employee: Employee): Promise<void> {
    const conn: Conn<{}> = null as any;

    await conn.insert<{
        id: Req<EmployeeId>;
        fname: Req<string>;
        lname: Req<string>;
        phonenumber: Opt<string>;
        manager_id: Opt<EmployeeId>;
        department_id: Req<DepartmentId>;
        salary: Req<number>;
        hiredate: Req<LocalDate>;
    }>(
        "employee",
        {
            department_id: DepartmentId.wrap(1),
            fname: employee.name,
            lname: "Smith",
            hiredate: LocalDate.now(),
            salary: employee.salary,
            phonenumber: employee.phoneNumber,
            manager_id: null
        },
        conn.sql`RETURNING *`
    );
}

main();
