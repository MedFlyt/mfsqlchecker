import { Connection, Opt, defineSqlView, Req } from "./lib/mfsqltool";

const myView = defineSqlView`SELECT fname, phonenumber FROM employee`;

async function main() {
    const conn: Connection<{}> = null as any;

    const rows = await conn.query<{
        fname: Req<string>,
        phonenumber: Opt<string>
    }
    >(conn.sql`SELECT * from ${myView}`);

    const name = rows[0].fname.val();
    const phone = rows[0].phonenumber.valOpt();
    console.log(name, phone);
}

main();
