import "source-map-support/register"; // tslint:disable-line:no-import-side-effect

import { assertNever } from "assert-never";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { loadConfigFile, sqlUniqueTypeName, UniqueTableColumnType } from "./ConfigFile";
import { DbConnector } from "./DbConnector";
import { ErrorDiagnostic } from "./ErrorDiagnostic";
import { findAllQueryCalls, QueryCallExpression, resolveQueryFragment, SqlType, TypeScriptType } from "./queries";
import { QualifiedSqlViewName, resolveAllViewDefinitions, sourceFileModuleName, SqlViewDefinition, sqlViewLibraryResetToInitialFragmentsIncludingDeps, sqlViewsLibraryAddFromSourceFile } from "./views";

export class SqlCheckerEngine {
    constructor(private readonly configFileName: string | null, private readonly dbConnector: DbConnector) {
        this.viewLibrary = new Map<QualifiedSqlViewName, SqlViewDefinition>();
    }

    viewLibrary: Map<QualifiedSqlViewName, SqlViewDefinition>;

    checkChangedSourceFiles(projectDir: string, program: ts.Program, checker: ts.TypeChecker, sourceFiles: string[]): Promise<ErrorDiagnostic[]> {
        const progSourceFiles = program.getSourceFiles().filter(s => !s.isDeclarationFile);

        for (const sourceFile of sourceFiles) {
            const sf = progSourceFiles.find(s => s.fileName === sourceFile);
            if (sf === undefined) {
                throw new Error("SourceFile not found: " + sourceFile);
            }
            const views = sqlViewsLibraryAddFromSourceFile(projectDir, sf);
            for (const key of this.viewLibrary.keys()) {
                if (QualifiedSqlViewName.moduleId(key) === sourceFileModuleName(projectDir, sf)) {
                    const newView = views.get(key);
                    if (newView === undefined) {
                        this.viewLibrary.delete(key);
                    } else {
                        const oldView = this.viewLibrary.get(key);
                        if (oldView === undefined) {
                            throw new Error("The Impossible Happened");
                        }
                        if (!oldView.isEqual(newView)) {
                            this.viewLibrary.set(key, newView);
                            sqlViewLibraryResetToInitialFragmentsIncludingDeps(key, this.viewLibrary);
                        }
                    }
                }
            }
            views.forEach((value, key) => {
                if (!this.viewLibrary.has(key)) {
                    this.viewLibrary.set(key, value);
                }
            });
        }

        const sqlViews = resolveAllViewDefinitions(this.viewLibrary);

        let errorDiagnostics: ErrorDiagnostic[] = [];

        let queries: QueryCallExpression[] = [];
        for (const sourceFile of progSourceFiles) {
            const [es, qs] = findAllQueryCalls(checker, sourceFile);
            queries = queries.concat(es);
            errorDiagnostics = errorDiagnostics.concat(qs);
        }

        const lookupViewName = (qualifiedSqlViewName: QualifiedSqlViewName): string | undefined => {
            const v = this.viewLibrary.get(qualifiedSqlViewName);
            if (v === undefined) {
                return undefined;
            }
            return v.getName();
        };

        let uniqueTableColumnTypes: UniqueTableColumnType[] = [];

        if (this.configFileName !== null) {
            const config = loadConfigFile(this.configFileName);
            switch (config.type) {
                case "Left":
                    return Promise.resolve<ErrorDiagnostic[]>([config.value]);
                case "Right":
                    if (config.value.uniqueTableColumnTypes !== undefined) {
                        uniqueTableColumnTypes = config.value.uniqueTableColumnTypes;
                    }
                    break;
                default:
                    return assertNever(config);
            }
        }

        const typeScriptUniqueColumnTypes = new Map<TypeScriptType, SqlType>();
        for (const uniqueTableColumnType of uniqueTableColumnTypes) {
            typeScriptUniqueColumnTypes.set(uniqueTableColumnType.typeScriptTypeName, SqlType.wrap(sqlUniqueTypeName(uniqueTableColumnType.tableName, uniqueTableColumnType.columnName)));
        }

        const resolvedQueries = queries.map(q => resolveQueryFragment(typeScriptUniqueColumnTypes, projectDir, checker, q, lookupViewName));

        return this.dbConnector.validateManifest({
            queries: resolvedQueries,
            viewLibrary: sqlViews,
            uniqueTableColumnTypes: uniqueTableColumnTypes
        }).then(errs => {
            return errorDiagnostics.concat(errs);
        });
    }
}

/**
 * @returns true if there no errors were detected
 */
export async function typeScriptSingleRunCheck(projectDir: string, observer: SqlCheckerEngine, formatter: (errorDiagnostics: ErrorDiagnostic[]) => string): Promise<boolean> {
    const configPath = ts.findConfigFile(
        /*searchPath*/ projectDir,
        ts.sys.fileExists, // tslint:disable-line:no-unbound-method
        "tsconfig.json"
    );

    if (configPath === undefined) {
        throw new Error("Could not find a valid 'tsconfig.json'.");
    }

    // tslint:disable-next-line:no-unbound-method
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error !== undefined) {
        throw new Error(ts.formatDiagnostics([config.error], {
            getCanonicalFileName: f => f,
            getCurrentDirectory: process.cwd, // tslint:disable-line:no-unbound-method
            getNewLine: () => "\n"
        }));
    }

    const parseConfigHost: ts.ParseConfigHost = {
        fileExists: fs.existsSync,
        readDirectory: ts.sys.readDirectory, // tslint:disable-line:no-unbound-method
        readFile: file => fs.readFileSync(file, "utf8"),
        useCaseSensitiveFileNames: true
    };

    const parsed = ts.parseJsonConfigFileContent(config.config, parseConfigHost, path.resolve(projectDir));

    if (<any>parsed.errors !== undefined) {
        // ignore warnings and 'TS18003: No inputs were found in config file ...'
        const errors = parsed.errors.filter(
            d => d.category === ts.DiagnosticCategory.Error && d.code !== 18003
        );
        if (errors.length !== 0) {
            throw new Error(
                ts.formatDiagnostics(errors, {
                    getCanonicalFileName: f => f,
                    getCurrentDirectory: process.cwd, // tslint:disable-line:no-unbound-method
                    getNewLine: () => "\n"
                })
            );
        }
    }
    const host = ts.createCompilerHost(parsed.options, true);
    const program = ts.createProgram(parsed.fileNames, parsed.options, host);

    const progSourceFiles = program.getSourceFiles().filter(s => !s.isDeclarationFile);

    const errors = await observer.checkChangedSourceFiles(projectDir, program, program.getTypeChecker(), progSourceFiles.map(s => s.fileName));
    console.log(formatter(errors));

    return errors.length === 0;
}

export class TypeScriptWatcher {
    constructor(observer: SqlCheckerEngine, private readonly formatter: (errorDiagnostics: ErrorDiagnostic[]) => string) {
        this.observer = observer;
    }

    private readonly observer: SqlCheckerEngine;

    private changedSourceFiles: string[] = [];

    createProgram = (rootNames: ReadonlyArray<string> | undefined, options: ts.CompilerOptions | undefined, host?: ts.CompilerHost, oldProgram?: ts.EmitAndSemanticDiagnosticsBuilderProgram, configFileParsingDiagnostics?: ReadonlyArray<ts.Diagnostic>, projectReferences?: ReadonlyArray<ts.ProjectReference> | undefined): ts.EmitAndSemanticDiagnosticsBuilderProgram => {
        const b = ts.createEmitAndSemanticDiagnosticsBuilderProgram(rootNames, options, host, oldProgram, configFileParsingDiagnostics, projectReferences);

        // tslint:disable-next-line:no-unbound-method
        const origEmit = b.emit;
        b.emit = (targetSourceFile?: ts.SourceFile, writeFile?: ts.WriteFileCallback, cancellationToken?: ts.CancellationToken, emitOnlyDtsFiles?: boolean, customTransformers?: ts.CustomTransformers): ts.EmitResult => {
            const writeFile2 = (fileName: string, data: string, writeByteOrderMark: boolean, onError?: (message: string) => void, sourceFiles?: ReadonlyArray<ts.SourceFile>): void => {
                if (writeFile !== undefined) {
                    writeFile(fileName, data, writeByteOrderMark, onError, sourceFiles);
                }
            };
            const result = origEmit(targetSourceFile, writeFile2, cancellationToken, emitOnlyDtsFiles, customTransformers);
            const changedFiles: string[] = (<any>result).sourceMaps.map((s: any) => s.inputSourceFileNames);
            for (const changedFile of changedFiles) {
                // console.log("changedFile", changedFile, sourceFilenameModuleName(projectDirAbs, changedFile[0]));
                this.changedSourceFiles.push(changedFile[0]);
            }
            return result;
        };

        // tslint:disable-next-line:no-unbound-method
        const origEmitNextAffectedFile = b.emitNextAffectedFile;
        b.emitNextAffectedFile = (writeFile?: ts.WriteFileCallback, cancellationToken?: ts.CancellationToken, emitOnlyDtsFiles?: boolean, customTransformers?: ts.CustomTransformers): ts.AffectedFileResult<ts.EmitResult> => {
            const result = origEmitNextAffectedFile(writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers);
            return result;
        };
        return b;
    }

    projectDir: string;

    run(projectDir: string): void {
        this.projectDir = projectDir;

        const configPath = ts.findConfigFile(
            /*searchPath*/ projectDir,
            ts.sys.fileExists, // tslint:disable-line:no-unbound-method
            "tsconfig.json"
        );

        if (configPath === undefined) {
            throw new Error("Could not find a valid 'tsconfig.json'.");
        }

        const host = ts.createWatchCompilerHost(
            configPath,
            {},
            ts.sys,
            this.createProgram,
            this.reportDiagnostic,
            this.reportWatchStatusChanged
        );

        if (host.afterProgramCreate === undefined) {
            throw new Error("host.afterProgramCreate is undefined");
        }

        // tslint:disable-next-line:no-unbound-method
        const origPostProgramCreate = host.afterProgramCreate;

        host.afterProgramCreate = program => {
            this.builderProgram = program;
            origPostProgramCreate(program);
        };

        // `createWatchProgram` creates an initial program, watches files, and updates
        // the program over time.
        ts.createWatchProgram(host);
    }

    private builderProgram: ts.BuilderProgram | null = null;

    reportDiagnostic = (_diagnostic: ts.Diagnostic): void => {
        console.info("reportDiagnosstic");
    }

    reportWatchStatusChanged = (diagnostic: ts.Diagnostic, _newLine: string, _options: ts.CompilerOptions): void => {
        if (diagnostic.code === 6193 || diagnostic.code === 6194) {
            if (this.builderProgram === null) {
                throw new Error(`builderProgram not ready`);
            }

            const program = this.builderProgram.getProgram();
            const progSourceFiles = program.getSourceFiles().filter(s => !s.isDeclarationFile);

            const foundSourceFiles: ts.SourceFile[] = [];
            for (const sourceFile of progSourceFiles) {
                if (this.changedSourceFiles.indexOf(sourceFile.fileName) >= 0) {
                    foundSourceFiles.push(sourceFile);
                }
            }

            this.afterChange(program, foundSourceFiles);
            this.changedSourceFiles = [];
        }
    }

    afterChange = (program: ts.Program, sourceFiles: ts.SourceFile[]): void => {
        console.log("[DIAGNOSTICS START]");

        this.program = program;

        if (this.currentlyRunning) {
            for (const s of sourceFiles) {
                if (this.queuedSourceFiles.indexOf(s.fileName) < 0) {
                    this.queuedSourceFiles.push(s.fileName);
                }
            }
        } else {
            this.currentlyRunning = true;
            this.observer.checkChangedSourceFiles(this.projectDir, program, program.getTypeChecker(), sourceFiles.map(s => s.fileName)).then(this.checkerComplete);
        }
    }

    checkerComplete = (errors: ErrorDiagnostic[]): void => {
        if (this.queuedSourceFiles.length > 0) {
            if (this.program === undefined) {
                throw new Error("The Impossible Happened");
            }
            this.observer.checkChangedSourceFiles(this.projectDir, this.program, this.program.getTypeChecker(), this.queuedSourceFiles).then(this.checkerComplete);
            this.queuedSourceFiles = [];
        } else {
            this.currentlyRunning = false;

            console.log(this.formatter(errors));
            console.log("[DIAGNOSTICS END]");
        }
    }

    private currentlyRunning: boolean = false;
    private program: ts.Program | undefined = undefined;
    private queuedSourceFiles: string[] = [];
}
