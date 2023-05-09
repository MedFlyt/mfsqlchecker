import { flow, pipe } from "fp-ts/function";
import * as TE from "fp-ts/TaskEither";
import * as E from "fp-ts/Either";
import { runAsWorker } from "synckit";
import { PostgresServer } from "../../mfsqlchecker/launch_postgres";
import { QueryRunner } from "./DbConnector";
import { initializeTE, Options } from "./sql-check.utils";

let config: {
    readonly options: Options;
    readonly server: {
        url: string;
        dbName: string | undefined;
        pgServer: PostgresServer | null;
    };
    readonly runner: QueryRunner;
} | null = null;

export type WorkerParams =
    | {
          action: "INITIALIZE";
          projectDir: string;
      }
    | { action: "CHECK", query: string }
    | { action: "END" };

console.log("a");
runAsWorker(async (params: WorkerParams) => {
    console.log("runAsWorker");
    switch (params.action) {
        case "INITIALIZE":
            return runInitialize(params)();
        case "CHECK":
            return runCheck(params)();
        case "END":
            return runEnd(params)();
    }
});

function runInitialize(params: Extract<WorkerParams, { action: "INITIALIZE" }>) {
    console.log("runInitialize");
    return pipe(
        initializeTE({ projectDir: params.projectDir }),
        TE.map((result) => {
            config = result;
            return result;
        }),
        TE.mapLeft((error) => ({ type: "INTERNAL_ERROR", error }))
    );
}

function runCheck(params: Extract<WorkerParams, { action: "CHECK" }>) {
    if (config?.runner === undefined) {
        return TE.left({ type: "INTERNAL_ERROR", error: new Error("runner is not initialized") });
    }

    const runner = config.runner;

    return pipe(
        TE.tryCatch(() => runner.runQuery({ query: params.query }), E.toError),
        TE.mapLeft((error) => ({ type: "RUNNER_ERROR", error }))
    )
}

function runEnd(params: Extract<WorkerParams, { action: "END" }>) {
    return pipe(
        TE.tryCatch(() => config?.server.pgServer?.close() ?? Promise.resolve(), E.toError),
        TE.mapLeft((error) => ({ type: "INTERNAL_ERROR", error }))
    );
}

const program = flow((projectDir: string) => initializeTE({ projectDir }));
