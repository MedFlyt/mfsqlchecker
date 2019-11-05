import * as vscode from 'vscode';
import * as fs from 'fs';
import * as readline from "readline";
import * as childProcess from "child_process";
import * as path from "path";

type DiagnosticId = number;

interface QuickFix {
    name: string;
    replacementText: string;
}

export interface State {
    closing: boolean;
    childP: childProcess.ChildProcess | null;
    nextDiagnosticId: number;
    quickFixes: Map<DiagnosticId, QuickFix>;
    readonly status: vscode.StatusBarItem;
    readonly diagnosticCollection: vscode.DiagnosticCollection;
}

function nextDiagnosticId(state: State): number {
    state.nextDiagnosticId++;
    return state.nextDiagnosticId;
}

export function start(context: vscode.ExtensionContext): State {
    let state: State = {
        closing: false,
        childP: null,
        nextDiagnosticId: 0,
        quickFixes: new Map<DiagnosticId, QuickFix>(),
        status: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 200),
        diagnosticCollection: vscode.languages.createDiagnosticCollection("mfsqlchecker")
    };

    state.status.text = "mfsqlchecker $(database) $(sync)";
    state.status.tooltip = "mfsqlchecker checking...";
    state.status.command = undefined;
    state.status.show();

    context.subscriptions.push(state.diagnosticCollection);

    vscode.workspace.findFiles("**/mfsqlchecker.json", undefined, 1).then(
        value => {
            if (state.closing) {
                return;
            }

            if (value.length === 0) {
                vscode.window.showErrorMessage(`File mfsqlchecker.json does not exist`);
            } else if (value.length > 1) {
                vscode.window.showErrorMessage(`Multiple mfsqlchecker.json files found`);
            } else {
                const configPath = value[0].fsPath;
                launch(state, configPath);
            }
        },
        err => {
            if (state.closing) {
                return;
            }

            vscode.window.showErrorMessage(`Error finding mfsqlchecker.json:\n${err.toString()}`);
        });

    vscode.workspace.onDidChangeTextDocument(() => {
        state.quickFixes.clear();
        state.diagnosticCollection.clear();
    });

    vscode.languages.registerCodeActionsProvider({ scheme: "file", language: "typescript" }, {
        provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
            const quickFixActions: vscode.CodeAction[] = [];
            for (const diag of context.diagnostics) {
                if (typeof diag.code === "number") {
                    const quickFix = state.quickFixes.get(diag.code);
                    if (quickFix !== undefined) {
                        const quickFixAction = new vscode.CodeAction(quickFix.name, vscode.CodeActionKind.QuickFix);
                        quickFixAction.edit = new vscode.WorkspaceEdit();
                        quickFixAction.edit.replace(document.uri, diag.range, quickFix.replacementText);
                        quickFixAction.kind = vscode.CodeActionKind.QuickFix;

                        quickFixActions.push(quickFixAction);
                    }
                }
            }

            if (quickFixActions.length > 0) {
                return quickFixActions;
            } else {
                return undefined;
            }
        }
    }, {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
        });


    return state;
}

function launch(state: State, configPath: string) {
    console.log("spawning");
    state.childP = childProcess.spawn("node", [path.join(workspacePath(), "node_modules", ".bin", "mfsqlchecker"), "-p", path.dirname(configPath), "-c", configPath, "--format", "json", "--watch"], {
        stdio: ["ignore", "pipe", "pipe"]
    });

    state.childP.on("error", (err: Error) => {
        console.log("error", err);
        vscode.window.showErrorMessage("Error launching \"node\" process:\n" + err.message);

        state.status.text = "mfsqlchecker $(database) $(flame)";
        state.status.tooltip = "mfsqlchecker launch error!";
        state.status.command = "workbench.action.reloadWindow";
    });

    let stderr: string = "";

    const stderrLines = readline.createInterface(state.childP.stderr);
    stderrLines.on("line", (line: string) => {
        console.log("[stderr] " + line);
        stderr += line + "\n";
    });

    const stdoutLines = readline.createInterface(state.childP.stdout);
    stdoutLines.on("line", (line: string) => {
        console.log("Received line:", line);
        if (line === "[DIAGNOSTICS START]") {
            state.status.text = "mfsqlchecker $(database) $(sync)";
            state.status.tooltip = "mfsqlchecker checking...";
            state.status.command = undefined;
        } else if (line.charAt(0) === "{") {
            const msg = JSON.parse(line);

            state.quickFixes.clear();

            const diagnostics = new Map<string, vscode.Diagnostic[]>();
            for (const diag of msg.errorDiagnostics) {
                let diags = diagnostics.get(diag.fileName);
                if (diags === undefined) {
                    diags = [];
                    diagnostics.set(diag.fileName, diags);
                }

                const sev = vscode.DiagnosticSeverity.Information;
                const vscodeDiag = new vscode.Diagnostic(new vscode.Range(diag.location.startLine, diag.location.startCharacter, diag.location.endLine, diag.location.endCharacter), diag.message, sev);
                vscodeDiag.source = "mfsqlchecker";

                if (diag.quickFix !== null) {
                    vscodeDiag.code = nextDiagnosticId(state);
                    state.quickFixes.set(vscodeDiag.code, {
                        name: diag.quickFix.name,
                        replacementText: diag.quickFix.replacementText
                    });
                }

                diags.push(vscodeDiag);
            }

            state.diagnosticCollection.clear();
            diagnostics.forEach((value, key) => {
                state.diagnosticCollection.set(vscode.Uri.parse("file://" + key), value);
            });

            if (diagnostics.size === 0) {
                state.status.text = "mfsqlchecker $(database) $(check)";
                state.status.tooltip = "mfsqlchecker success";
                state.status.command = undefined;
            } else {
                state.status.text = "mfsqlchecker $(database) $(bug)";
                state.status.tooltip = "mfsqlchecker detected errors";
                state.status.command = "workbench.action.problems.focus";
            }
        }
    });

    state.childP.on("exit", (code: number) => {
        console.log("exit", code);
        vscode.window.showErrorMessage("mfsqlchecker emitted an error:\n" + stderr);

        state.status.text = "mfsqlchecker $(database) $(flame)";
        state.status.tooltip = "mfsqlchecker crashed!";
        state.status.command = "workbench.action.reloadWindow";
    });
}

export function stop(state: State): Promise<void> {
    state.closing = true;

    if (state.childP !== null) {
        const childP = state.childP;
        childP.kill("SIGINT");

        return new Promise<void>((resolve) => {
            childP.on("close", resolve);
        });
    } else {
        return Promise.resolve();
    }
}

function workspacePath(): string {
    const ws = vscode.workspace.workspaceFolders;
    if (ws === undefined) {
        throw new Error("Workspace is undefined");
    }
    if (ws.length !== 1) {
        throw new Error(`Workspace length is ${ws.length}`);
    }
    return ws[0].uri.fsPath;
}
