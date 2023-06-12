import { describe, it } from "mocha";
import { ESLintUtils } from "@typescript-eslint/utils";
import path from "path";
import { RuleMessage, RuleOptions, sqlCheckRule } from "./sql-check.rule";

const tsconfigRootDir = path.resolve(__dirname, "../../");
const project = "tsconfig.json";
const filename = path.join(tsconfigRootDir, "src/file.ts");

const ruleTester = new ESLintUtils.RuleTester({
    parser: "@typescript-eslint/parser",
    parserOptions: { project, tsconfigRootDir },
    settings: {}
});

function normalizeIndent(template: TemplateStringsArray) {
    const codeLines = template[0]?.split("\n") ?? [""];
    const leftPadding = codeLines[1]?.match(/\s+/)?.[0] ?? "";
    return codeLines.map((line) => line.slice(leftPadding.length)).join("\n");
}

ESLintUtils.RuleTester.describe = describe;
ESLintUtils.RuleTester.it = it;

const config = {
    base: [
        { configFile: "__tests_utils__/test_mfsqlchecker.json", colors: false, revalidateEachRun: true }
    ]
} satisfies Record<string, RuleOptions>;

function valid(v: ESLintUtils.ValidTestCase<RuleOptions>): ESLintUtils.ValidTestCase<RuleOptions> {
    return {
        filename,
        options: config.base,
        ...v
    };
}

function invalid(
    v: ESLintUtils.InvalidTestCase<RuleMessage, RuleOptions>
): ESLintUtils.InvalidTestCase<RuleMessage, RuleOptions> {
    return {
        filename,
        options: config.base,
        ...v
    };
}

ESLintUtils.RuleTester.describe("check-sql", () => {
    ruleTester.run("base", sqlCheckRule, {
        valid: [
            valid({
                name: "select 1 as x",
                code: normalizeIndent`
                    import { Connection, Req, Opt } from "@mfsqlchecker/client";
                    function run(conn: Connection<void, unknown>) {
                        const result = conn.query<{ x: Opt<number> }>(conn.sql\`SELECT 1 as x\`);
                    }
                `
            }),
            valid({
                name: "arrays",
                code: normalizeIndent`
                    import { Connection, Req, Opt } from "@mfsqlchecker/client";
                    async function run(conn: Connection<void, unknown>) {
                        const rows = await conn.query<{ ids: Opt<(number | null)[]> }>(conn.sql\`
                            SELECT ARRAY_AGG(id ORDER BY id) AS ids
                            FROM employee
                        \`);
                    }
                `
            }),
            valid({
                name: "auth frags",
                code: normalizeIndent`
                    import { sqlFragAuth, Connection, Req, Opt } from "@mfsqlchecker/client";
                    import { AuthUser, AuthConn, userIdFrag, employeeIdFrag, customerIdFrag, AuthEmployee, AuthCustomer, defineSqlView, AuthNone } from "../__tests_utils__/auth";

                    const employeeName = defineSqlView\`
                        SELECT
                            fname AS employee_fname,
                            lname AS lname1,
                            id
                        FROM employee
                        WHERE salary > 10
                    \`;

                    const trueFrag = sqlFragAuth<AuthUser>()("TRUE");

                    async function testAuthNone(conn: AuthConn<AuthNone>) {
                        const rows = await conn.query<{ n: Opt<number> }>(conn.sql\`
                            SELECT 1 AS n
                            FROM \${employeeName} employeeName
                            WHERE employeeName.employee_fname = 'Smith'
                        \`);
                    }

                    async function testAuthUser(conn: AuthConn<AuthUser>) {
                        const rows = await conn.query<{ n: Opt<number> }>(conn.sql\`
                            SELECT 1 AS n
                            FROM \${employeeName} employeeName
                            WHERE \${trueFrag}
                            AND employeeName.employee_fname = 'Smith'
                            AND employeeName.id = \${employeeIdFrag}
                        \`);
                    }

                    async function testAuthEmployee(conn: AuthConn<AuthEmployee>) {
                        const rows = await conn.query<{ n: Opt<number> }>(conn.sql\`
                            SELECT 1 AS n
                            FROM \${employeeName} employeeName
                            WHERE \${trueFrag}
                            AND employeeName.employee_fname = 'Smith'
                            AND employeeName.id = \${userIdFrag}
                            AND employeeName.id = \${employeeIdFrag}
                        \`);
                    }

                    async function testAuthCustomer(conn: AuthConn<AuthCustomer>) {
                        const rows = await conn.query<{ n: Opt<number> }>(conn.sql\`
                            SELECT 1 AS n
                            FROM \${employeeName} employeeName
                            WHERE \${trueFrag}
                            AND employeeName.employee_fname = 'Smith'
                            AND employeeName.id = \${userIdFrag}
                            AND employeeName.id = \${customerIdFrag}
                        \`);
                    }
                `
            }),
            valid({
                name: "auth views",
                code: normalizeIndent`
                    import { sqlFragAuth, Opt } from "@mfsqlchecker/client";
                    import { AuthUser, AuthConn, userIdFrag, defineSqlView } from "../__tests_utils__/auth";

                    const employeeName = defineSqlView\`
                        SELECT
                            fname AS employee_fname,
                            lname AS lname1,
                            id
                        FROM employee
                        WHERE salary > 10
                    \`;

                    const trueFrag = sqlFragAuth<AuthUser>()("TRUE");

                    async function testAuthUser(conn: AuthConn<AuthUser>) {
                        const rows = await conn.query<{ n: Opt<number> }>(conn.sql\`
                            SELECT 1 AS n
                            FROM \${employeeName} employeeName
                            WHERE \${trueFrag}
                            AND employeeName.employee_fname = 'Smith'
                            AND employeeName.id = \${userIdFrag}
                        \`);
                    }
                `
            }),
            valid({
                name: "interface types",
                code: normalizeIndent`
                    import { sqlFragAuth, Req, Opt } from "@mfsqlchecker/client";
                    import { AuthUser, AuthConn, userIdFrag, defineSqlView } from "../__tests_utils__/auth";

                    interface EmployeeGood {
                        id: Req<number>;
                        fname: Req<string>;
                        lname: Req<string>;
                        phonenumber: Opt<string>;
                    }

                    async function test_good(conn: Connection<void, unknown>) {
                        const rows = await conn.query<EmployeeGood>(conn.sql\`
                            SELECT id, fname, lname, phonenumber
                            FROM employee
                        \`);
                    }
                `
            }),
            valid({
                name: "simple",
                code: normalizeIndent`
                    import { Connection, Opt, sqlFrag, defineSqlViewPrimitive } from "@mfsqlchecker/client";
                    
                    const trueFrag = sqlFrag("true");

                    export const employeeName = defineSqlViewPrimitive\`
                        SELECT
                            fname AS employee_fname,
                            lname AS lname1
                        FROM employee WHERE salary > 10
                    \`;

                    async function test(conn: Connection<void, unknown>) {
                        const rows = await conn.query<{ n: Opt<number> }>(conn.sql\`
                            SELECT 1 AS n
                            FROM \${employeeName} employeeName
                            WHERE \${trueFrag}
                            AND employeeName.employee_fname = 'Smith'
                        \`);
                    }
                }
                `
            }),
            valid({
                name: "view fragment",
                code: normalizeIndent`
                    import { sqlFrag } from "@mfsqlchecker/client";
                    import { AuthUser, AuthConn, userIdFrag, defineSqlView } from "../__tests_utils__/auth";
                    
                    const trueFrag = sqlFrag(\`(TRUE AND TRUE AND TRUE AND TRUE AND TRUE)\`);

                    export const employeeName = defineSqlView\`
                        SELECT
                            fname AS employee_fname,
                            lname AS lname1,
                            id AS id
                        FROM
                            employee
                        WHERE
                            salary > 10
                            AND \${trueFrag}
                            AND TRUE
                            AND TRUE
                    \`;
                }
                `
            })
        ],
        invalid: [
            invalid({
                name: "invalid arrays",
                code: normalizeIndent`
                    import { Connection, Req, Opt } from "@mfsqlchecker/client";
                    function run(conn: Connection<void, unknown>) {
                        const rows = await conn.query<{ ids: Opt<(string | null)[]> }>(conn.sql\`
                            SELECT ARRAY_AGG(id ORDER BY id) AS ids
                            FROM employee
                        \`);
                    }
                `,
                output: normalizeIndent`
                    import { Connection, Req, Opt } from "@mfsqlchecker/client";
                    function run(conn: Connection<void, unknown>) {
                        const rows = await conn.query<{
                            ids: Opt<(number | null)[]>
                        }>(conn.sql\`
                            SELECT ARRAY_AGG(id ORDER BY id) AS ids
                            FROM employee
                        \`);
                    }
                `,
                errors: [
                    {
                        messageId: "invalid",
                        data: {
                            value: `
    * Wrong Column Types

 2 | import { Connection, Req, Opt } from "@mfsqlchecker/client";
 3 | function run(conn: Connection<void, unknown>) {
 4 |     const rows = await conn.query<{ ids: Opt<(string | null)[]> }>(conn.sql\`
   |                                  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 5 |         SELECT ARRAY_AGG(id ORDER BY id) AS ids
 6 |         FROM employee

    * Fix it to:
      {
        ids: Opt<(number | null)[]>
      }
`
                        }
                    }
                ]
            }),
            invalid({
                name: "invalid interface types 1",
                code: normalizeIndent`
                    import { Connection, Req, Opt } from "@mfsqlchecker/client";

                    interface EmployeeBad1 {
                        id: Req<number>;
                        fname: Req<string>;
                        phonenumber: Opt<string>;
                    }

                    async function test_needs_fix1(conn: Connection<void, unknown>) {
                        const rows = await conn.query<EmployeeBad1>(conn.sql\`
                            SELECT id, fname, lname, phonenumber
                            FROM employee
                        \`);
                    }
                `,
                output: normalizeIndent`
                    import { Connection, Req, Opt } from "@mfsqlchecker/client";

                    interface EmployeeBad1 {
                        id: Req<number>;
                        fname: Req<string>;
                        phonenumber: Opt<string>;
                    }

                    async function test_needs_fix1(conn: Connection<void, unknown>) {
                        const rows = await conn.query<{
                            id: Req<number>,
                            fname: Req<string>,
                            lname: Req<string>,
                            phonenumber: Opt<string>
                        }>(conn.sql\`
                            SELECT id, fname, lname, phonenumber
                            FROM employee
                        \`);
                    }
                `,
                errors: [
                    {
                        messageId: "invalid",
                        data: {
                            value: `
    * Wrong Column Types

  9 | 
 10 | async function test_needs_fix1(conn: Connection<void, unknown>) {
 11 |     const rows = await conn.query<EmployeeBad1>(conn.sql\`
    |                                  ~~~~~~~~~~~~~~
 12 |         SELECT id, fname, lname, phonenumber
 13 |         FROM employee

    * Fix it to:
      {
        id: Req<number>,
        fname: Req<string>,
        lname: Req<string>,
        phonenumber: Opt<string>
      }
`
                        }
                    }
                ]
            }),
            invalid({
                name: "invalid interface types 2",
                code: normalizeIndent`
                    import { Connection, Req, Opt } from "@mfsqlchecker/client";

                    interface EmployeeBad2 {
                        id: Req<number>;
                        fname: Req<string>;
                        lname: Req<number>;
                        phonenumber: Opt<string>;
                    }

                    async function test_needs_fix2(conn: Connection<void, unknown>) {
                        const rows = await conn.query<EmployeeBad2>(conn.sql\`
                            SELECT id, fname, lname, phonenumber
                            FROM employee
                        \`);
                    }
                `,
                output: normalizeIndent`
                    import { Connection, Req, Opt } from "@mfsqlchecker/client";

                    interface EmployeeBad2 {
                        id: Req<number>;
                        fname: Req<string>;
                        lname: Req<number>;
                        phonenumber: Opt<string>;
                    }

                    async function test_needs_fix2(conn: Connection<void, unknown>) {
                        const rows = await conn.query<{
                            id: Req<number>,
                            fname: Req<string>,
                            lname: Req<string>,
                            phonenumber: Opt<string>
                        }>(conn.sql\`
                            SELECT id, fname, lname, phonenumber
                            FROM employee
                        \`);
                    }
                `,
                errors: [
                    {
                        messageId: "invalid",
                        data: {
                            value: `
    * Wrong Column Types

 10 | 
 11 | async function test_needs_fix2(conn: Connection<void, unknown>) {
 12 |     const rows = await conn.query<EmployeeBad2>(conn.sql\`
    |                                  ~~~~~~~~~~~~~~
 13 |         SELECT id, fname, lname, phonenumber
 14 |         FROM employee

    * Fix it to:
      {
        id: Req<number>,
        fname: Req<string>,
        lname: Req<string>,
        phonenumber: Opt<string>
      }
`
                        }
                    }
                ]
            })
        ]
    });
});
