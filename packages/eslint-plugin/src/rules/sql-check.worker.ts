import {
    Config,
    ErrorDiagnostic,
    ResolvedInsert,
    ResolvedSelect,
    SqlCreateView
} from "@mfsqlchecker/core";
import type EmbeddedPostgres from "embedded-postgres";
import "source-map-support/register";
import { runAsWorker } from "synckit";
import { UniqueTableColumnType } from "@mfsqlchecker/core";
import { InvalidQueryError, RunnerError } from "../utils/errors";
import { customLog } from "../utils/log";
import { QueryRunner } from "../utils/query-runner";
import { E, J, TE, pipe } from "../utils/fp-ts";
import { Options, PostgresOptions, initializeTE } from "./sql-check.utils";

export type WorkerParams =
    | InitializeParams
    | CheckQueryParams
    | CheckInsertParams
    | UpdateViewsParams
    | EndParams;

type TaskEitherToEither<T> = T extends TE.TaskEither<infer E, infer A> ? E.Either<E, A> : never;

export type WorkerResult<Action extends WorkerParams["action"]> = TaskEitherToEither<
    {
        INITIALIZE: ReturnType<typeof runInitialize>;
        CHECK_QUERY: ReturnType<typeof runCheckQuery>;
        CHECK_INSERT: ReturnType<typeof runCheckInsert>;
        UPDATE_VIEWS: ReturnType<typeof runUpdateViews>;
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

let initializePromiseInstance: Promise<WorkerResult<"INITIALIZE">> | null = null;

async function handler(params: WorkerParams) {
    switch (params.action) {
        case "INITIALIZE": {
            if (initializePromiseInstance === null || params.force) {
                initializePromiseInstance = runInitialize(params)();
            }
            return await initializePromiseInstance;
        }
        case "CHECK_QUERY":
            return await runCheckQuery(params)();
        case "CHECK_INSERT":
            return await runCheckInsert(params)();
        case "UPDATE_VIEWS":
            return await runUpdateViews(params)();
        case "END":
            return await runEnd()();
    }
}

type InitializeParams = {
    action: "INITIALIZE";
    projectDir: string;
    uniqueTableColumnTypes: UniqueTableColumnType[];
    strictDateTimeChecking: boolean;
    sqlViews: SqlCreateView[];
    port: number | undefined;
    config: Config;
    configFilePath: string;
    force: boolean;
};

function runInitialize(
    params: InitializeParams
): TE.TaskEither<InvalidQueryError | RunnerError, void> {
    customLog.success("initialize");
    return pipe(
        initializeTE({
            projectDir: params.projectDir,
            config: params.config,
            port: params.port,
            configFilePath: params.configFilePath,
            migrationsDir: params.config.migrationsDir,
            uniqueTableColumnTypes: params.uniqueTableColumnTypes,
            strictDateTimeChecking: params.strictDateTimeChecking,
            sqlViews: params.sqlViews
        }),
        TE.map((result) => {
            cache = result;
        })
    );
}

type CheckQueryParams = { action: "CHECK_QUERY"; resolved: ResolvedSelect };

function mapDiagnosticsToError(diagnostics: ErrorDiagnostic[]) {
    return diagnostics.length === 0
        ? E.right(undefined)
        : E.left(new InvalidQueryError(diagnostics));
}

function runCheckQuery(
    params: CheckQueryParams
): TE.TaskEither<InvalidQueryError | RunnerError, undefined> {
    if (cache?.runner === undefined) {
        return TE.left(new RunnerError("runner is not initialized"));
    }

    const runner = cache.runner;

    return pipe(
        TE.Do,
        TE.chain(() => runner.runQueryTE(params)),
        TE.chainEitherKW(mapDiagnosticsToError)
    );
}

type CheckInsertParams = { action: "CHECK_INSERT"; resolved: ResolvedInsert };

function runCheckInsert(
    params: CheckInsertParams
): TE.TaskEither<InvalidQueryError | RunnerError, undefined> {
    if (cache?.runner === undefined) {
        return TE.left(new RunnerError("runner is not initialized"));
    }

    const runner = cache.runner;

    return pipe(
        TE.Do,
        TE.chain(() => runner.runInsertTE(params)),
        TE.chainEitherKW(mapDiagnosticsToError)
    );
}

type UpdateViewsParams = {
    action: "UPDATE_VIEWS";
    strictDateTimeChecking: boolean;
    sqlViews: SqlCreateView[];
};

function runUpdateViews(
    params: UpdateViewsParams
): TE.TaskEither<RunnerError | InvalidQueryError, undefined> {
    if (cache?.runner === undefined) {
        return TE.left(new RunnerError("runner is not initialized"));
    }

    const runner = cache.runner;

    return pipe(
        TE.tryCatch(
            () =>
                runner.updateViews({
                    strictDateTimeChecking: params.strictDateTimeChecking,
                    sqlViews: params.sqlViews
                }),
            RunnerError.to
        ),
        TE.chainW((diagnostics) => {
            return diagnostics.length === 0
                ? TE.right(undefined)
                : TE.left(new InvalidQueryError(diagnostics));
        })
    );
}

type EndParams = { action: "END" };

function runEnd() {
    return pipe(
        TE.Do,
        TE.chain(() => TE.tryCatch(() => cache?.runner.end() ?? Promise.resolve(), E.toError)),
        TE.chain(() =>
            TE.tryCatch(() => {
                return cache?.server.pg.stop() ?? Promise.resolve();
            }, E.toError)
        )
    );
}

runAsWorker(async (params: WorkerParams) => {
    const result = await handler(params);
    return J.stringify(result);
});
