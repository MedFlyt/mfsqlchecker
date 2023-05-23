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

    static to(diagnostics: ErrorDiagnostic[]): InvalidQueryError {
        return new InvalidQueryError(diagnostics);
    }

    toJSON() {
        return { _tag: this._tag, message: this.message, diagnostics: this.diagnostics };
    }
}
