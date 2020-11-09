import { sqlFrag } from "../../lib/mfsqltool";
import { defineSqlView } from "../common/auth";

const trueFrag = sqlFrag(`(TRUE AND TRUE AND TRUE AND TRUE AND TRUE)`);

export const employeeName = defineSqlView`
    SELECT
        fname AS employee_fname,
        lname AS lname1,
        id AS id
    FROM
        employee
    WHERE
        salary > 10
        AND ${trueFrag}
        AND TRUE
        AND TRUE
`;
