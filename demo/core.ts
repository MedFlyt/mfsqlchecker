import { Connection, defineSqlViewPrimitive, SqlFrag, SqlFragAuth, SqlView } from "../lib/mfsqltool";

export class Conn<T> extends Connection<SqlFragAuth<string, T> | T, {}> {
    // Empty
}

export function defineSqlView<V = {}>(x: TemplateStringsArray, ...placeholders: (SqlView<V> | SqlFrag<string> | SqlFragAuth<string, V>)[]): SqlView<V> {
    return defineSqlViewPrimitive<V>(x, ...placeholders);
}
