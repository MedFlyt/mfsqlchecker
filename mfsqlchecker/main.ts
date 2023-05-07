import "source-map-support/register"; // tslint:disable-line:no-import-side-effect

import { assertNever } from "assert-never";
import * as E from "fp-ts/Either";
import { ErrorDiagnostic } from "./ErrorDiagnostic";
import { codeFrameFormatter } from "./formatters/codeFrameFormatter";
import { jsonFormatter } from "./formatters/jsonFormatter";
import { vscodeFormatter } from "./formatters/vscodeFormatter";
import { initialize } from "./main_utils";
import { SqlCheckerEngine, typeScriptSingleRunCheck, TypeScriptWatcher } from "./sqlchecker_engine";

enum Format {
    CODE_FRAME,
    JSON,
    VSCODE
}

export class ParseError extends Error {
    constructor(public readonly message: string) {
        super(message);
    }
}

function formatFunction(format: Format): (errorDiagnostics: ErrorDiagnostic[]) => string {
    switch (format) {
        case Format.CODE_FRAME:
            return (e) => e.map(codeFrameFormatter).join("\n");
        case Format.JSON:
            return jsonFormatter;
        case Format.VSCODE:
            return (e) => e.map(vscodeFormatter).join("\n");
        default:
            return assertNever(format);
    }
}

async function main(): Promise<void> {
    const result = await initialize();

    if (E.isLeft(result)) {
        console.error(result.left);
        process.exit(1);
    }

    const { dbConnector, pgServer, options } = result.right;

    try {
        const formatter = formatFunction(options.format);
        const e = new SqlCheckerEngine(options.configFile, dbConnector);
        if (options.watchMode) {
            const w = new TypeScriptWatcher(e, formatter);
            w.run(options.projectDir);
            await blockForever();
        } else {
            const success = await typeScriptSingleRunCheck(options.projectDir, e, formatter);
            if (!success) {
                process.exitCode = 1;
            }
        }
    } finally {
        await dbConnector.close();
        await pgServer.pgServer?.close();
    }
}

function blockForever(): Promise<void> {
    return new Promise<void>(() => {
        /* Block Forever */
    });
}

main();
