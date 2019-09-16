import chalk from "chalk";
import * as ts from "typescript";
import { PostgreSqlError } from "./pg_extra";

export interface QuickFix {
    name: string;
    replacementText: string;
}

export interface ErrorDiagnostic {
    fileName: string;
    fileContents: string;
    span: SrcSpan;
    messages: string[];
    epilogue: string | null;

    /**
     * Replace the `span` with this text
     */
    quickFix: QuickFix | null;
}

export function fileLineCol(fileContents: string, position: number): SrcSpan.LineAndCol {
    let line = 1;
    let col = 0;
    for (let i = 0; i < position; ++i) {
        if (fileContents.codePointAt(i) === 10) {
            line++;
            col = 0;
        }
        col++;
    }
    return {
        type: "LineAndCol",
        line: line,
        col: col
    };
}

export function toSrcSpan(fileContents: string, position: number | null): SrcSpan {
    if (position === null) {
        return { type: "File" };
    }
    return fileLineCol(fileContents, position - 1);
}

export function postgresqlErrorDiagnostic(fileName: string, fileContents: string, err: PostgreSqlError, span: SrcSpan, message: string | null): ErrorDiagnostic {
    return {
        fileName: fileName,
        fileContents: fileContents,
        span: span,
        messages: (message !== null ? [message] : []).concat([
            chalk.bold(err.message),
            chalk.bold("code:") + " " + err.code
        ]).concat(err.detail !== null && err.detail !== err.message ? chalk.bold("detail:") + " " + err.detail : []),
        epilogue: err.hint !== null ? chalk.bold("hint:") + " " + err.hint : null,
        quickFix: null
    };
}

export function nodeErrorDiagnostic(node: ts.Node, message: string): ErrorDiagnostic {
    const sourceFile = node.getSourceFile();
    return {
        fileName: sourceFile.fileName,
        fileContents: sourceFile.text,
        span: nodeSourceSpan(node),
        messages: [chalk.bold(message)],
        epilogue: null,
        quickFix: null
    };
}

export function nodeSourceSpan(node: ts.Node): SrcSpan {
    const sourceFile = node.getSourceFile();
    const pos = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
    const end = ts.getLineAndCharacterOfPosition(sourceFile, node.end);
    return {
        type: "LineAndColRange",
        startLine: pos.line + 1,
        startCol: pos.character + 1,
        endLine: end.line + 1,
        endCol: end.character + 1
    };
}

export type SrcSpan = SrcSpan.LineAndColRange | SrcSpan.LineAndCol | SrcSpan.File;

export namespace SrcSpan {
    export interface LineAndColRange {
        type: "LineAndColRange";
        startLine: number;
        startCol: number;
        endLine: number;
        endCol: number;
    }

    export interface LineAndCol {
        type: "LineAndCol";
        line: number;
        col: number;
    }

    export interface File {
        type: "File";
    }
}
