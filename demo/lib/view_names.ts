import * as crypto from "crypto";

// <https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS>
const POSTGRES_IDENT_MAX_LEN = 63;

export function calcViewName(varName: string | null, query: string) {
    const hash = crypto.createHash("sha1").update(query).digest("hex");

    const prefix = "$$mfv_";

    if (varName === null) {
        return prefix + hash.slice(0, 12);
    }

    const overflow = prefix.length + varName.length + 1 + 12 - POSTGRES_IDENT_MAX_LEN;

    const varName2 = overflow > 0
        ? varName.substr(0, varName.length - overflow)
        : varName;

    return prefix + varName2 + "_" + hash.slice(0, 12);
}

const viewRegex = /view "(\$\$mfv_[a-zA-Z0-9_]*_?[a-z0-9]{12})"/;

export function extractViewName(line: string): string | null {
    const results = viewRegex.exec(line);
    if (results === null) {
        return null;
    }

    if (results.length < 2) {
        return null;
    }

    return results[1];
}
