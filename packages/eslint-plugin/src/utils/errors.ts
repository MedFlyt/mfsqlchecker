import { ErrorDiagnostic, codeFrameFormatter } from "@mfsqlchecker/core";

export class RunnerError extends Error {
    _tag = "RunnerError" as const;

    constructor(message: string) {
        super(message);
        this.name = "RunnerError";
    }

    static to(error: unknown) {
        return error instanceof RunnerError ? error : new RunnerError(`${error}`);
    }

    toJSON() {
        return { _tag: this._tag, message: this.message };
    }
}

export class InvalidQueryError extends Error {
    _tag = "InvalidQueryError" as const;
    diagnostics: ErrorDiagnostic[];

    constructor(diagnostics: ErrorDiagnostic[]) {
        super(diagnostics.map(codeFrameFormatter).join("\n"));
        this.name = "InvalidQueryError";
        this.diagnostics = diagnostics;
    }

    static to(error: unknown): InvalidQueryError | Error {
        return error instanceof InvalidQueryError ? error : new Error(`${error}`);
    }

    toJSON() {
        return { _tag: this._tag, message: this.message, diagnostics: this.diagnostics };
    }
}
