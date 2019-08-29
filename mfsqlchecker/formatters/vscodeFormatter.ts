import { assertNever } from "assert-never";
import * as path from "path";
import { ErrorDiagnostic, SrcSpan } from "../ErrorDiagnostic";

export function vscodeFormatter(errorDiagnostic: ErrorDiagnostic): string {
    let result = "";

    const loc = vscodeLocation(errorDiagnostic.span);

    const filename = path.relative(process.cwd(), errorDiagnostic.fileName);

    // VSCode recognizeds "error", "warning", "info"
    // Reference: <https://code.visualstudio.com/docs/editor/tasks-appendix>
    const severity = "warning";
    function addLine(msg: string) {
        result += "[DIAGNOSTIC] " + filename + " (" + severity + ") " + loc + " " + msg + "\n";

        // NOTE: I initially had the genius idea to tag the first line as
        // "error" and the following lines as "info", so that a glance at the
        // VSCode problems window would more clearly show the true number of
        // errors. Unfortunately, VSCode will re-arrange the problems so that
        // all errors always appear above all info messages, this causes the
        // lines to be jumbled up when we emit more than one error (or if
        // there are other errors from other tools). Oh well, stick with
        // everything as an "error" line for now

        // severity = "info";
    }

    for (const message of errorDiagnostic.messages) {
        for (const line of message.split("\n")) {
            addLine(line);
        }
    }
    if (errorDiagnostic.epilogue !== null) {
        for (const line of errorDiagnostic.epilogue.split("\n")) {
            addLine(line);
        }
    }

    return result;
}

function vscodeLocation(span: SrcSpan): string {
    switch (span.type) {
        case "LineAndColRange":
            return "(" + span.startLine + "," + span.startCol + "," + span.endLine + "," + span.endCol + ")";
        case "LineAndCol":
            return "(" + span.line + "," + span.col + ")";
        case "File":
            return "(1)";
        default:
            return assertNever(span);
    }
}
