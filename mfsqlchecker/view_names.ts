import * as crypto from "crypto";

export function calcViewName(varName: string | null, query: string) {
    const hash = crypto.createHash("sha1").update(query).digest("hex");

    const prefix = "%mfv%_";
    const viewName = varName !== null
        ? prefix + varName + "_" + hash.slice(0, 12)
        : prefix + hash.slice(0, 12);

    return viewName;
}
