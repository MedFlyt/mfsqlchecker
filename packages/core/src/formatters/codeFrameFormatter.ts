import chalk from "chalk";
import { ErrorDiagnostic } from "../ErrorDiagnostic";

export function codeFrameFormatter(errorDiagnostic: ErrorDiagnostic): string {
    let result = "\n";

    // result += renderFileLocation(errorDiagnostic);
    result += renderMessages(errorDiagnostic);
    result += renderCodeFrame(errorDiagnostic);
    result += renderEpilogue(errorDiagnostic);

    return result;
}

function renderFileLocation(errorDiagnostic: ErrorDiagnostic): string {
    let result = "";
    result += chalk.cyanBright(errorDiagnostic.fileName);
    switch (errorDiagnostic.span.type) {
        case "LineAndColRange":
            result += ":" + chalk.yellowBright(`${errorDiagnostic.span.startLine}`) + ":" + chalk.yellowBright(`${errorDiagnostic.span.startCol}`) + ":";
            break;
        case "LineAndCol":
            result += ":" + chalk.yellowBright(`${errorDiagnostic.span.line}`) + ":" + chalk.yellowBright(`${errorDiagnostic.span.col}`) + ":";
            break;
        case "File":
            result += ":";
            break;
    }

    result += " " + chalk.redBright.bold("error:");
    result += "\n";
    return result;
}

function renderMessages(errorDiagnostic: ErrorDiagnostic): string {
    let result = "";
    for (const message of errorDiagnostic.messages) {
        const msg = message.replace(/\n/g, "\n      ");
        result += "    * " + msg + "\n";
    }
    return result;
}

function renderCodeFrame(errorDiagnostic: ErrorDiagnostic): string {
    let result = "";

    let startLine: number;
    let endLine: number;
    switch (errorDiagnostic.span.type) {
        case "LineAndCol":
            startLine = errorDiagnostic.span.line - 1;
            endLine = errorDiagnostic.span.line - 1;
            break;
        case "LineAndColRange":
            startLine = errorDiagnostic.span.startLine - 1;
            endLine = errorDiagnostic.span.endLine - 1;
            break;
        case "File":
            return result;
    }

    result += "\n";

    const lines = errorDiagnostic.fileContents.split("\n");

    const LINES_MARGIN = 2;

    const minLine = Math.max(0, startLine - LINES_MARGIN);
    const maxLine = Math.min(lines.length - 1, endLine + LINES_MARGIN);
    const padding = `${maxLine + 1}`.length;
    for (let l = minLine; l <= maxLine; ++l) {
        switch (errorDiagnostic.span.type) {
            case "LineAndCol":
                if (l === errorDiagnostic.span.line - 1) {
                    const prefix = lines[l].substr(0, errorDiagnostic.span.col - 1);
                    const target = lines[l].substr(errorDiagnostic.span.col - 1, 1);
                    const suffix = lines[l].substr(errorDiagnostic.span.col);
                    result += chalk.blueBright(` ${pad(`${l + 1}`, padding, " ")} |`) + " " + prefix + chalk.redBright.bold(target) + suffix + "\n";
                } else {
                    result += chalk.blueBright(` ${pad(`${l + 1}`, padding, " ")} |`) + " " + lines[l] + "\n";
                }

                if (l === errorDiagnostic.span.line - 1) {
                    result += chalk.blueBright(` ${pad("", padding, " ")} |`) + " ".repeat(errorDiagnostic.span.col) + chalk.redBright.bold("^") + "\n";
                }
                break;
            case "LineAndColRange":
                if (l > errorDiagnostic.span.startLine - 1 && l < errorDiagnostic.span.endLine - 1) {
                    result += chalk.blueBright(` ${pad(`${l + 1}`, padding, " ")} |`) + " " + chalk.redBright.bold(lines[l]) + "\n";
                    const spaces = lines[l].search(/(\S|$)/);
                    result += chalk.blueBright(` ${pad("", padding, " ")} |`) + " ".repeat(spaces + 1) + chalk.redBright.bold("~".repeat(lines[l].length - spaces)) + "\n";
                } else if (l === errorDiagnostic.span.startLine - 1 && l !== errorDiagnostic.span.endLine - 1) {
                    const prefix = lines[l].substr(0, errorDiagnostic.span.startCol - 1);
                    const suffix = lines[l].substr(errorDiagnostic.span.startCol - 1);
                    const spaces = prefix.length;
                    result += chalk.blueBright(` ${pad(`${l + 1}`, padding, " ")} |`) + " " + prefix + chalk.redBright.bold(suffix) + "\n";
                    if (lines[l].length > spaces) {
                        result += chalk.blueBright(` ${pad("", padding, " ")} |`) + " ".repeat(spaces + 1) + chalk.redBright.bold("~".repeat(lines[l].length - spaces)) + "\n";
                    }
                } else if (l === errorDiagnostic.span.endLine - 1 && l !== errorDiagnostic.span.startLine - 1) {
                    const prefix = lines[l].substr(0, errorDiagnostic.span.endCol - 1);
                    const suffix = lines[l].substr(errorDiagnostic.span.endCol - 1);
                    const spaces = lines[l].search(/(\S|$)/);
                    result += chalk.blueBright(` ${pad(`${l + 1}`, padding, " ")} |`) + " " + chalk.redBright.bold(prefix) + suffix + "\n";
                    result += chalk.blueBright(` ${pad("", padding, " ")} |`) + " ".repeat(spaces + 1) + chalk.redBright.bold("~".repeat(prefix.length - spaces)) + "\n";
                } else if (l === errorDiagnostic.span.endLine - 1 && l === errorDiagnostic.span.startLine - 1) {
                    const prefix = lines[l].substr(0, errorDiagnostic.span.startCol - 1);
                    const target = lines[l].substring(errorDiagnostic.span.startCol - 1, errorDiagnostic.span.endCol - 1);
                    const suffix = lines[l].substr(errorDiagnostic.span.endCol - 1);
                    result += chalk.blueBright(` ${pad(`${l + 1}`, padding, " ")} |`) + " " + prefix + chalk.redBright.bold(target) + suffix + "\n";
                    result += chalk.blueBright(` ${pad("", padding, " ")} |`) + " ".repeat(prefix.length + 1) + chalk.redBright.bold("~".repeat(lines[l].length - suffix.length - prefix.length)) + "\n";
                } else {
                    result += chalk.blueBright(` ${pad(`${l + 1}`, padding, " ")} |`) + " " + lines[l] + "\n";
                }
                break;
        }
    }

    result += "\n";

    return result;
}

function renderEpilogue(errorDiagnostic: ErrorDiagnostic): string {
    let result = "";
    if (errorDiagnostic.epilogue === null) {
        return result;
    }

    const msg = errorDiagnostic.epilogue.replace(/\n/g, "\n      ");
    result += "    * " + msg + "\n";

    return result;
}

function pad(str: string, width: number, z: string) {
    return str.length >= width ? str : new Array(width - str.length + 1).join(z) + str;
}
