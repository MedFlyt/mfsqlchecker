import ts from "typescript";

/**
 * Pair of ModuleId + string
 */
export class ModuleId {
    static wrap(moduleId: string): ModuleId {
        return moduleId as any;
    }

    static unwrap(val: ModuleId): string {
        return val as any;
    }

    protected _dummy: ModuleId[];
}

export function identifierImportedFrom(sourceFile: ts.SourceFile, ident: ts.Identifier): string | null {
    let moduleSpecifierText: string | null = null;
    let foundMultiple = false;

    ts.forEachChild(sourceFile, node => {
        if (ts.isImportDeclaration(node)) {
            if (node.importClause !== undefined && node.importClause.namedBindings !== undefined) {
                if (ts.isNamedImports(node.importClause.namedBindings)) {
                    for (const elem of node.importClause.namedBindings.elements) {
                        if (elem.name.text === ident.text) {
                            if (moduleSpecifierText !== null) {
                                foundMultiple = true;
                            }
                            moduleSpecifierText = (<ts.StringLiteral>node.moduleSpecifier).text;
                        }
                    }
                }
            }
        }
    });

    if (foundMultiple) {
        return null;
    } else {
        return moduleSpecifierText;
    }
}
