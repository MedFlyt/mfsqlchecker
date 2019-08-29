import * as crypto from "crypto";

export function calcViewName(varName: string | null, query: string) {
    const hash = crypto.createHash("sha1").update(query).digest("hex");

    const viewName = varName !== null
        ? "view_" + varName.split(/(?=[A-Z])/).join("_").toLowerCase() + "_" + hash.slice(0, 12)
        : "view_" + hash.slice(0, 12);

    return viewName;
}
