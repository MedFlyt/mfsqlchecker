import { assertNever } from "assert-never";
import chalk from "chalk";
import * as ts from "typescript";
import { Either } from "./either";
import { ErrorDiagnostic, nodeErrorDiagnostic, SrcSpan } from "./ErrorDiagnostic";
import { QualifiedSqlViewName, resolveViewIdentifier } from "./views";


export interface QueryCallExpression {
    readonly fileName: string;
    readonly fileContents: string;
    readonly typeArgument: ts.TypeNode | null;
    readonly typeArgumentSpan: SrcSpan;
    readonly queryFragments: QueryCallExpression.QueryFragment[];
}

export namespace QueryCallExpression {
    export type QueryFragment
        = { readonly type: "StringFragment"; readonly text: string; readonly sourcePosStart: number }
        | { readonly type: "Expression"; readonly exp: ts.Expression };
}

export interface ResolvedQuery {
    readonly fileName: string;
    readonly fileContents: string;

    readonly text: string;

    readonly sourceMap: [number, number][];

    /**
     * `null` means that the typeArgument was explicitly declared as `any`
     * indicating that we are requested not to type-check the return column
     * types
     */
    readonly colTypes: Map<string, [ColNullability, TypeScriptType]> | null;

    readonly colTypeSpan: SrcSpan;

    /**
     * Errors that were discovered that should be reported
     */
    readonly errors: ErrorDiagnostic[];
}

/**
 * Expects a node that looks something like this:
 *
 *     query<{name: string}>(conn, sql`SELECT age FROM person WHERE id = ${theId}`);
 *
 * @param node Must be a call expression to the "query" function (from the sql
 * checker lib)
 */
function buildQueryCallExpression(node: ts.CallExpression): QueryCallExpression | null {
    // TODO This function should return an error instead of null (so that we
    // catch invalid uses of "query" that still happen to compile, ex. passing
    // "sql" through stored variable)

    const typeArgument: ts.TypeNode | null =
        node.typeArguments === undefined || node.typeArguments.length === 0
            ? null
            : node.typeArguments[0];

    const typeArgumentSpan: SrcSpan = typeArgument !== null
        ? ((): SrcSpan => {
            const sourceFile = typeArgument.getSourceFile();
            const start = sourceFile.getLineAndCharacterOfPosition(typeArgument.pos);
            const end = sourceFile.getLineAndCharacterOfPosition(typeArgument.end);
            return {
                type: "LineAndColRange",
                startLine: start.line + 1,
                startCol: start.character + 1,
                endLine: end.line + 1,
                endCol: end.character + 1
            };
        })()
        : ((): SrcSpan => {
            const sourceFile = node.expression.getSourceFile();
            const loc = sourceFile.getLineAndCharacterOfPosition(node.expression.end);
            return {
                type: "LineAndCol",
                line: loc.line + 1,
                col: loc.character + 1
            };
        })();

    if (node.arguments.length < 1) {
        return null;
    }

    const sqlExp: ts.Expression = node.arguments[0];
    if (!ts.isTaggedTemplateExpression(sqlExp)) {
        return null;
    }

    // if (!ts.isIdentifier(sqlExp.tag)) {
    //     return null;
    // }

    // if (!isIdentifierFromModule(sqlExp.tag, "sql", "./lib/sql_linter")) {
    //     return null;
    // }

    const sourceFile = node.getSourceFile();

    if (ts.isNoSubstitutionTemplateLiteral(sqlExp.template)) {
        return {
            fileName: sourceFile.fileName,
            fileContents: sourceFile.text,
            typeArgument: typeArgument,
            typeArgumentSpan: typeArgumentSpan,
            queryFragments: [{
                type: "StringFragment",
                text: sqlExp.template.text,
                sourcePosStart: sqlExp.template.pos
            }]
        };
    } else if (ts.isTemplateExpression(sqlExp.template)) {
        const fragments: QueryCallExpression.QueryFragment[] = [];
        fragments.push({
            type: "StringFragment",
            text: sqlExp.template.head.text,
            // If there is whitespace before the opening quote (`) then "pos"
            // starts at the beginning of the whitespace (so we use this
            // formula to guarantee that we get the position of the start of
            // the opening quote (`) char)
            sourcePosStart: sqlExp.template.head.end - sqlExp.template.head.text.length - 3
        });

        for (const span of sqlExp.template.templateSpans) {
            fragments.push({ type: "Expression", exp: span.expression });
            fragments.push({
                type: "StringFragment",
                text: span.literal.text,
                sourcePosStart: span.literal.pos
            });
        }

        return {
            fileName: sourceFile.fileName,
            fileContents: sourceFile.text,
            typeArgument: typeArgument,
            typeArgumentSpan: typeArgumentSpan,
            queryFragments: fragments
        };
    } else {
        return assertNever(sqlExp.template);
    }
}

export function findAllQueryCalls(checker: ts.TypeChecker, sourceFile: ts.SourceFile): QueryCallExpression[] {
    const result: QueryCallExpression[] = [];

    const queryMethodNames = ["query", "queryOne", "queryOneOrNone"];

    function visit(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            if (ts.isPropertyAccessExpression(node.expression)) {
                if (ts.isIdentifier(node.expression.name)) {
                    if (queryMethodNames.indexOf(node.expression.name.text) >= 0) {
                        const type = checker.getTypeAtLocation(node.expression.expression);
                        if (type.getProperty("MfConnectionTypeTag") !== undefined) {
                            const query = buildQueryCallExpression(node);
                            if (query !== null) {
                                result.push(query);
                            }
                        }
                    }
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    ts.forEachChild(sourceFile, visit);

    return result;
}

function isTypeSqlView(type: ts.Type): boolean {
    // TODO This should be more robust: make sure that it is the "SqlView"
    // type defined in the sql library (and not some other user-defined type
    // that happens to have the same name)

    const symbol: ts.Symbol | undefined = <ts.Symbol | undefined>type.symbol;

    if (symbol === undefined) {
        return false;
    }
    return symbol.name === "SqlView";
}

/**
 * Convert a type of the form `(T | null)` -> `T`
 *
 * Returns the original type if it is not of that exact form.
 */
export function nonNullType(type: ts.Type): ts.Type {
    if (!type.isUnion()) {
        return type;
    }

    // We can only handle a holy union of exactly two types.
    if (type.types.length !== 2) {
        return type;
    }

    // Check which of the sides is `null` (if any), and return the other side
    if (type.types[0].flags === ts.TypeFlags.Null) {
        return type.types[1];
    } else if (type.types[1].flags === ts.TypeFlags.Null) {
        return type.types[0];
    } else {
        return type;
    }
}

export class TypeScriptType {
    static wrap(val: string): TypeScriptType {
        return val as any;
    }

    static unwrap(val: TypeScriptType): string {
        return val as any;
    }

    protected _dummy: TypeScriptType[];
}

export class SqlType {
    static wrap(val: string): SqlType {
        return val as any;
    }

    static unwrap(val: SqlType): string {
        return val as any;
    }

    protected _dummy: SqlType[];
}

export const enum ColNullability {
    REQ,
    OPT
}

function getArrayType(type: ts.Type): ts.Type | null {
    if (type.symbol.name === "Array") {
        if ((<any>type).typeArguments !== undefined) {
            const typeArguments: ReadonlyArray<ts.Type> = (<any>type).typeArguments;
            if (typeArguments.length === 1) {
                return typeArguments[0];
            }
        }
    }

    return null;
}

/**
 * Checks if the type is something like: "Yes" | "No" | "Maybe"
 */
function isUnionOfStringLiterals(type: ts.Type): boolean {
    if ((type.flags & ts.TypeFlags.Union) === 0) { // tslint:disable-line:no-bitwise
        return false;
    }

    const types: ReadonlyArray<ts.Type> = (<any>type).types;
    for (const unionType of types) {
        if ((unionType.flags & ts.TypeFlags.String) === 0 && (unionType.flags & ts.TypeFlags.StringLiteral) === 0) { // tslint:disable-line:no-bitwise
            return false;
        }
    }

    return true;
}

/**
 * @returns Empty string means SQL "NULL" literal. `null` means an error
 */
function typescriptTypeToSqlType(typeScriptUniqueColumnTypes: Map<TypeScriptType, SqlType>, type: ts.Type): SqlType | null {
    if (type.flags === ts.TypeFlags.Null) {
        return SqlType.wrap("");
    } else if ((type.flags & ts.TypeFlags.Never) !== 0) { // tslint:disable-line:no-bitwise
        return null;
    } else if ((type.flags & ts.TypeFlags.Boolean) !== 0 || (type.flags & ts.TypeFlags.BooleanLiteral) !== 0) { // tslint:disable-line:no-bitwise
        return SqlType.wrap("bool");
    } else if ((type.flags & ts.TypeFlags.Number) !== 0 || (type.flags & ts.TypeFlags.NumberLiteral) !== 0) { // tslint:disable-line:no-bitwise
        return SqlType.wrap("int4");
    } else if ((type.flags & ts.TypeFlags.String) !== 0 || (type.flags & ts.TypeFlags.StringLiteral) !== 0) { // tslint:disable-line:no-bitwise
        return SqlType.wrap("text");
    } else if (isUnionOfStringLiterals(type)) {
        return SqlType.wrap("text");
    }

    if ((<any>type).symbol === undefined) {
        throw new Error("TODO figure out when this happens");
    }

    const arrayType = getArrayType(type);
    if (arrayType !== null) {
        const name = typescriptTypeToSqlType(typeScriptUniqueColumnTypes, arrayType);
        if (name === null) {
            return null;
        }
        return SqlType.wrap(SqlType.unwrap(name) + "[]");
    }

    const sqlType = typeScriptUniqueColumnTypes.get(TypeScriptType.wrap(type.symbol.name));
    if (sqlType !== undefined) {
        return sqlType;
    }

    // TODO Temporary
    if (type.symbol.name === "DbJson") {
        return SqlType.wrap("jsonb");
    } else if (type.symbol.name === "Instant") {
        return SqlType.wrap("timestamptz");
    } else if (type.symbol.name === "LocalDateTime") {
        return SqlType.wrap("timestamp");
    } else if (type.symbol.name === "LocalDate") {
        return SqlType.wrap("date");
    }

    return null;
}

function readTypeScriptType(checker: ts.TypeChecker, type: ts.Type): TypeScriptType | null {
    if ((type.flags & ts.TypeFlags.Any) !== 0) { // tslint:disable-line:no-bitwise
        // TODO hm....
        return TypeScriptType.wrap("any");
    } else if ((type.flags & ts.TypeFlags.Null) !== 0) { // tslint:disable-line:no-bitwise
        return TypeScriptType.wrap("null");
    } else if ((type.flags & ts.TypeFlags.Boolean) !== 0 || (type.flags & ts.TypeFlags.BooleanLiteral) !== 0) { // tslint:disable-line:no-bitwise
        return TypeScriptType.wrap("boolean");
    } else if ((type.flags & ts.TypeFlags.Number) !== 0 || (type.flags & ts.TypeFlags.NumberLiteral) !== 0) { // tslint:disable-line:no-bitwise
        return TypeScriptType.wrap("number");
    } else if ((type.flags & ts.TypeFlags.String) !== 0 || (type.flags & ts.TypeFlags.StringLiteral) !== 0) { // tslint:disable-line:no-bitwise
        return TypeScriptType.wrap("string");
    }

    return TypeScriptType.wrap(checker.typeToString(type));
}


function getColNullability(symbol: ts.Symbol): ColNullability | null {
    // This just does a crude string comparison on the "name". It is not robst
    // because even if the name of the type is "Req" (or "Opt") it does not
    // necessarily refer to the same "Req" (or "Opt") type that we are talking
    // about.
    //
    // But this crude check is acceptable, because in the unexpected case
    // where it's referring to some other "Req" (or "Opt") type, then the
    // regular TypeScript type-checker will catch the error.
    if (symbol.name === "Req") {
        return ColNullability.REQ;
    } else if (symbol.name === "Opt") {
        return ColNullability.OPT;
    } else {
        return null;
    }
}

function typescriptRowTypeToColTypes(checker: ts.TypeChecker, typeLiteral: ts.TypeLiteralNode, errorReporter: (error: ErrorDiagnostic) => void): Map<string, [ColNullability, TypeScriptType]> {
    const results = new Map<string, [ColNullability, TypeScriptType]>();
    for (const member of typeLiteral.members) {
        if (!ts.isPropertySignature(member)) {
            errorReporter(nodeErrorDiagnostic(member, "Type argument member must be a property"));
        } else {
            if (member.type === undefined) {
                errorReporter(nodeErrorDiagnostic(member, "Property must have a type"));
            } else {
                if (!ts.isIdentifier(member.name)) {
                    errorReporter(nodeErrorDiagnostic(member, "Property name is not an identifier"));
                } else {
                    const memberType = checker.getTypeAtLocation(member.type);
                    if (memberType.flags !== ts.TypeFlags.Object) {
                        errorReporter(nodeErrorDiagnostic(member, `Invalid type for property "${member.name.text}", it must be \`Req<T>\` or \`Opt<T>\``));
                    } else {
                        const colNullability = getColNullability(memberType.symbol);
                        if (colNullability === null) {
                            errorReporter(nodeErrorDiagnostic(member, `Invalid type for property "${member.name.text}", it must be \`Req<T>\` or \`Opt<T>\``));
                        } else {
                            const typeArguments: ts.Type[] | undefined = (<any>memberType).typeArguments;
                            if (typeArguments === undefined || typeArguments.length < 1) {
                                errorReporter(nodeErrorDiagnostic(member, `Invalid type for property "${member.name.text}", it must be \`Req<T>\` or \`Opt<T>\``));
                            } else {
                                const typeArgument = typeArguments[0];
                                const type = readTypeScriptType(checker, typeArgument);
                                if (type === null) {
                                    errorReporter(nodeErrorDiagnostic(member, `Invalid type for property "${member.name.text}": ${checker.typeToString(typeArgument)}`));
                                } else {
                                    results.set(member.name.text, [colNullability, type]);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    return results;
}

export function resolveQueryFragment(typeScriptUniqueColumnTypes: Map<TypeScriptType, SqlType>, projectDir: string, checker: ts.TypeChecker, query: QueryCallExpression, lookupViewName: (qualifiedSqlViewName: QualifiedSqlViewName) => string | undefined): Either<ErrorDiagnostic[], ResolvedQuery> {
    const errors: ErrorDiagnostic[] = [];

    let text = "";
    const sourceMap: [number, number][] = [];
    let numParams = 0;
    for (const frag of query.queryFragments) {
        switch (frag.type) {
            case "StringFragment":
                sourceMap.push([text.length, frag.sourcePosStart]);
                text += frag.text;
                break;
            case "Expression":
                const type = checker.getTypeAtLocation(frag.exp);
                if (isTypeSqlView(type)) {
                    if (!ts.isIdentifier(frag.exp)) {
                        errors.push(nodeErrorDiagnostic(frag.exp, "SQL View Reference must be an identifier (not an expression)"));
                    } else {
                        const qualifiedSqlViewName = resolveViewIdentifier(projectDir, frag.exp.getSourceFile(), frag.exp);
                        const viewName = lookupViewName(qualifiedSqlViewName);
                        if (viewName === undefined) {
                            errors.push(nodeErrorDiagnostic(frag.exp, "SQL View Reference not found or has errors: \"" + chalk.bold(QualifiedSqlViewName.viewName(qualifiedSqlViewName)) + "\""));
                        } else {
                            text += '"' + viewName + '"';
                        }
                    }
                } else {
                    const sqlType = typescriptTypeToSqlType(typeScriptUniqueColumnTypes, nonNullType(type));
                    if (sqlType === null) {
                        const typeStr = checker.typeToString(type, frag.exp);
                        errors.push(nodeErrorDiagnostic(frag.exp, `Invalid type for SQL parameter: ${typeStr}`));
                    } else {
                        numParams++;
                        const sqlTypeStr = SqlType.unwrap(sqlType);

                        // Ugly hack for detecing an sql array type
                        //
                        // WRONG: "myType[]" RIGHT: "myType"[]
                        //
                        // The correct (non-hacky) way to do this is to change
                        // "SqlType" from a string to a real type with an
                        // (isArray: boolean) prop

                        const escapedSqlTypeStr = sqlTypeStr.endsWith("[]")
                            ? "\"" + sqlTypeStr.substring(0, sqlTypeStr.length - 2) + "\"[]"
                            : "\"" + sqlTypeStr + "\"";

                        text += "($" + numParams + (sqlTypeStr !== "" ? "::" + escapedSqlTypeStr : "") + ")";
                    }
                }
                break;
            default:
                assertNever(frag);
        }
    }

    if (errors.length === 0) {
        let colTypes: Map<string, [ColNullability, TypeScriptType]> | null;
        if (query.typeArgument === null) {
            // If no type argument was specified, then for our purposes it is
            // equivalent to <{}>
            colTypes = new Map<string, [ColNullability, TypeScriptType]>();
        } else {
            if (ts.isTypeLiteralNode(query.typeArgument)) {
                colTypes = typescriptRowTypeToColTypes(checker, query.typeArgument, e => errors.push(e));
                // } else if ( ... TODO handle case of `query<any>(...)` and set colTypes = null
            } else {
                // TODO We should enhance `typescriptRowTypeToSqlTypes` so
                // that it also handles interface types, type aliases, and
                // maybe also some sensible scenarios
                errors.push(nodeErrorDiagnostic(query.typeArgument, "Type argument must be a Type Literal"));
                colTypes = new Map<string, [ColNullability, TypeScriptType]>();
            }
        }

        return {
            type: "Right",
            value: {
                fileName: query.fileName,
                fileContents: query.fileContents,
                text: text,
                sourceMap: sourceMap,
                colTypes: colTypes,
                colTypeSpan: query.typeArgumentSpan,
                errors: errors
            }
        };
    } else {
        return {
            type: "Left",
            value: errors
        };
    }
}
