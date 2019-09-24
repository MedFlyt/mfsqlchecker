import * as crypto from "crypto";

export function calcViewName(varName: string | null, query: string) {
    const hash = crypto.createHash("sha1").update(query).digest("hex");

    const prefix = "$$mfv_";
    const viewName = varName !== null
        ? prefix + varName + "_" + hash.slice(0, 12)
        : prefix + hash.slice(0, 12);

    return viewName;
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
