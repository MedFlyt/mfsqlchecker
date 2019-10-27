# mfsqlchecker

Statically validate correctness of all your SQL queries. TypeScript,
PostgreSQL

![Example Animation](employees_demo.gif)

## Similar projects

- [postgresql-typed](http://hackage.haskell.org/package/postgresql-typed)
- [FSharp.Data.SqlClient](https://github.com/fsprojects/FSharp.Data.SqlClient)

## What is mfsqlchecker

mfsqlchecker is a thin layer on top of
[node-postgres](https://github.com/brianc/node-postgres). You continue to
write queries using regular SQL to interact with your PostgreSQL database, but
mfsqlchecker automatically verifies that all your queries are correct, and
that the result columns are of the expected type. This verification step is
performed at compile time, so that you can have a high level of confidence
that there will be no errors during production.

## Motivation and Benefits

For small projects that only have a few dozen queries, using
[node-postgres](https://github.com/brianc/node-postgres) directly works fine.

But for large projects containing hundreds of SQL queries, things start to
break down to due the lack of **compile-time checking**, and un-ergonomic
**composability**

mfsqlchecker helps address these issues:

### Compile-Time Static Checking of Queries

The first benefit that you get from the static checking provided by
mfsqlchecker is rapid feedback during development. Your queries are checked
while you are writing them in your editor. Syntax errors will be immediately
detected, as well as typos in table names or column names, invalid type
comparisons, and any other SQL error.

Additionally, mfsqlchecker will verify that the column types returned by your
query match the TypeScript types in your code. mfsqlchecker will actually
automatically infer the returned column types for each query, and can generate
a corresponding TypeScript shim directly inline with the query.

For example: if your SQL query returns a result from a `TEXT` column in your
database, but you try to assign the result to a TypeScript variable of type
`number`, then you will get a compile-time error.

The TypeScript/PostgreSQL type-checking also works in the other direction:
mfsqlchecker validates that the types of the TypeScript parameters are valid
based on their usage in the SQL query.

This rapid-feedback speeds up development, but more importantly, the
static-checking system allows much more fluid refactoring of your code and of
your database schema.

Example: You have a *person* table with a *first_name* column and a
*last_name* column. You want to combine them into a single *name* column. With
mfsqlchecker, simply write a migration to perform the change. Then, the tool
will notify you of all of the SQL queries in your project that now fail
because they reference *first_name* or *last_name*. After you correct them and
have no more errors, you can be confident that your refactoring is succesfully
complete. This technique scales nicely to more complex refactorings (such as
extracting a one-to-one foreign key to a new many-to-many junction table,
etc...)

This ease-of-refactoring is familiar to proponents of statically-typed
languages, and mfsqlchecker's static checker offers the same benefits.

#### Example Query

```TypeScript
interface Employee {
    name: string;
    departmentName: string;
    phoneNumber: string | null;
    salary: number;
}

export async function getEmployeesWithMinSalary(conn: Connection, minSalary: number): Promise<Employee[]> {
    const rows = await conn.query<{
        name: Req<string>,             // /---------------------------\
        department_name: Req<string>,  // |  This code block is       |
        phonenumber: Opt<string>,      // |  generated automatically  |
        salary: Req<number>            // \---------------------------/
    }>(conn.sql
        `
        SELECT
            employee.name,
            department.name AS department_name,
            phonenumber,
            salary
        FROM employee
        JOIN department ON employee.department_id = department.id
        WHERE salary >= ${minSalary}
        `);

    return rows.map<Employee>(row => ({
        name: row.name.val(),
        departmentName: row.department_name.val(),
        phoneNumber: row.phonenumber.valOpt(),
        salary: row.salary.val()
    }));
}
```

When you run the mfsqlchecker tool, all of the following will be validated:

- The SQL query itself is valid: Contains no syntax errors, all referenced
  tables and columns exist, there are no SQL type errors, etc...
- The `minSalary` parameter is allowed to be compared with the `"salary"`
  column (In this case everything is good: `minSalary` is a TypeScript
  "number", the `"salary"` column is a PostgreSQL `INT`, and so the comparison
  is valid).
- The return columns of the query match the names, type, and "nullability"
  listed. Note that mfsqlchecker can automatically generate this stub code.
  You should never manually write it. After editing your query, use the
  mfsqlchecker "Quick Fix" to automatically update the return columns type.
  (See the above animation for an example)
- Each returned column can either be `Req` (Required) or `Opt` (Optional)
- `Req` means that the column always returns a non-null value. This is
  determined automatically by examining the originating table where the column
  comes from, and checking if it is declared `NOT NULL`.
- `Opt` means that the column may contain a `null` value. This can happen when
  the originating table column may be null, or if the column is a result of
  some SQL expression. If you are sure that the column does not contain null
  (for example, if it is the concatenation of two non-null text columns), then
  you can access it using the `forceNotNull()` method (instead of `valOpt()`)

### Composability

Composability means that when we have 2 queries that are similar, we don't
want ...


### Security

Even with an experienced team and strict dicipline, it is still

Since all queries are guaranteed to ..., therefore SQL injection
vulnerabilities are impossible

### Performance

Because each query is known to be statically formed, we are guaranteed to get
maximum effectiveness of the database's internal query cache, minimizing query
parse time and query planning time.

### Basics

If you don't want to use the built-in mfsqlchecker migration engine, then you
can dump your PostgreSQL database schema to an .sql file and point
`mfsqlchecker` to it

### Queries

To make a query call one of the following 3 methods on your connection object:

- `query`: For queries that can contain any number of rows(zero, one, or
  more). This is usually what you want. This will return an array of "Row"
  objects.

- `queryOne`: For queries that will always return exactly one row. This should
  only be used when the structure of your query guarantees that it will always
  return a single row. For example `SELECT COUNT(*) FROM [..]`, or a top-level
  `SELECT EXISTS(..)`. This will return a single "Row" object.

- `queryOneOrNone`: For queries that always return either a single row, or no
  rows. This should be used for queries that select a single row using based
  on a unique id. If a matching row is found then returns a "Row" object,
  otherwise returns `null`.

### Easy, Automatic SQL Views

... defineSqlView ...

### Reusable SQL fragments

... sqlFrag ...

### Dedicated INSERT functionality

When using mfsqlchecker, you use regular SQL syntax for all queries. But there
is an optional dedicated syntax for "INSERT". You can still write INSERT
queries as regular queries, but it is recommended to use the dedicated insert
functionality because:

1. It is easier to read/write when there are lots of columns
2. Simple syntax for inserting multiple rows
3. It catches errors where you forgot to specify a required column

Here is an example "raw" INSERT query:

```TypeScript
export async function insertEmployee(conn: Connection, employee: Employee): Promise<void> {
    await conn.query(conn.sql
        `
        INSERT INTO employee
            (salary, phonenumber, name, manager_id)
        VALUES
            (${employee.salary}, ${employee.phoneNumber}, ${employee.name}, NULL)
        `);
}
```

It is difficult and error-prone to verify that the column names match up with
the values. It is very easy to make a mistake by, for example, mixing the
order of the *phonenumber* and *name* columns. This becomes more likely when
there are lots of columns.

Here it is rewritten using mfsqlchecker `insert` method:

```TypeScript
export async function insertEmployee(conn: Connection, employee: Employee): Promise<void> {
    await conn.insert("employee", {
        salary: employee.salary,
        phonenumber: employee.phoneNumber,
        name: employee.name,
        manager_id: null
    });
}
```

Now we can more easily see each value together with its column. mfsqlchecker
will still validate that the type of each value matches that of its table
column, and additionally it will check that all required columns are listed.

If we need to add additional SQL to our INSERT statement, such as a
`RETURNING` clause, or an `ON CONFLICT` clause, we can add it as the 3rd
argument:

```TypeScript
export async function insertEmployee(conn: Connection, employee: Employee): Promise<number> {
    const row = await conn.insert<{
        id: Req<EmployeeId>
    }>("employee", {
        salary: employee.salary,
        phonenumber: employee.phoneNumber,
        name: employee.name,
        manager_id: null
    }, conn.sql
        `
        RETURNING id
        `);

    return row.id.val();
}
```

**NOTE**: If your query contains an `ON CONFLICT DO NOTHING` clause, or an `ON
CONFLICT DO UPDATE ... WHERE` clause, then you should use the `insertMaybe()`
method instead of `insert()`, because it is possible for such a query to
return 0 rows.

To insert multiple rows, use the `insertMany()` method (which also will
perform all of the static checks discussed earlier):

```TypeScript
export async function insertEmployees(conn: Connection, employees: Employee[]): Promise<void> {
    const vals = [];
    for (const employee of employees) {
        vals.push({
            salary: employee.salary,
            phonenumber: employee.phoneNumber,
            name: employee.name,
            manager_id: null
        });
    }

    await conn.insertMany("employee", vals);
}
```

`insertMany` also supports an optional 3rd argument, in case you need to add a
`RETURNING` clause or `ON CONFLICT` clause.

**NOTE**: `insert`, `insertMaybe`, and `insertMany` do not support more
complicated inserts involving subqueries, or computed SQL expressions. For
those, just write a regular INSERT query (using the `query` method).

### Enhanced checking of foreign keys on "id" style columns

... TODO ...

## Gotchas

For the most part, if a query passes validation by mfsqlchecker's static
checker, then the query is guaranteed to succeed also during runtime. But
there are a few known cases where things break down.

### Outer Joins and incorrectly detected `Req` Columns

mfsqlchecker is currently unable to detect the usage of outer joins. A query
containing an outer 

### Type information lost during UPDATE


... add a cast ...

### UNNEST

... here is a trick that works ...

## How it works (Behind the Scenes)

mfsqlchecker analyzes all of TypeScript source code of your project, searching
for all the SQL queries. It submits each one to a temporary PostgreSQL
database, as a prepared statement. This allows it to check that the query is
valid (correct syntax, valid table & column names, etc...), as well as query
the type of each of the returned columns.
