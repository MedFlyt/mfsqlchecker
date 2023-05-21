import path from "path";
import ts from "typescript";
import { Either } from "./either";
import { ErrorDiagnostic, fileLineCol, nodeErrorDiagnostic } from "./ErrorDiagnostic";
import { escapeIdentifier } from "./pg_extra";
import { identifierImportedFrom, ModuleId } from "./ts_extra";
import { calcViewName } from "./view_names";
import * as E from "fp-ts/Either";
import {pipe} from "fp-ts/function";
import assertNever from "assert-never";

function viewNameLength(varName: string | null): number {
    return escapeIdentifier(calcViewName(varName, "")).length;
}

export function resolveViewIdentifier(projectDir: string, sourceFile: ts.SourceFile, ident: ts.Identifier): QualifiedSqlViewName {
    const importedFromModule = identifierImportedFrom(sourceFile, ident);
    if (importedFromModule !== null) {
        return QualifiedSqlViewName.create(importedModuleName(projectDir, sourceFile, importedFromModule), ident.text);
    } else {
        // TODO Validate that the referenced view was actually
        // defined in the current file. For now we just assume that
        // it was
        return QualifiedSqlViewName.create(sourceFileModuleName(projectDir, sourceFile), ident.text);
    }
}

export class SqlViewDefinition {
    static parseFromTemplateExpression(projectDir: string, sourceFile: ts.SourceFile, checker: ts.TypeChecker, varName: string | null, node: ts.TemplateLiteral): Either<ErrorDiagnostic, SqlViewDefinition> {
        if (ts.isNoSubstitutionTemplateLiteral(node)) {
            const sourceMap: [number, number, number][] = [[node.end - node.text.length, 0, node.text.length]];
            return {
                type: "Right",
                value: new SqlViewDefinition(sourceFile.fileName, sourceFile.text, varName, [{ type: "StringFragment", text: node.text }], sourceMap)
            };
        } else if (ts.isTemplateExpression(node)) {
            const sourceMap: [number, number, number][] = [];

            const fragments: SqlViewDefinition.Fragment[] = [];
            fragments.push({ type: "StringFragment", text: node.head.text });

            let c = 0;

            // If there is whitespace before the opening quote (`) then "pos"
            // starts at the beginning of the whitespace (so we use this
            // formula to guarantee that we get the position of the start of
            // the opening quote (`) char)
            sourceMap.push([node.head.end - node.head.text.length - 1, c, c + node.head.text.length]);

            c += node.head.text.length;

            for (let i = 0; i < node.templateSpans.length; ++i) {
                const span = node.templateSpans[i];

                const type = checker.getTypeAtLocation(span.expression);
                const maybeSqlFrag = tryTypeSqlFrag(type);
                switch (maybeSqlFrag.type) {
                    case "Left":
                        return {
                            type: "Left",
                            value: nodeErrorDiagnostic(span, maybeSqlFrag.value)
                        };
                    case "Right":
                        if (maybeSqlFrag.value !== null) {
                            fragments.push({ type: "StringFragment", text: maybeSqlFrag.value });

                            c += maybeSqlFrag.value.length;
                        } else {
                            if (!ts.isIdentifier(span.expression)) {
                                return {
                                    type: "Left",
                                    value: nodeErrorDiagnostic(span, "defineSqlView template spans can only be identifiers (no other expressions allowed)")
                                };
                            }

                            const qualifiedSqlViewName = resolveViewIdentifier(projectDir, sourceFile, span.expression);
                            fragments.push({ type: "ViewReference", qualifiedSqlViewName: qualifiedSqlViewName });

                            c += viewNameLength(span.expression.text);
                        }
                        break;
                }

                fragments.push({ type: "StringFragment", text: span.literal.text });
                sourceMap.push([span.literal.end - span.literal.text.length -
                    (i < node.templateSpans.length - 1 ? 1 : 0) // The end of the last template span is different from the others
                    , c, c + span.literal.text.length]);

                c += span.literal.text.length;
            }

            return {
                type: "Right",
                value: new SqlViewDefinition(sourceFile.fileName, sourceFile.text, varName, fragments, sourceMap)
            };
        }
        
        assertNever(node);
    }

    isFullyResolved(): boolean {
        for (const frag of this.fragments) {
            if (frag.type === "ViewReference") {
                return false;
            }
        }

        return true;
    }

    /**
     * Only call this if `isFullyResolved` returns true
     */
    fullyResolvedQuery(): string {
        let result: string = "";
        for (const frag of this.fragments) {
            if (frag.type === "ViewReference") {
                throw new Error(`SqlViewDefinition "${frag.qualifiedSqlViewName}" is not fully resolved`);
            }
            result += frag.text;
        }
        return result;
    }

    getDependencies(): QualifiedSqlViewName[] {
        return this.dependencies;
    }

    inject(dependency: QualifiedSqlViewName, viewName: string): void {
        for (let i = 0; i < this.fragments.length; ++i) {
            const frag = this.fragments[i];
            if (frag.type === "ViewReference" && frag.qualifiedSqlViewName === dependency) {
                this.fragments[i] = { type: "StringFragment", text: escapeIdentifier(viewName) };
            }
        }
    }

    /**
     * Only call this if `isFullyResolved` returns true
     */
    getName(): string {
        if (this.viewName === null) {
            this.viewName = calcViewName(this.varName, this.fullyResolvedQuery());
        }

        return this.viewName;
    }

    getFileName(): string {
        return this.fileName;
    }

    getFileContents(): string {
        return this.fileContents;
    }

    getSourceMap(): [number, number, number][] {
        return this.sourceMap;
    }

    /**
     * Call this if any of the dependencies have changed
     */
    resetToInitialFragments(): void {
        this.viewName = null;
        this.fragments = [...this.initialFragments];
    }

    isEqual(other: SqlViewDefinition): boolean {
        if (this.initialFragments.length !== other.initialFragments.length) {
            return false;
        }

        for (let i = 0; i < this.initialFragments.length; ++i) {
            if (!SqlViewDefinition.fragmentsEqual(this.initialFragments[i], other.initialFragments[i])) {
                return false;
            }
        }

        return true;
    }

    debugDump(): string {
        return `${this.varName} ${JSON.stringify(this.dependencies)} ${JSON.stringify(this.fragments)}`;
    }

    private constructor(fileName: string, fileContents: string, varName: string | null, fragments: SqlViewDefinition.Fragment[], sourceMap: [number, number, number][]) {
        this.fileName = fileName;
        this.fileContents = fileContents;
        this.sourceMap = sourceMap;
        this.varName = varName;
        this.initialFragments = fragments;
        this.fragments = [...fragments];
        this.dependencies = [];
        for (let i = 0; i < fragments.length; ++i) {
            const frag = this.fragments[i];
            if (frag.type === "ViewReference") {
                this.dependencies.push(frag.qualifiedSqlViewName);
            }
        }
    }

    private readonly fileName: string;
    private readonly fileContents: string;
    private readonly sourceMap: [number, number, number][];
    private readonly varName: string | null;
    private readonly initialFragments: SqlViewDefinition.Fragment[];
    private readonly dependencies: QualifiedSqlViewName[];

    // Mutable
    private fragments: SqlViewDefinition.Fragment[];
    private viewName: string | null = null;

    static fragmentsEqual(lhs: SqlViewDefinition.Fragment, rhs: SqlViewDefinition.Fragment): boolean {
        switch (lhs.type) {
            case "StringFragment":
                return rhs.type === "StringFragment" && lhs.text === rhs.text;
            case "ViewReference":
                return rhs.type === "ViewReference" && lhs.qualifiedSqlViewName === rhs.qualifiedSqlViewName;
        }
    }
}

namespace SqlViewDefinition {
    export type Fragment
        = { readonly type: "StringFragment"; readonly text: string }
        | { readonly type: "ViewReference"; readonly qualifiedSqlViewName: QualifiedSqlViewName };
}

export interface SqlCreateView {
    readonly qualifiedViewname: QualifiedSqlViewName;
    readonly viewName: string;
    readonly createQuery: string;
    readonly fileName: string;
    readonly fileContents: string;
    readonly sourceMap: [number, number, number][];
}

function fullyResolveSqlViewDefinition(v: SqlViewDefinition, myName: QualifiedSqlViewName, library: Map<QualifiedSqlViewName, SqlViewDefinition>): ErrorDiagnostic[] {
    if (v.isFullyResolved()) {
        return [];
    }

    for (const depName of v.getDependencies()) {
        // Make sure we don't get stuck in infinite recursion!
        if (depName === myName) {
            return [{
                fileName: v.getFileName(),
                fileContents: v.getFileContents(),
                span: fileLineCol(v.getFileContents(), v.getSourceMap()[0][0]),
                messages: [`View depends on itself: "${QualifiedSqlViewName.viewName(myName)}"`],
                epilogue: null,
                quickFix: null
            }];
        }

        const dep = library.get(depName);
        if (dep === undefined) {
            return [{
                fileName: v.getFileName(),
                fileContents: v.getFileContents(),
                span: fileLineCol(v.getFileContents(), v.getSourceMap()[0][0]),
                messages: [`Missing dependency in view "${QualifiedSqlViewName.viewName(myName)}": "${QualifiedSqlViewName.viewName(depName)}" (from module "${QualifiedSqlViewName.moduleId(depName)}"`],
                epilogue: null,
                quickFix: null
            }];
        }
        if (!dep.isFullyResolved()) {
            fullyResolveSqlViewDefinition(dep, depName, library);
        }
        v.inject(depName, dep.getName());
    }

    return [];
}

type FileName = string;

export function resolveAllViewDefinitions(library: Map<QualifiedSqlViewName, SqlViewDefinition>): [Map<FileName, SqlCreateView[]>, ErrorDiagnostic[]] {
    let errorDiagnostics: ErrorDiagnostic[] = [];

    // Fully resolve all of the views (using the above recursive algorithm)

    library.forEach((value, key) => {
        const errors = fullyResolveSqlViewDefinition(value, key, library);
        errorDiagnostics = errorDiagnostics.concat(errors);
    });

    // Topological sort of the views, so that they are created in
    // reverse-dependency order (otherwise we will get an error if we try to
    // create a view before its dependencies have been created)

    const result: Map<string, SqlCreateView[]> = new Map();
    const added = new Set<QualifiedSqlViewName>();

    function addView(name: QualifiedSqlViewName, view: SqlViewDefinition) {
        if (added.has(name)) {
            return;
        }

        for (const depName of view.getDependencies()) {
            const dep = library.get(depName);
            if (dep === undefined) {
                // This should never happen, because the dependencies were
                // already correctly resolved in the previous step
                throw new Error(`The Impossible happened: Missing dependency in view ${name}: ${depName}`);
            }

            addView(depName, dep);
        }

        if (!result.has(view.getFileName())) {
            result.set(view.getFileName(), []);
        }
        
        result.get(view.getFileName())?.push({
            qualifiedViewname: name,
            viewName: view.getName(),
            createQuery: view.fullyResolvedQuery(),
            fileName: view.getFileName(),
            fileContents: view.getFileContents(),
            sourceMap: view.getSourceMap()
        });

        added.add(name);
    }

    library.forEach((value, key) => {
        if (value.isFullyResolved()) {
            addView(key, value);
        }
    });

    return [result, errorDiagnostics];
}

/**
 * Pair of ModuleId + string
 */
export class QualifiedSqlViewName {
    static create(moduleId: ModuleId, viewName: string): QualifiedSqlViewName {
        return (moduleId + " " + viewName) as any;
    }

    static moduleId(val: QualifiedSqlViewName): ModuleId {
        return (val as any).split(" ")[0];
    }

    static viewName(val: QualifiedSqlViewName): string {
        return (val as any).split(" ")[1];
    }

    protected _dummy: QualifiedSqlViewName[];
}

export function sourceFileModuleName(projectDir: string, sourceFile: ts.SourceFile): ModuleId {
    const relFile = path.relative(projectDir, sourceFile.fileName);

    // Strip the ".ts" extension (TODO This should be done more robustly)
    const modName = relFile.slice(0, -3);
    return ModuleId.wrap(modName);
}

function importedModuleName(projectDir: string, sourceFile: ts.SourceFile, importedModule: string): ModuleId {
    return ModuleId.wrap(path.join(path.dirname(ModuleId.unwrap(sourceFileModuleName(projectDir, sourceFile))), importedModule));
}

/**
 * @returns `null` if the type is not an SqlFrag<T>
 */
export function tryTypeSqlFrag(type: ts.Type): Either<string, string | null> {
    // TODO This should be more robust: make sure that it is the "SqlFrag" (or
    // "SqlFragAuth") type defined in the sql library (and not some other
    // user-defined type that happens to have the same name)

    const symbol: ts.Symbol | undefined = <ts.Symbol | undefined>type.symbol;
    if (symbol === undefined) {
        return {
            type: "Right",
            value: null
        };
    }

    if (symbol.name === "SqlFrag") {
        const typeArguments = (<any>type).typeArguments;
        if (Array.isArray(typeArguments)) {
            if (typeArguments.length === 1) {
                if (typeArguments[0].flags === ts.TypeFlags.String) {
                    return {
                        type: "Left",
                        value: "Invalid call to `sqlFrag`: argument must be a String Literal (not a dynamic string)"
                    };
                } else if (typeArguments[0].flags === ts.TypeFlags.StringLiteral) {
                    if (typeof typeArguments[0].value === "string") {
                        return {
                            type: "Right",
                            value: typeArguments[0].value
                        };
                    }
                }
            }
        }
    }

    if (symbol.name === "SqlFragAuth") {
        const typeArguments = (<any>type).typeArguments;
        if (Array.isArray(typeArguments)) {
            if (typeArguments.length === 2) {
                if (typeArguments[0].flags === ts.TypeFlags.String) {
                    return {
                        type: "Left",
                        value: "Invalid call to `sqlFragAuth`: argument must be a String Literal (not a dynamic string)"
                    };
                } else if (typeArguments[0].flags === ts.TypeFlags.StringLiteral) {
                    if (typeof typeArguments[0].value === "string") {
                        return {
                            type: "Right",
                            value: typeArguments[0].value
                        };
                    }
                }
            }
        }
    }

    return {
        type: "Right",
        value: null
    };
}

export function isSqlViewDefinition(checker: ts.TypeChecker, decl: ts.VariableDeclaration): boolean {
    const name = checker.getTypeAtLocation(decl).symbol.name;

    // TODO This should be more robust: make sure that it is the "SqlView" type
    // defined in the sql library (and not some other user-defined type that
    // happens to have the same name)

    return name === "SqlView";
}

export function getSqlDefinitionE(params: {
    projectDir: string;
    sf: ts.SourceFile;
    checker: ts.TypeChecker;
    node: ts.Node;
}): undefined | E.Either<ErrorDiagnostic, {
    viewName: string;
    qualifiedSqlViewName: QualifiedSqlViewName;
    sqlViewDefinition: SqlViewDefinition;
}> {
    const { projectDir, sf, checker, node } = params;

    if (!ts.isVariableStatement(node)) {
        return;
    }

    for (const decl of node.declarationList.declarations) {
        if (decl.initializer === undefined || !ts.isTaggedTemplateExpression(decl.initializer)) {
            return;
        }

        if (!ts.isIdentifier(decl.initializer.tag) || !isSqlViewDefinition(checker, decl) || !ts.isIdentifier(decl.name)) {
            return;
        }

        if ((node.declarationList.flags & ts.NodeFlags.Const) === 0) {
            return E.left(nodeErrorDiagnostic(decl.name, "defineSqlView assigned to a non-const variable"));
        }
        
        const viewName = decl.name.text;
        const qualifiedSqlViewName = QualifiedSqlViewName.create(sourceFileModuleName(projectDir, sf), viewName);
        const sqlViewDefinition = SqlViewDefinition.parseFromTemplateExpression(projectDir, sf, checker, viewName, decl.initializer.template);

        switch (sqlViewDefinition.type) {
            case "Left":
                return E.left(sqlViewDefinition.value);
            case "Right":
                return E.right({
                    viewName: viewName,
                    qualifiedSqlViewName: qualifiedSqlViewName,
                    sqlViewDefinition: sqlViewDefinition.value
                })
        }
    }

    return;
}

export function sqlViewsLibraryAddFromSourceFile(projectDir: string, checker: ts.TypeChecker, sourceFile: ts.SourceFile): [Map<QualifiedSqlViewName, SqlViewDefinition>, ErrorDiagnostic[]] {
    const viewLibrary = new Map<QualifiedSqlViewName, SqlViewDefinition>();
    const errorDiagnostics: ErrorDiagnostic[] = [];

    function visit(sf: ts.SourceFile, node: ts.Node) {
        const sqlDefinitionE = getSqlDefinitionE({ projectDir, sf, checker, node });

        if (sqlDefinitionE !== undefined) {
            pipe(
                sqlDefinitionE,
                E.match(
                    (diagnostic) => {
                        errorDiagnostics.push(diagnostic);
                    },
                    ({ sqlViewDefinition, qualifiedSqlViewName }) => {
                        viewLibrary.set(qualifiedSqlViewName, sqlViewDefinition);
                    }
                )
            );
        }
    }

    ts.forEachChild(sourceFile, (node: ts.Node) => visit(sourceFile, node));

    return [viewLibrary, errorDiagnostics];
}

export function sqlViewLibraryResetToInitialFragmentsIncludingDeps(viewName: QualifiedSqlViewName, viewLibrary: Map<QualifiedSqlViewName, SqlViewDefinition>): void {
    const view = viewLibrary.get(viewName);
    if (view !== undefined) {
        view.resetToInitialFragments();
        viewLibrary.forEach((value, key) => {
            if (value.getDependencies().indexOf(viewName) >= 0) {
                // Make sure we don't get stuck in infinite recursion!
                if (key !== viewName) {
                    sqlViewLibraryResetToInitialFragmentsIncludingDeps(key, viewLibrary);
                }
            }
        });
    }
}
