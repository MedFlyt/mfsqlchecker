import type EmbeddedPostgres from "embedded-postgres";
import * as E from "fp-ts/Either";
import { pipe } from "fp-ts/function";
import * as TE from "fp-ts/TaskEither";
import "source-map-support/register";
import { runAsWorker } from "synckit";
import { UniqueTableColumnType } from "../../mfsqlchecker/ConfigFile";
import { ResolvedSelect } from "../../mfsqlchecker/queries";
import { SqlCreateView } from "../../mfsqlchecker/views";
import { QueryRunner } from "./DbConnector";
import { RunnerError } from "./sql-check.errors";
import { initializeTE, Options, PostgresOptions } from "./sql-check.utils";

export type WorkerParams = InitializeParams | CheckParams | EndParams;

type TaskEitherToEither<T> = T extends TE.TaskEither<infer E, infer A> ? E.Either<E, A> : never;

export type WorkerResult<Action extends WorkerParams["action"]> = TaskEitherToEither<
    {
        INITIALIZE: ReturnType<typeof runInitialize>;
        CHECK: ReturnType<typeof runCheck>;
        END: ReturnType<typeof runEnd>;
    }[Action]
>;

let cache: {
    readonly options: Options;
    readonly server: {
        pg: EmbeddedPostgres;
        options: Pick<PostgresOptions, "port" | "user" | "password">;
        adminUrl: string;
        dbName: string;
    };
    readonly runner: QueryRunner;
} | null = null;

let i = 1;

async function handler(params: WorkerParams) {
    switch (params.action) {
        case "INITIALIZE":
            return await runInitialize(params)();
        case "CHECK":
            return await runCheck(params)();
        case "END":
            return await runEnd(params)();
    }
}

type InitializeParams = {
    action: "INITIALIZE";
    projectDir: string;
    uniqueTableColumnTypes: UniqueTableColumnType[];
    strictDateTimeChecking: boolean;
    viewLibrary: SqlCreateView[];
};

function runInitialize(params: InitializeParams) {
    return pipe(
        initializeTE({
            projectDir: params.projectDir,
            uniqueTableColumnTypes: params.uniqueTableColumnTypes,
            strictDateTimeChecking: params.strictDateTimeChecking,
            viewLibrary: params.viewLibrary
        }),
        TE.map((result) => {
            cache = result;
        })
    );
}

type CheckParams = { action: "CHECK"; query: ResolvedSelect };

function runCheck(params: CheckParams) {
    if (cache?.runner === undefined) {
        return TE.left(new Error("runner is not initialized"));
    }

    const runner = cache.runner;

    return pipe(TE.tryCatch(() => runner.runQuery({ query: params.query }), RunnerError.to));
}

type EndParams = { action: "END" };

function runEnd(params: Extract<WorkerParams, { action: "END" }>) {
    return pipe(
        TE.Do,
        TE.chain(() => TE.tryCatch(() => cache?.runner.end() ?? Promise.resolve(), E.toError)),
        TE.chain(() => TE.tryCatch(() => {
            return cache?.server.pg.stop() ?? Promise.resolve();
        }, E.toError))
    );
}

runAsWorker(handler);
