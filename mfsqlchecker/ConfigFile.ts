import * as Ajv from "ajv";
import * as fs from "fs";
import { Either } from "./either";
import { ErrorDiagnostic } from "./ErrorDiagnostic";
import { SqlType, TypeScriptType } from "./queries";

export interface ConfigFile {
    migrationsDir?: string;
    postgresVersion?: string;
    customSqlTypeMappings?: CustomSqlTypeMapping[];
    uniqueTableColumnTypes?: UniqueTableColumnType[];
}

export interface CustomSqlTypeMapping {
    typeScriptTypeName: TypeScriptType;
    sqlTypeName: SqlType;
}

export interface UniqueTableColumnType {
    typeScriptTypeName: TypeScriptType;
    tableName: string;
    columnName: string;
}

export function equalsUniqueTableColumnType(lhs: UniqueTableColumnType, rhs: UniqueTableColumnType) {
    return lhs.typeScriptTypeName === rhs.typeScriptTypeName &&
        lhs.tableName === rhs.tableName &&
        lhs.columnName === rhs.columnName;
}

export function equalsUniqueTableColumnTypes(lhs: UniqueTableColumnType[], rhs: UniqueTableColumnType[]) {
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

export function makeUniqueColumnTypes(uniqueTableColumnTypes: UniqueTableColumnType[]): Map<SqlType, TypeScriptType> {
    const result = new Map<SqlType, TypeScriptType>();

    for (const uniqueTableColumnType of uniqueTableColumnTypes) {
        const sqlTypeName = sqlUniqueTypeName(uniqueTableColumnType.tableName, uniqueTableColumnType.columnName);
        result.set(SqlType.wrap(sqlTypeName), uniqueTableColumnType.typeScriptTypeName);
    }

    return result;
}

export function loadConfigFile(fileName: string): Either<ErrorDiagnostic, ConfigFile> {
    let fileContents: string;
    try {
        fileContents = fs.readFileSync(fileName, { encoding: "utf8" });
    } catch (err) {
        return {
            type: "Left",
            value: {
                fileName: fileName,
                fileContents: "",
                span: {
                    type: "File"
                },
                messages: [`Error opening file ${fileName}`, err.message],
                epilogue: null,
                quickFix: null
            }
        };
    }
    return parseConfigFile(fileName, fileContents);
}

const ajv = new Ajv();
// tslint:disable-next-line:no-var-requires no-require-imports no-submodule-imports
ajv.addMetaSchema(require("ajv/lib/refs/json-schema-draft-06.json"));

export function parseConfigFile(fileName: string, fileContents: string): Either<ErrorDiagnostic, ConfigFile> {
    function error<T>(messages: string[]): Either<ErrorDiagnostic, T> {
        return {
            type: "Left", value: {
                fileContents: fileContents,
                fileName: fileName,
                span: {
                    type: "File"
                },
                messages: messages,
                epilogue: null,
                quickFix: null
            }
        };
    }

    let json: any;
    try {
        json = JSON.parse(fileContents);
    } catch (err) {
        return error(["JSON Parser Error", err.message]);
    }

    const valid = ajv.validate(configFileSchema, json);
    if (!valid) {
        if (ajv.errors === null || ajv.errors === undefined) {
            throw new Error("The Impossible Happened");
        }
        return error(ajv.errors.map(e => JSON.stringify(e, null, 2)));
    }

    return {
        type: "Right",
        value: json
    };
}

// This schema was auto-generated using this Visual Studio Code extension:
// <https://marketplace.visualstudio.com/items?itemName=marcoq.vscode-typescript-to-json-schema>
const configFileSchema = {
    "$schema": "http://json-schema.org/draft-06/schema#",
    "definitions": {
        "ConfigFile": {
            "type": "object",
            "properties": {
                "migrationsDir": {
                    "type": "string"
                },
                "postgresVersion": {
                    "type": "string"
                },
                "customSqlTypeMappings": {
                    "type": "array",
                    "items": {
                        "$ref": "#/definitions/CustomSqlTypeMapping"
                    }
                },
                "uniqueTableColumnTypes": {
                    "type": "array",
                    "items": {
                        "$ref": "#/definitions/UniqueTableColumnType"
                    }
                }
            },
            "additionalProperties": false
        },
        "CustomSqlTypeMapping": {
            "type": "object",
            "properties": {
                "typeScriptTypeName": {
                    "type": "string"
                },
                "sqlTypeName": {
                    "type": "string"
                }
            },
            "required": [
                "typeScriptTypeName",
                "sqlTypeName"
            ],
            "additionalProperties": false
        },
        "UniqueTableColumnType": {
            "type": "object",
            "properties": {
                "typeScriptTypeName": {
                    "type": "string"
                },
                "tableName": {
                    "type": "string"
                },
                "columnName": {
                    "type": "string"
                }
            },
            "required": [
                "typeScriptTypeName",
                "tableName",
                "columnName"
            ],
            "additionalProperties": false
        }
    },
    "$ref": "#/definitions/ConfigFile"
};
