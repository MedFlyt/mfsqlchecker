import * as vscode from 'vscode';
import { start, State, stop } from './operation';

let state: State | null = null;

export function activate(context: vscode.ExtensionContext) {
	console.log("Activate");
	state = start(context);
	console.log("Activate Done");
}

export function deactivate(): Promise<void> {
	if (state !== null) {
		return stop(state);
	} else {
		return Promise.resolve();
	}
}
