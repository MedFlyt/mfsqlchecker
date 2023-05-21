import "source-map-support/register";
import * as E from "fp-ts/Either";
import ts from "typescript";
import { ErrorDiagnostic } from "./ErrorDiagnostic";
import {
    QualifiedSqlViewName,
    resolveAllViewDefinitions,
    sourceFileModuleName,
    SqlCreateView,
    SqlViewDefinition,
    sqlViewLibraryResetToInitialFragmentsIncludingDeps,
    sqlViewsLibraryAddFromSourceFile
} from "./views";

type FileName = string;

export function getSqlViews(params: {
    projectDir: string;
    program: ts.Program;
    checker: ts.TypeChecker;
    sourceFiles: string[];
}): E.Either<
    ErrorDiagnostic[],
    {
        viewLibrary: Map<QualifiedSqlViewName, SqlViewDefinition>;
        sqlViews: Map<FileName, SqlCreateView[]>;
    }
> {
    const { projectDir, program, checker, sourceFiles } = params;
    const viewLibrary: Map<QualifiedSqlViewName, SqlViewDefinition> = new Map();
    const progSourceFiles = program.getSourceFiles().filter((s) => !s.isDeclarationFile);

    let errorDiagnostics: ErrorDiagnostic[] = [];

    for (const sourceFile of sourceFiles) {
        const sf = progSourceFiles.find((s) => s.fileName === sourceFile);
        if (sf === undefined) {
            throw new Error("SourceFile not found: " + sourceFile);
        }
        const [views, errs] = sqlViewsLibraryAddFromSourceFile(projectDir, checker, sf);
        errorDiagnostics = errorDiagnostics.concat(errs);
        for (const key of viewLibrary.keys()) {
            if (QualifiedSqlViewName.moduleId(key) === sourceFileModuleName(projectDir, sf)) {
                const newView = views.get(key);
                if (newView === undefined) {
                    viewLibrary.delete(key);
                } else {
                    const oldView = viewLibrary.get(key);
                    if (oldView === undefined) {
                        throw new Error("The Impossible Happened");
                    }
                    if (!oldView.isEqual(newView)) {
                        viewLibrary.set(key, newView);
                        sqlViewLibraryResetToInitialFragmentsIncludingDeps(key, viewLibrary);
                    }
                }
            }
        }
        views.forEach((value, key) => {
            if (!viewLibrary.has(key)) {
                viewLibrary.set(key, value);
            }
        });
    }

    const [sqlViews, viewErrors] = resolveAllViewDefinitions(viewLibrary);
    errorDiagnostics = errorDiagnostics.concat(viewErrors);

    if (errorDiagnostics.length > 0) {
        return E.left(errorDiagnostics);
    }

    return E.right({ viewLibrary, sqlViews });
}
