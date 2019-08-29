import { assertNever } from "assert-never";
import * as path from "path";
import * as ts from "typescript";
import { Either } from "./either";
import { ErrorDiagnostic, nodeErrorDiagnostic } from "./ErrorDiagnostic";
import { identifierImportedFrom, isIdentifierFromModule, ModuleId } from "./ts_extra";
import { calcViewName } from "./view_names";

function viewNameLength(varName: string | null): number {
    return calcViewName(varName, "").length;
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
    static parseFromTemplateExpression(projectDir: string, sourceFile: ts.SourceFile, varName: string | null, node: ts.TemplateLiteral): Either<ErrorDiagnostic, SqlViewDefinition> {
        if (ts.isNoSubstitutionTemplateLiteral(node)) {
            const sourceMap: [number, number][] = [[0, node.pos]];
            return {
                type: "Right",
                value: new SqlViewDefinition(sourceFile.fileName, sourceFile.text, varName, [{ type: "StringFragment", text: node.text }], sourceMap)
            };
        } else if (ts.isTemplateExpression(node)) {
            const sourceMap: [number, number][] = [];

            const fragments: SqlViewDefinition.Fragment[] = [];
            fragments.push({ type: "StringFragment", text: node.head.text });

            let c = 0;

            // If there is whitespace before the opening quote (`) then "pos"
            // starts at the beginning of the whitespace (so we use this
            // formula to guarantee that we get the position of the start of
            // the opening quote (`) char)
            sourceMap.push([c, node.head.end - node.head.text.length - 3]);

            c += node.head.text.length;

            for (const span of node.templateSpans) {
                if (!ts.isIdentifier(span.expression)) {
                    return {
                        type: "Left",
                        value: nodeErrorDiagnostic(span, "defineSqlView template spans can only be identifiers (no other expressions allowed)")
                    };
                }

                const qualifiedSqlViewName = resolveViewIdentifier(projectDir, sourceFile, span.expression);
                fragments.push({ type: "ViewReference", qualifiedSqlViewName: qualifiedSqlViewName });

                c += viewNameLength(span.expression.text);

                fragments.push({ type: "StringFragment", text: span.literal.text });
                sourceMap.push([c, span.literal.pos]);

                c += span.literal.text.length;
            }

            return {
                type: "Right",
                value: new SqlViewDefinition(sourceFile.fileName, sourceFile.text, varName, fragments, sourceMap)
            };
        } else {
            return assertNever(node);
        }
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
                throw new Error("SqlViewDefinition is not fully resolved");
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
                this.fragments[i] = { type: "StringFragment", text: "\"" + viewName + "\"" };
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

    getSourceMap(): [number, number][] {
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

    private constructor(fileName: string, fileContents: string, varName: string | null, fragments: SqlViewDefinition.Fragment[], sourceMap: [number, number][]) {
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
    private readonly sourceMap: [number, number][];
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
            default:
                return assertNever(lhs);
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
    readonly sourceMap: [number, number][];
}

function fullyResolveSqlViewDefinition(v: SqlViewDefinition, myName: QualifiedSqlViewName, library: Map<QualifiedSqlViewName, SqlViewDefinition>): void {
    if (v.isFullyResolved()) {
        return;
    }

    for (const depName of v.getDependencies()) {
        // Make sure we don't get stuck in infinite recursion!
        if (depName === myName) {
            throw new Error(`View depends on itself: ${myName}`);
        }

        const dep = library.get(depName);
        if (dep === undefined) {
            throw new Error(`Missing dependency in view ${myName}: ${depName}`);
        }
        if (!dep.isFullyResolved()) {
            fullyResolveSqlViewDefinition(dep, depName, library);
        }
        v.inject(depName, dep.getName());
    }
}

export function resolveAllViewDefinitions(library: Map<QualifiedSqlViewName, SqlViewDefinition>): SqlCreateView[] {
    // Fully resolve all of the views (using the above recursive algorithm)

    library.forEach((value, key) => {
        fullyResolveSqlViewDefinition(value, key, library);
    });

    // Topological sort of the views, so that they are created in
    // reverse-dependency order (otherwise we will get an error if we try to
    // create a view before its dependencies have been created)

    const result: SqlCreateView[] = [];
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

        result.push({
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
        addView(key, value);
    });

    // Sanity check
    if (result.length !== library.size) {
        throw new Error(`The Impossible Happened: ${result.length} != ${library.size}`);
    }

    return result;
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

export class ValidationError extends Error {
    constructor(sourceFile: ts.SourceFile, node: ts.Node, public readonly message: string) {
        super(message);

        this.filename = sourceFile.fileName;
        this.loc = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
    }

    public readonly filename: string;
    public readonly loc: ts.LineAndCharacter;
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

export function sqlViewsLibraryAddFromSourceFile(projectDir: string, sourceFile: ts.SourceFile): Map<QualifiedSqlViewName, SqlViewDefinition> {
    const viewLibrary = new Map<QualifiedSqlViewName, SqlViewDefinition>();

    function visit(sf: ts.SourceFile, node: ts.Node) {
        if (ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (decl.initializer !== undefined) {
                    if (ts.isTaggedTemplateExpression(decl.initializer)) {
                        if (ts.isIdentifier(decl.initializer.tag) && isIdentifierFromModule(decl.initializer.tag, "defineSqlView", "./lib/sql_linter")) {
                            if (!ts.isIdentifier(decl.name)) {
                                throw new ValidationError(sf, decl.name, "defineSqlView not assigned to a variable");
                            }
                            // tslint:disable-next-line:no-bitwise
                            if ((node.declarationList.flags & ts.NodeFlags.Const) === 0) {
                                throw new ValidationError(sf, decl.name, "defineSqlView assigned to a non-const variable");
                            }
                            const viewName = decl.name.text;
                            const qualifiedSqlViewName = QualifiedSqlViewName.create(sourceFileModuleName(projectDir, sf), viewName);
                            const sqlViewDefinition = SqlViewDefinition.parseFromTemplateExpression(projectDir, sf, viewName, decl.initializer.template);
                            switch (sqlViewDefinition.type) {
                                case "Left":
                                    throw new ValidationError(sf, decl.name, "TODO XXXX");
                                case "Right":
                                    viewLibrary.set(qualifiedSqlViewName, sqlViewDefinition.value);
                                    break;
                                default:
                                    assertNever(sqlViewDefinition);
                            }
                        }
                    }
                }
            }
        }
    }

    ts.forEachChild(sourceFile, (node: ts.Node) => visit(sourceFile, node));

    return viewLibrary;
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
