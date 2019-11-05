import { assertNever } from "assert-never";
import chalk from "chalk";
import * as ts from "typescript";
import { Either } from "./either";
import { ErrorDiagnostic, nodeErrorDiagnostic, SrcSpan } from "./ErrorDiagnostic";
import { escapeIdentifier } from "./pg_extra";
import { QualifiedSqlViewName, resolveViewIdentifier } from "./views";

export interface QueryCallExpression {
    readonly fileName: string;
    readonly fileContents: string;

    /**
     * If `null` then we have a type parameter. Otherwise contains the name of
     * the method name that was called
     */
    readonly queryMethodName: string | null;

    readonly typeArgument: ts.TypeNode | null;
    readonly typeArgumentSpan: SrcSpan;
    readonly queryFragments: QueryCallExpression.QueryFragment[];
}

export namespace QueryCallExpression {
    export type QueryFragment
        = { readonly type: "StringFragment"; readonly text: string; readonly sourcePosStart: number }
        | { readonly type: "Expression"; readonly exp: ts.Expression };
}

export interface InsertManyExpression {
    readonly fileName: string;
    readonly fileContents: string;

    /**
     * If `null` then we have a type parameter. Otherwise contains the name of
     * the method name that was called
     */
    readonly queryMethodName: string | null;

    readonly typeArgument: ts.TypeNode | null;
    readonly typeArgumentSpan: SrcSpan;
    readonly tableName: string;
    readonly tableNameExprSpan: SrcSpan;
    readonly insertExprSpan: SrcSpan;
    readonly insertColumns: Map<string, [TypeScriptType, boolean]>;
    readonly epilougeFragments: QueryCallExpression.QueryFragment[];
}

export type ResolvedQuery
    = { type: "ResolvedSelect"; value: ResolvedSelect }
    | { type: "ResolvedInsert"; value: ResolvedInsert };

export interface ResolvedSelect {
    readonly fileName: string;
    readonly fileContents: string;

    readonly text: string;

    readonly sourceMap: [number, number, number][];

    /**
     * `null` means that the typeArgument was explicitly declared as `any`
     * indicating that we are requested not to type-check the return column
     * types
     */
    readonly colTypes: Map<string, [ColNullability, TypeScriptType]> | null;

    /**
     * If `null` then we have a type parameter. Otherwise contains the name of
     * the method name that was called
     */
    readonly queryMethodName: string | null;

    readonly colTypeSpan: SrcSpan;

    /**
     * Errors that were discovered that should be reported
     */
    readonly errors: ErrorDiagnostic[];
}

export interface ResolvedInsert {
    readonly fileName: string;
    readonly fileContents: string;

    readonly tableName: string;
    readonly insertColumns: Map<string, [TypeScriptType, boolean]>;

    readonly text: string;

    readonly sourceMap: [number, number, number][];

    /**
     * `null` means that the typeArgument was explicitly declared as `any`
     * indicating that we are requested not to type-check the return column
     * types
     */
    readonly colTypes: Map<string, [ColNullability, TypeScriptType]> | null;

    /**
     * If `null` then we have a type parameter. Otherwise contains the name of
     * the method name that was called
     */
    readonly queryMethodName: string | null;

    readonly colTypeSpan: SrcSpan;

    readonly tableNameExprSpan: SrcSpan;
    readonly insertExprSpan: SrcSpan;

    /**
     * Errors that were discovered that should be reported
     */
    readonly errors: ErrorDiagnostic[];
}

function buildQueryFragments(sqlExp: ts.Expression): Either<ErrorDiagnostic[], QueryCallExpression.QueryFragment[]> {
    if (!ts.isTaggedTemplateExpression(sqlExp)) {
        return {
            type: "Left",
            value: [
                nodeErrorDiagnostic(sqlExp, "Argument must be a Tagged Template Expression")
            ]
        };
    }

    // Explanation for strange sourcePosStart formula below:
    //
    // When encountering a template string literal, if there is whitespace
    // before the opening quote (`) then the "pos" starts at the beginning of
    // the whitespace. So instead of relying on "pos", we use a formula that
    // guarantees that we get the position of the start of the opening quote
    // (`) char, by going backwards from the end

    if (ts.isNoSubstitutionTemplateLiteral(sqlExp.template)) {
        return {
            type: "Right",
            value: [{
                type: "StringFragment",
                text: sqlExp.template.text,
                sourcePosStart: sqlExp.template.end - sqlExp.template.text.length
            }]
        };
    } else if (ts.isTemplateExpression(sqlExp.template)) {
        const fragments: QueryCallExpression.QueryFragment[] = [];
        fragments.push({
            type: "StringFragment",
            text: sqlExp.template.head.text,
            sourcePosStart: sqlExp.template.head.end - sqlExp.template.head.text.length - 1
        });

        for (let i = 0; i < sqlExp.template.templateSpans.length; ++i) {
            const span = sqlExp.template.templateSpans[i];
            fragments.push({ type: "Expression", exp: span.expression });
            fragments.push({
                type: "StringFragment",
                text: span.literal.text,
                sourcePosStart: span.literal.end - span.literal.text.length
                    - (i < sqlExp.template.templateSpans.length - 1 ? 1 : 0) // The end of the last template span is different from the others
            });
        }

        return {
            type: "Right",
            value: fragments
        };
    } else {
        return assertNever(sqlExp.template);
    }
}

function nodeLineAndColSpan(sourceFile: ts.SourceFile, node: ts.Node): SrcSpan.LineAndColRange {
    const start = sourceFile.getLineAndCharacterOfPosition(node.pos);
    const end = sourceFile.getLineAndCharacterOfPosition(node.end);
    return {
        type: "LineAndColRange",
        startLine: start.line + 1,
        startCol: start.character + 1,
        endLine: end.line + 1,
        endCol: end.character + 1
    };
}

function buildTypeArgumentData(sourceFile: ts.SourceFile, node: ts.CallExpression): [ts.TypeNode | null, SrcSpan] {
    if (node.typeArguments === undefined || node.typeArguments.length === 0) {
        return [null, nodeLineAndColSpan(sourceFile, (<any>node.expression).name)];
    } else {
        const start = sourceFile.getLineAndCharacterOfPosition(node.expression.end);
        const end = sourceFile.getLineAndCharacterOfPosition(node.arguments.pos - 1);

        const span: SrcSpan.LineAndColRange = {
            type: "LineAndColRange",
            startLine: start.line + 1,
            startCol: start.character + 1,
            endLine: end.line + 1,
            endCol: end.character + 1
        };

        return [node.typeArguments[0], span];
    }
}

/**
 * Expects a node that looks something like this:
 *
 *     query<{name: string}>(conn, sql`SELECT age FROM person WHERE id = ${theId}`);
 *
 * @param node Must be a call expression to the "query" function (from the sql
 * checker lib)
 */
function buildQueryCallExpression(methodName: string, node: ts.CallExpression): Either<ErrorDiagnostic[], QueryCallExpression> {
    if (node.arguments.length < 1) {
        // The TypeScript typechecker will catch this error, so we don't need
        // to emit our own error message
        return {
            type: "Left",
            value: []
        };
    }

    const sourceFile = node.getSourceFile();

    const [typeArgument, typeArgumentSpan] = buildTypeArgumentData(sourceFile, node);

    const sqlExp: ts.Expression = node.arguments[0];
    const queryFragments = buildQueryFragments(sqlExp);
    switch (queryFragments.type) {
        case "Left":
            return {
                type: "Left",
                value: queryFragments.value
            };
        case "Right":
            return {
                type: "Right",
                value: {
                    fileName: sourceFile.fileName,
                    fileContents: sourceFile.text,
                    queryMethodName: typeArgument === null ? methodName : null,
                    typeArgument: typeArgument,
                    typeArgumentSpan: typeArgumentSpan,
                    queryFragments: queryFragments.value
                }
            };
        default:
            return assertNever(queryFragments);
    }
}

function buildInsertCallExpression(checker: ts.TypeChecker, methodName: string, node: ts.CallExpression): Either<ErrorDiagnostic[], InsertManyExpression> {
    if (node.arguments.length < 2) {
        // The TypeScript typechecker will catch this error, so we don't need
        // to emit our own error message
        return {
            type: "Left",
            value: []
        };
    }

    const tableNameArg = node.arguments[0];
    if (!(ts.isStringLiteral(tableNameArg) || ts.isNoSubstitutionTemplateLiteral(tableNameArg))) {
        return {
            type: "Left",
            value: [nodeErrorDiagnostic(tableNameArg, "Argument must be a String Literal")]
        };
    }

    const valuesArg = node.arguments[1];
    const valuesType = checker.getTypeAtLocation(valuesArg);

    if (getArrayType(valuesType) !== null) {
        return {
            type: "Left",
            value: [nodeErrorDiagnostic(valuesArg, "Argument must not be an array (must be a single object)")]
        };
    }
    const valuesElemType = valuesType;

    const sourceFile = node.getSourceFile();

    const [typeArgument, typeArgumentSpan] = buildTypeArgumentData(sourceFile, node);

    let epilougeFragments: QueryCallExpression.QueryFragment[];
    if (node.arguments.length >= 3) {
        const epilougeSqlExp: ts.Expression = node.arguments[2];
        const queryFragments = buildQueryFragments(epilougeSqlExp);
        switch (queryFragments.type) {
            case "Left":
                return {
                    type: "Left",
                    value: queryFragments.value
                };
            case "Right":
                epilougeFragments = queryFragments.value;
                break;
            default:
                return assertNever(queryFragments);
        }
    } else {
        epilougeFragments = [];
    }

    const objectFieldTypes = getObjectFieldTypes(checker, valuesElemType);
    switch (objectFieldTypes.type) {
        case "Left":
            return {
                type: "Left",
                value: [nodeErrorDiagnostic(valuesArg, objectFieldTypes.value)]
            };
        case "Right":
            return {
                type: "Right",
                value: {
                    fileName: sourceFile.fileName,
                    fileContents: sourceFile.text,
                    queryMethodName: typeArgument === null ? methodName : null,
                    typeArgument: typeArgument,
                    typeArgumentSpan: typeArgumentSpan,
                    tableName: tableNameArg.text,
                    tableNameExprSpan: nodeLineAndColSpan(sourceFile, tableNameArg),
                    insertExprSpan: nodeLineAndColSpan(sourceFile, valuesArg),
                    insertColumns: objectFieldTypes.value,
                    epilougeFragments: epilougeFragments
                }
            };
        default:
            return assertNever(objectFieldTypes);
    }
}

function buildInsertManyCallExpression(checker: ts.TypeChecker, methodName: string, node: ts.CallExpression): Either<ErrorDiagnostic[], InsertManyExpression> {
    if (node.arguments.length < 2) {
        // The TypeScript typechecker will catch this error, so we don't need
        // to emit our own error message
        return {
            type: "Left",
            value: []
        };
    }

    const tableNameArg = node.arguments[0];
    if (!(ts.isStringLiteral(tableNameArg) || ts.isNoSubstitutionTemplateLiteral(tableNameArg))) {
        return {
            type: "Left",
            value: [nodeErrorDiagnostic(tableNameArg, "Argument must be a String Literal")]
        };
    }

    const valuesArg = node.arguments[1];
    const valuesType = checker.getTypeAtLocation(valuesArg);

    const valuesElemType = getArrayType(valuesType);

    if (valuesElemType === null) {
        // The "values" argument is not an array. The TypeScript typechecker
        // will catch this error, so we don't need to emit our own error
        // message
        return {
            type: "Left",
            value: []
        };
    }

    const sourceFile = node.getSourceFile();

    const [typeArgument, typeArgumentSpan] = buildTypeArgumentData(sourceFile, node);

    let epilougeFragments: QueryCallExpression.QueryFragment[];
    if (node.arguments.length >= 3) {
        const epilougeSqlExp: ts.Expression = node.arguments[2];
        const queryFragments = buildQueryFragments(epilougeSqlExp);
        switch (queryFragments.type) {
            case "Left":
                return {
                    type: "Left",
                    value: queryFragments.value
                };
            case "Right":
                epilougeFragments = queryFragments.value;
                break;
            default:
                return assertNever(queryFragments);
        }
    } else {
        epilougeFragments = [];
    }

    const objectFieldTypes = getObjectFieldTypes(checker, valuesElemType);
    switch (objectFieldTypes.type) {
        case "Left":
            return {
                type: "Left",
                value: [nodeErrorDiagnostic(valuesArg, objectFieldTypes.value)]
            };
        case "Right":
            return {
                type: "Right",
                value: {
                    fileName: sourceFile.fileName,
                    fileContents: sourceFile.text,
                    queryMethodName: typeArgument === null ? methodName : null,
                    typeArgument: typeArgument,
                    typeArgumentSpan: typeArgumentSpan,
                    tableName: tableNameArg.text,
                    tableNameExprSpan: nodeLineAndColSpan(sourceFile, tableNameArg),
                    insertExprSpan: nodeLineAndColSpan(sourceFile, valuesArg),
                    insertColumns: objectFieldTypes.value,
                    epilougeFragments: epilougeFragments
                }
            };
        default:
            return assertNever(objectFieldTypes);
    }
}

export function findAllQueryCalls(typeScriptUniqueColumnTypes: Map<TypeScriptType, SqlType>, projectDir: string, checker: ts.TypeChecker, lookupViewName: (qualifiedSqlViewName: QualifiedSqlViewName) => string | undefined, sourceFile: ts.SourceFile): [ResolvedQuery[], ErrorDiagnostic[]] {
    const resolvedQueries: ResolvedQuery[] = [];
    const errorDiagnostics: ErrorDiagnostic[] = [];

    function visit(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            if (ts.isPropertyAccessExpression(node.expression)) {
                if (ts.isIdentifier(node.expression.name)) {
                    const queryMethodNames = ["query", "queryOne", "queryOneOrNone"];
                    const insertMethodNames = ["insert", "insertMaybe"];
                    if (queryMethodNames.indexOf(node.expression.name.text) >= 0) {
                        const type = checker.getTypeAtLocation(node.expression.expression);
                        if (type.getProperty("MfConnectionTypeTag") !== undefined) {
                            const query = buildQueryCallExpression(node.expression.name.text, node);
                            switch (query.type) {
                                case "Left":
                                    for (const e of query.value) {
                                        errorDiagnostics.push(e);
                                    }
                                    break;
                                case "Right":
                                    const resolvedQuery = resolveQueryFragment(typeScriptUniqueColumnTypes, projectDir, checker, query.value, lookupViewName);
                                    switch (resolvedQuery.type) {
                                        case "Left":
                                            for (const e of resolvedQuery.value) {
                                                errorDiagnostics.push(e);
                                            }
                                            break;
                                        case "Right":
                                            resolvedQueries.push({
                                                type: "ResolvedSelect",
                                                value: resolvedQuery.value
                                            });
                                            break;
                                        default:
                                            assertNever(resolvedQuery);
                                    }
                                    break;
                                default:
                                    assertNever(query);
                            }
                        }
                    } else if (node.expression.name.text === "insertMany") {
                        const type = checker.getTypeAtLocation(node.expression.expression);
                        if (type.getProperty("MfConnectionTypeTag") !== undefined) {
                            const query = buildInsertManyCallExpression(checker, node.expression.name.text, node);
                            switch (query.type) {
                                case "Left":
                                    for (const e of query.value) {
                                        errorDiagnostics.push(e);
                                    }
                                    break;
                                case "Right":
                                    const resolvedQuery = resolveInsertMany(typeScriptUniqueColumnTypes, projectDir, checker, query.value, lookupViewName);
                                    switch (resolvedQuery.type) {
                                        case "Left":
                                            for (const e of resolvedQuery.value) {
                                                errorDiagnostics.push(e);
                                            }
                                            break;
                                        case "Right":
                                            resolvedQueries.push({
                                                type: "ResolvedInsert",
                                                value: resolvedQuery.value
                                            });
                                            break;
                                        default:
                                            assertNever(resolvedQuery);
                                    }
                                    break;
                                default:
                                    assertNever(query);
                            }
                        }
                    } else if (insertMethodNames.indexOf(node.expression.name.text) >= 0) {
                        const type = checker.getTypeAtLocation(node.expression.expression);
                        if (type.getProperty("MfConnectionTypeTag") !== undefined) {
                            const query = buildInsertCallExpression(checker, node.expression.name.text, node);
                            switch (query.type) {
                                case "Left":
                                    for (const e of query.value) {
                                        errorDiagnostics.push(e);
                                    }
                                    break;
                                case "Right":
                                    const resolvedQuery = resolveInsertMany(typeScriptUniqueColumnTypes, projectDir, checker, query.value, lookupViewName);
                                    switch (resolvedQuery.type) {
                                        case "Left":
                                            for (const e of resolvedQuery.value) {
                                                errorDiagnostics.push(e);
                                            }
                                            break;
                                        case "Right":
                                            resolvedQueries.push({
                                                type: "ResolvedInsert",
                                                value: resolvedQuery.value
                                            });
                                            break;
                                        default:
                                            assertNever(resolvedQuery);
                                    }
                                    break;
                                default:
                                    assertNever(query);
                            }
                        }
                    }
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    ts.forEachChild(sourceFile, visit);

    return [resolvedQueries, errorDiagnostics];
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
 * @returns `null` if the type is not an SqlFrag<T>
 */
function tryTypeSqlFrag(type: ts.Type): Either<string, string | null> {
    // TODO This should be more robust: make sure that it is the "SqlFrag"
    // type defined in the sql library (and not some other user-defined type
    // that happens to have the same name)

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

    return {
        type: "Right",
        value: null
    };
}

export function isNullableType(type: ts.Type): boolean {
    if (!type.isUnion()) {
        return type.flags === ts.TypeFlags.Null;
    }

    for (const typ of type.types) {
        if (typ.flags === ts.TypeFlags.Null) {
            return true;
        }
    }

    return false;
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

function getObjectFieldTypes(checker: ts.TypeChecker, type: ts.Type): Either<string, Map<string, [TypeScriptType, boolean]>> {
    const errors: string[] = [];
    const result = new Map<string, [TypeScriptType, boolean]>();

    const addResult = (fieldName: string, typ: ts.Type) => {
        if ((typ.flags & ts.TypeFlags.StringLiteral) !== 0 || // tslint:disable-line:no-bitwise
            isUnionOfStringLiterals(typ)) {
            result.set(fieldName, [TypeScriptType.wrap("string"), !isNullableType(typ)]);
        } else if (isUnionOfBooleanLiterals(typ)) {
            result.set(fieldName, [TypeScriptType.wrap("boolean"), !isNullableType(typ)]);
        } else {
            result.set(fieldName, [TypeScriptType.wrap(checker.typeToString(nonNullType(typ))), !isNullableType(typ)]);
        }
    };

    if ((<any>type).members !== undefined) {
        const members: Map<string, any> = (<any>type).members;
        members.forEach((value, key) => {
            addResult(key, value.type);
        });
    } else {
        type.getProperties().forEach((value) => {
            addResult(value.name, checker.getTypeAtLocation(value.valueDeclaration));
        });
    }

    if (errors.length > 0) {
        return {
            type: "Left",
            value: "Values array argument element type has invalid fields:\n" + errors.join("\n")
        };
    } else {
        return {
            type: "Right",
            value: result
        };
    }
}

/**
 * Checks if the type is something like: "Yes" | "No" | "Maybe"
 *
 * One of the union members is also allowed to be `null`: "High" | "Low" | null
 */
function isUnionOfStringLiterals(type: ts.Type): boolean {
    if ((type.flags & ts.TypeFlags.Union) === 0) { // tslint:disable-line:no-bitwise
        return false;
    }

    const types: ReadonlyArray<ts.Type> = (<any>type).types;
    for (const unionType of types) {
        if (!((unionType.flags & ts.TypeFlags.String) !== 0 || // tslint:disable-line:no-bitwise
            (unionType.flags & ts.TypeFlags.StringLiteral) !== 0 || // tslint:disable-line:no-bitwise
            (unionType.flags & ts.TypeFlags.Null) !== 0)) { // tslint:disable-line:no-bitwise
            return false;
        }
    }

    return true;
}

/**
 * Checks if the type is something like: "true | false".
 *
 * One of the union members is also allowed to be `null`: "true | false |
 * null"
 *
 * We would expect TypeScript to report the above forms as "boolean" and
 * "boolean | null", but sometimes they do look this like
 */
function isUnionOfBooleanLiterals(type: ts.Type): boolean {
    if ((type.flags & ts.TypeFlags.Union) === 0) { // tslint:disable-line:no-bitwise
        return false;
    }

    const types: ReadonlyArray<ts.Type> = (<any>type).types;
    for (const unionType of types) {
        if (!((unionType.flags & ts.TypeFlags.Boolean) !== 0 || // tslint:disable-line:no-bitwise
            (unionType.flags & ts.TypeFlags.BooleanLiteral) !== 0 || // tslint:disable-line:no-bitwise
            (unionType.flags & ts.TypeFlags.Null) !== 0)) { // tslint:disable-line:no-bitwise
            return false;
        }
    }

    return true;
}

/**
 * @returns Empty string means SQL "NULL" literal. `null` means an error
 */
function typescriptTypeToSqlType(typeScriptUniqueColumnTypes: Map<TypeScriptType, SqlType>, type: ts.Type): SqlType | null {
    if (type.flags === ts.TypeFlags.Any) {
        // TODO Would be better to return some special value here, in order to
        // give a nicer error message (instead of getting the error from
        // postgresql 'type "ts_any" does not exist)
        return SqlType.wrap("ts_any");
    } else if (type.flags === ts.TypeFlags.Null) {
        return SqlType.wrap("");
    } else if ((type.flags & ts.TypeFlags.Never) !== 0) { // tslint:disable-line:no-bitwise
        return null;
    } else if ((type.flags & ts.TypeFlags.Boolean) !== 0 || (type.flags & ts.TypeFlags.BooleanLiteral) !== 0) { // tslint:disable-line:no-bitwise
        return SqlType.wrap("bool");
    } else if (isUnionOfBooleanLiterals(type)) {
        return SqlType.wrap("bool");
    } else if ((type.flags & ts.TypeFlags.Number) !== 0 || (type.flags & ts.TypeFlags.NumberLiteral) !== 0) { // tslint:disable-line:no-bitwise
        return SqlType.wrap("int4");
    } else if ((type.flags & ts.TypeFlags.String) !== 0 || (type.flags & ts.TypeFlags.StringLiteral) !== 0) { // tslint:disable-line:no-bitwise
        return SqlType.wrap("text");
    } else if (isUnionOfStringLiterals(type)) {
        return SqlType.wrap("text");
    }

    if ((type.flags & ts.TypeFlags.Union) !== 0) { // tslint:disable-line:no-bitwise
        return null;
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

function typescriptRowTypeToColTypes(checker: ts.TypeChecker, typeNode: ts.TypeNode, errorReporter: (error: ErrorDiagnostic) => void): Map<string, [ColNullability, TypeScriptType]> | null {
    if (ts.isTypeLiteralNode(typeNode)) {
        return typeLiteralNodeToColTypes(checker, typeNode, errorReporter);
    } else {
        const typ = checker.getTypeAtLocation(typeNode);
        if (typ.flags === ts.TypeFlags.Any) {
            return null;
        } else {
            if ((<any>typ).symbol !== undefined && typ.symbol.members !== undefined) {
                return typeSymbolMembersToColTypes(checker, typeNode, <any>typ.symbol.members, errorReporter);
            } else {
                errorReporter(nodeErrorDiagnostic(typeNode, "Invalid type argument (must be a Type Literal or interface type)"));
                return new Map<string, [ColNullability, TypeScriptType]>();
            }
        }
    }
}

function typeLiteralNodeToColTypes(checker: ts.TypeChecker, typeLiteral: ts.TypeLiteralNode, errorReporter: (error: ErrorDiagnostic) => void): Map<string, [ColNullability, TypeScriptType]> {
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
                    const colTypes = getTypeMemberColTypes(checker, member, member.name.text, memberType);
                    switch (colTypes.type) {
                        case "Left":
                            errorReporter(colTypes.value);
                            break;
                        case "Right":
                            results.set(member.name.text, colTypes.value);
                            break;
                        default:
                            assertNever(colTypes);
                    }
                }
            }
        }
    }
    return results;
}

function typeSymbolMembersToColTypes(checker: ts.TypeChecker, node: ts.Node, members: Map<string, ts.Symbol>, errorReporter: (error: ErrorDiagnostic) => void): Map<string, [ColNullability, TypeScriptType]> {
    const results = new Map<string, [ColNullability, TypeScriptType]>();
    members.forEach((value, key) => {
        const memberType = checker.getTypeAtLocation(value.valueDeclaration);

        const colTypes = getTypeMemberColTypes(checker, node, key, memberType);
        switch (colTypes.type) {
            case "Left":
                errorReporter(colTypes.value);
                break;
            case "Right":
                results.set(key, colTypes.value);
                break;
            default:
                assertNever(colTypes);
        }
    });
    return results;
}

function getTypeMemberColTypes(checker: ts.TypeChecker, node: ts.Node, propName: string, memberType: ts.Type): Either<ErrorDiagnostic, [ColNullability, TypeScriptType]> {
    if (memberType.flags !== ts.TypeFlags.Object) {
        return {
            type: "Left",
            value: nodeErrorDiagnostic(node, `Invalid type for property "${propName}", it must be \`Req<T>\` or \`Opt<T>\``)
        };
    } else {
        const colNullability = getColNullability(memberType.symbol);
        if (colNullability === null) {
            return {
                type: "Left",
                value: nodeErrorDiagnostic(node, `Invalid type for property "${propName}", it must be \`Req<T>\` or \`Opt<T>\``)
            };
        } else {
            const typeArguments: ts.Type[] | undefined = (<any>memberType).typeArguments;
            if (typeArguments === undefined || typeArguments.length < 1) {
                return {
                    type: "Left",
                    value: nodeErrorDiagnostic(node, `Invalid type for property "${propName}", it must be \`Req<T>\` or \`Opt<T>\``)
                };
            } else {
                const typeArgument = typeArguments[0];
                const type = readTypeScriptType(checker, typeArgument);
                if (type === null) {
                    return {
                        type: "Left",
                        value: nodeErrorDiagnostic(node, `Invalid type for property "${propName}": ${checker.typeToString(typeArgument)}`)
                    };
                } else {
                    return {
                        type: "Right",
                        value: [colNullability, type]
                    };
                }
            }
        }
    }
}

function resolveQueryFragment(typeScriptUniqueColumnTypes: Map<TypeScriptType, SqlType>, projectDir: string, checker: ts.TypeChecker, query: QueryCallExpression, lookupViewName: (qualifiedSqlViewName: QualifiedSqlViewName) => string | undefined): Either<ErrorDiagnostic[], ResolvedSelect> {
    const errors: ErrorDiagnostic[] = [];

    let text = "";
    const sourceMap: [number, number, number][] = [];
    let numParams = 0;
    for (const frag of query.queryFragments) {
        switch (frag.type) {
            case "StringFragment":
                sourceMap.push([frag.sourcePosStart, text.length, text.length + frag.text.length]);
                text += frag.text;
                break;
            case "Expression":
                const type = checker.getTypeAtLocation(frag.exp);
                const maybeSqlFrag = tryTypeSqlFrag(type);
                switch (maybeSqlFrag.type) {
                    case "Left":
                        errors.push(nodeErrorDiagnostic(frag.exp, maybeSqlFrag.value));
                        break;
                    case "Right":
                        if (maybeSqlFrag.value !== null) {
                            text += maybeSqlFrag.value;
                        } else if (isTypeSqlView(type)) {
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
                                    ? escapeIdentifier(sqlTypeStr.substring(0, sqlTypeStr.length - 2)) + "[]"
                                    : escapeIdentifier(sqlTypeStr);

                                text += "($" + numParams + (sqlTypeStr !== "" ? "::" + escapedSqlTypeStr : "") + ")";
                            }
                        }
                        break;
                    default:
                        assertNever(maybeSqlFrag);
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
            colTypes = typescriptRowTypeToColTypes(checker, query.typeArgument, e => errors.push(e));
        }

        return {
            type: "Right",
            value: {
                fileName: query.fileName,
                fileContents: query.fileContents,
                text: text,
                sourceMap: sourceMap,
                colTypes: colTypes,
                queryMethodName: query.queryMethodName,
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


function resolveInsertMany(typeScriptUniqueColumnTypes: Map<TypeScriptType, SqlType>, projectDir: string, checker: ts.TypeChecker, query: InsertManyExpression, lookupViewName: (qualifiedSqlViewName: QualifiedSqlViewName) => string | undefined): Either<ErrorDiagnostic[], ResolvedInsert> {
    // TODO This contains lots of copy&pasted code from
    // `resolveQueryFragment`. The common code should be refactored into
    // helper functions

    const errors: ErrorDiagnostic[] = [];

    let text = "";

    const insertFragment: QueryCallExpression.QueryFragment[] = [{
        type: "StringFragment",
        text: `INSERT INTO ${escapeIdentifier(query.tableName)} DEFAULT VALUES `,
        sourcePosStart: 0
    }];

    const queryFragments: QueryCallExpression.QueryFragment[] = insertFragment.concat(query.epilougeFragments);

    const sourceMap: [number, number, number][] = [];
    let numParams = 0;
    for (const frag of queryFragments) {
        switch (frag.type) {
            case "StringFragment":
                sourceMap.push([frag.sourcePosStart, text.length, text.length + frag.text.length]);
                text += frag.text;
                break;
            case "Expression":
                const type = checker.getTypeAtLocation(frag.exp);
                const maybeSqlFrag = tryTypeSqlFrag(type);
                switch (maybeSqlFrag.type) {
                    case "Left":
                        errors.push(nodeErrorDiagnostic(frag.exp, maybeSqlFrag.value));
                        break;
                    case "Right":
                        if (maybeSqlFrag.value !== null) {
                            text += maybeSqlFrag.value;
                        } else if (isTypeSqlView(type)) {
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
                                    ? escapeIdentifier(sqlTypeStr.substring(0, sqlTypeStr.length - 2)) + "[]"
                                    : escapeIdentifier(sqlTypeStr);

                                text += "($" + numParams + (sqlTypeStr !== "" ? "::" + escapedSqlTypeStr : "") + ")";
                            }
                        }
                        break;
                    default:
                        assertNever(maybeSqlFrag);
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
            colTypes = typescriptRowTypeToColTypes(checker, query.typeArgument, e => errors.push(e));
        }

        return {
            type: "Right",
            value: {
                fileName: query.fileName,
                fileContents: query.fileContents,
                insertColumns: query.insertColumns,
                tableName: query.tableName,
                text: text,
                sourceMap: sourceMap,
                colTypes: colTypes,
                queryMethodName: query.queryMethodName,
                colTypeSpan: query.typeArgumentSpan,
                tableNameExprSpan: query.tableNameExprSpan,
                insertExprSpan: query.insertExprSpan,
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
