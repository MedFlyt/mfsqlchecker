import fs from "fs";
import * as E from "fp-ts/Either";
import { ErrorDiagnostic } from "./ErrorDiagnostic";
import { SqlType, TypeScriptType } from "./queries";
import { z } from "zod";
import { pipe } from "fp-ts/lib/function";
import { fmap } from "@mfsqlchecker/shared/utils";

export interface Config {
    migrationsDir: string;
    colTypesFormat: ColTypesFormat;
    strictDateTimeChecking: boolean;
    customSqlTypeMappings: CustomSqlTypeMapping[];
    uniqueTableColumnTypes: UniqueTableColumnType[];
}

export interface ColTypesFormat {
    includeRegionMarker: boolean;
    delimiter: "," | ";";
}

export const defaultColTypesFormat: ColTypesFormat = {
    includeRegionMarker: false,
    delimiter: ","
};

export interface CustomSqlTypeMapping {
    typeScriptTypeName: TypeScriptType;
    sqlTypeName: SqlType;
}

export interface UniqueTableColumnType {
    typeScriptTypeName: TypeScriptType;
    tableName: string;
    columnName: string;
}

function normalizeConfigFile(configFile: ConfigFile): Config {
    return {
        migrationsDir: configFile.migrationsDir,
        colTypesFormat: fmap(configFile.colTypesFormat, toColTypesFormat) ?? defaultColTypesFormat,
        strictDateTimeChecking: configFile.strictDateTimeChecking === true,
        customSqlTypeMappings:
            fmap(configFile.customSqlTypeMappings, (x) => x.map(toCustomSqlTypeMapping)) ?? [],
        uniqueTableColumnTypes:
            fmap(configFile.uniqueTableColumnTypes, (x) => x.map(toUniqueTableColumnType)) ?? []
    };
}

const zConfigColTypesFormat = z.object({
    includeRegionMarker: z.boolean().optional(),
    delimiter: z.enum([",", ";"]).optional()
});

type ConfigColTypesFormat = z.infer<typeof zConfigColTypesFormat>;

const zConfigCustomSqlTypeMapping = z.object({
    typeScriptTypeName: z.string(),
    sqlTypeName: z.string()
});

type ConfigCustomSqlTypeMapping = z.infer<typeof zConfigCustomSqlTypeMapping>;

const zConfigUniqueTableColumnType = z.object({
    typeScriptTypeName: z.string(),
    tableName: z.string(),
    columnName: z.string()
});

type ConfigUniqueTableColumnType = z.infer<typeof zConfigUniqueTableColumnType>;

const zConfigFile = z.object({
    migrationsDir: z.string().default("migrations"),
    colTypesFormat: zConfigColTypesFormat.optional(),
    strictDateTimeChecking: z.boolean().optional(),
    customSqlTypeMappings: zConfigCustomSqlTypeMapping.array().optional(),
    uniqueTableColumnTypes: zConfigUniqueTableColumnType.array().optional()
});

type ConfigFile = z.infer<typeof zConfigFile>;

function toColTypesFormat(v: ConfigColTypesFormat): ColTypesFormat {
    return {
        includeRegionMarker:
            v.includeRegionMarker !== undefined
                ? v.includeRegionMarker
                : defaultColTypesFormat.includeRegionMarker,
        delimiter: v.delimiter !== undefined ? v.delimiter : defaultColTypesFormat.delimiter
    };
}

function toCustomSqlTypeMapping(v: ConfigCustomSqlTypeMapping): CustomSqlTypeMapping {
    return {
        sqlTypeName: SqlType.wrap(v.sqlTypeName),
        typeScriptTypeName: TypeScriptType.wrap(v.typeScriptTypeName)
    };
}

function toUniqueTableColumnType(v: ConfigUniqueTableColumnType): UniqueTableColumnType {
    return {
        typeScriptTypeName: TypeScriptType.wrap(v.typeScriptTypeName),
        tableName: v.tableName,
        columnName: v.columnName
    };
}

export function equalsUniqueTableColumnType(
    lhs: UniqueTableColumnType,
    rhs: UniqueTableColumnType
) {
    return (
        lhs.typeScriptTypeName === rhs.typeScriptTypeName &&
        lhs.tableName === rhs.tableName &&
        lhs.columnName === rhs.columnName
    );
}

export function equalsUniqueTableColumnTypes(
    lhs: UniqueTableColumnType[],
    rhs: UniqueTableColumnType[]
) {
    if (lhs.length !== rhs.length) {
        return false;
    }

    for (let i = 0; i < lhs.length; ++i) {
        if (!equalsUniqueTableColumnType(lhs[i], rhs[i])) {
            return false;
        }
    }

    return true;
}

export function sqlUniqueTypeName(tableName: string, columnName: string): string {
    return tableName + "(" + columnName + ")";
}

export function makeUniqueColumnTypes(
    uniqueTableColumnTypes: UniqueTableColumnType[]
): Map<SqlType, TypeScriptType> {
    const result = new Map<SqlType, TypeScriptType>();

    for (const uniqueTableColumnType of uniqueTableColumnTypes) {
        const sqlTypeName = sqlUniqueTypeName(
            uniqueTableColumnType.tableName,
            uniqueTableColumnType.columnName
        );
        result.set(SqlType.wrap(sqlTypeName), uniqueTableColumnType.typeScriptTypeName);
    }

    return result;
}

export function loadConfigFileE(fileName: string): E.Either<ErrorDiagnostic, Config> {
    let fileContents: string;
    try {
        fileContents = fs.readFileSync(fileName, { encoding: "utf8" });
    } catch (err) {
        return E.left({
            fileName: fileName,
            fileContents: "",
            span: {
                type: "File"
            },
            messages: [`Error opening file ${fileName}`, String(err)],
            epilogue: null,
            quickFix: null
        });
    }

    return pipe(
        E.Do,
        E.chain(() => parseConfigFileE(fileName, fileContents)),
        E.map((config) => normalizeConfigFile(config))
    );
}

export function parseConfigFileE(
    fileName: string,
    fileContents: string
): E.Either<ErrorDiagnostic, ConfigFile> {
    function error<T>(messages: string[]): E.Either<ErrorDiagnostic, T> {
        return E.left({
            fileContents: fileContents,
            fileName: fileName,
            span: {
                type: "File"
            },
            messages: messages,
            epilogue: null,
            quickFix: null
        });
    }

    let json: unknown;
    try {
        json = JSON.parse(fileContents);
    } catch (err) {
        return error(["JSON Parser Error", String(err)]);
    }

    const result = zConfigFile.safeParse(json);

    if (!result.success) {
        return error(result.error.errors.map((e) => JSON.stringify(e, null, 2)));
    }

    return E.right(result.data);
}
