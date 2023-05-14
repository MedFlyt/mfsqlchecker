import { ErrorDiagnostic } from "../../mfsqlchecker/ErrorDiagnostic";
import { codeFrameFormatter } from "../../mfsqlchecker/formatters/codeFrameFormatter";

export class RunnerError extends Error {
    _tag = "RunnerError";

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
    _tag = "InvalidQueryError";

    constructor(diagnostics: ErrorDiagnostic[]) {
        super(diagnostics.map(codeFrameFormatter).join("\n"));
        this.name = "InvalidQueryError";
    }

    static to(error: unknown) {
        return error instanceof InvalidQueryError ? error : new Error(`${error}`);
    }

    toJSON() {
        return { _tag: this._tag, message: this.message };
    }
}
