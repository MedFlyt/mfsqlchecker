import type EmbeddedPostgres from "embedded-postgres";
import * as TE from "fp-ts/TaskEither";
import * as E from "fp-ts/Either";
import { pipe } from "fp-ts/function";
import { runAsWorker } from "synckit";
import { QueryRunner } from "./DbConnector";
import { Options, PostgresOptions, initializeTE } from "./sql-check.utils";
import { ResolvedSelect } from "../../mfsqlchecker/queries";

let config: {
    readonly options: Options;
    readonly server: {
        pg: EmbeddedPostgres;
        options: Pick<PostgresOptions, "port" | "user" | "password">;
        adminUrl: string;
        dbName: string;
    };
    readonly runner: QueryRunner;
} | null = null;

export type WorkerParams =
    | {
          action: "INITIALIZE";
          projectDir: string;
      }
    | { action: "CHECK"; query: ResolvedSelect }
    | { action: "END" };

runAsWorker(async (params: WorkerParams) => {
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
    return pipe(
        initializeTE({ projectDir: params.projectDir }),
        TE.map((result) => {
            config = result;
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
        TE.mapLeft((error) => ({ type: "RUNNER_ERROR", error: error.message }))
    );
}

function runEnd(params: Extract<WorkerParams, { action: "END" }>) {
    return pipe(
        TE.Do,
        TE.chain(() => TE.tryCatch(() => config?.runner.end() ?? Promise.resolve(), E.toError)),
        TE.chain(() => TE.tryCatch(() => config?.server.pg.stop() ?? Promise.resolve(), E.toError)),
        TE.mapLeft((error) => ({ type: "INTERNAL_ERROR", error }))
    );
}

// const program = flow((projectDir: string) => initializeTE({ projectDir }));
