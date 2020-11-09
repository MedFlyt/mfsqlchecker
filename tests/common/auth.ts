import { sqlFragAuth, Connection, SqlFragAuth, defineSqlViewPrimitive, SqlView, SqlFrag } from "../../lib/mfsqltool";

export type AuthNone = {
    none: null;
    employee: null;
    customer: null;
    user: null;
}

export type AuthUser = {
    employee: null;
    customer: null;
    user: null;
}

export type AuthEmployee = {
    employee: null;
    user: null;
}

export type AuthCustomer = {
    customer: null;
    user: null;
}

export class AuthConn<T> extends Connection<SqlFragAuth<string, T>, T> {
    // Empty
}

export const userIdFrag = sqlFragAuth<AuthUser>()(`current_setting('auth.user_id', 't')::int8`);
export const employeeIdFrag = sqlFragAuth<AuthEmployee>()(`current_setting('auth.employee_id', 't')::int8`);
export const customerIdFrag = sqlFragAuth<AuthCustomer>()(`current_setting('auth.customer_id', 't')::int8`);

export function defineSqlView<V = AuthNone>(x: TemplateStringsArray, ...placeholders: (SqlView<V> | SqlFrag<string> | SqlFragAuth<string, V>)[]): SqlView<V> {
    return defineSqlViewPrimitive<V>(x, ...placeholders);
}
