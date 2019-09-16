import { assertNever } from "assert-never";
import { ErrorDiagnostic, QuickFix } from "../ErrorDiagnostic";

interface JSONDiagnosticLocation {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
}

interface JSONDiagnostic {
    fileName: string;
    location: JSONDiagnosticLocation;
    message: string;
    quickFix: QuickFix | null;
}

interface JSONOutput {
    errorDiagnostics: JSONDiagnostic[];
}

export function jsonFormatter(errorDiagnostics: ErrorDiagnostic[]): string {
    const jsonOutput: JSONOutput = {
        errorDiagnostics: errorDiagnostics.map(formatJsonDiagnostic)
    };

    return JSON.stringify(jsonOutput);
}

function formatJsonDiagnostic(errorDiagnostic: ErrorDiagnostic): JSONDiagnostic {
    let location: JSONDiagnosticLocation;
    switch (errorDiagnostic.span.type) {
        case "LineAndColRange":
            location = {
                startLine: errorDiagnostic.span.startLine - 1,
                startCharacter: errorDiagnostic.span.startCol - 1,
                endLine: errorDiagnostic.span.endLine - 1,
                endCharacter: errorDiagnostic.span.endCol - 1
            };
            break;
        case "LineAndCol":
            location = {
                startLine: errorDiagnostic.span.line - 1,
                startCharacter: errorDiagnostic.span.col - 1,
                endLine: errorDiagnostic.span.line - 1,
                endCharacter: errorDiagnostic.span.col - 1
            };
            break;
        case "File":
            location = {
                startLine: 0,
                startCharacter: 0,
                endLine: 0,
                endCharacter: 0
            };
            break;
        default:
            return assertNever(errorDiagnostic.span);
    }

    let message: string = "";
    for (const msg of errorDiagnostic.messages) {
        message += "* " + msg + "\n";
    }
    if (errorDiagnostic.epilogue !== null) {
        message += "* " + errorDiagnostic.epilogue;
    }

    return {
        fileName: errorDiagnostic.fileName,
        location: location,
        message: message,
        quickFix: errorDiagnostic.quickFix
    };
}
