var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// eslint-local-rules/rules/sql-check.worker.ts
var sql_check_worker_exports = {};
module.exports = __toCommonJS(sql_check_worker_exports);
var import_function3 = require("fp-ts/function");
var TE3 = __toESM(require("fp-ts/TaskEither"));
var E3 = __toESM(require("fp-ts/Either"));
var import_synckit = require("synckit");

// eslint-local-rules/rules/sql-check.utils.ts
var import_assert_never6 = __toESM(require("assert-never"));
var E2 = __toESM(require("fp-ts/Either"));
var import_function2 = require("fp-ts/function");
var TE2 = __toESM(require("fp-ts/TaskEither"));
var import_path = __toESM(require("path"));

// mfsqlchecker/ConfigFile.ts
var import_ajv = __toESM(require("ajv"));
var import_assert_never3 = require("assert-never");
var import_fs = __toESM(require("fs"));

// mfsqlchecker/queries.ts
var import_assert_never2 = require("assert-never");
var import_chalk2 = __toESM(require("chalk"));
var ts4 = __toESM(require("typescript"));

// mfsqlchecker/ErrorDiagnostic.ts
var import_chalk = __toESM(require("chalk"));
var ts = __toESM(require("typescript"));
function fileLineCol(fileContents, position) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < position; ++i) {
    if (fileContents.codePointAt(i) === 10) {
      line++;
      col = 0;
    }
    col++;
  }
  return {
    type: "LineAndCol",
    line,
    col
  };
}
function toSrcSpan(fileContents, position) {
  return fileLineCol(fileContents, position - 1);
}
function postgresqlErrorDiagnostic(fileName, fileContents, err, span, message) {
  return {
    fileName,
    fileContents,
    span,
    messages: (message !== null ? [message] : []).concat([
      import_chalk.default.bold(err.message),
      import_chalk.default.bold("code:") + " " + err.code
    ]).concat(err.detail !== null && err.detail !== err.message ? import_chalk.default.bold("detail:") + " " + err.detail : []),
    epilogue: err.hint !== null ? import_chalk.default.bold("hint:") + " " + err.hint : null,
    quickFix: null
  };
}

// mfsqlchecker/pg_extra.ts
var crypto = __toESM(require("crypto"));
var import_postgres = __toESM(require("postgres"));
function connectPg(url) {
  return (0, import_postgres.default)(url, {
    max: 1,
    onnotice: () => {
    }
  });
}
function closePg(conn) {
  return conn.end();
}
function escapeIdentifier(str) {
  return '"' + str.replace(/"/g, '""') + '"';
}
async function pgDescribeQuery(client, text) {
  const result = await client.unsafe(text).describe();
  return result.columns;
}
async function dropAllTables(client) {
  await client.unsafe(
    `
        DO $$ DECLARE
            r RECORD;
        BEGIN
            -- if the schema you operate on is not "current", you will want to
            -- replace current_schema() in query with 'schematodeletetablesfrom'
            -- *and* update the generate 'DROP...' accordingly.
            FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = current_schema()) LOOP
                EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
            END LOOP;
        END $$;
        `
  );
}
async function dropAllSequences(client) {
  await client.unsafe(
    `
        DO $$ DECLARE
            r RECORD;
        BEGIN
            -- if the schema you operate on is not "current", you will want to
            -- replace current_schema() in query with 'schematodeletetablesfrom'
            -- *and* update the generate 'DROP...' accordingly.
            FOR r IN (SELECT pg_class.relname FROM pg_class, pg_namespace WHERE pg_class.relnamespace = pg_namespace.oid AND pg_namespace.nspname = current_schema() AND pg_class.relkind = 'S') LOOP
                EXECUTE 'DROP SEQUENCE IF EXISTS ' || quote_ident(r.relname) || ' CASCADE';
            END LOOP;
        END $$;
        `
  );
}
async function dropAllFunctions(client) {
  await client.unsafe(
    `
        DO $$ DECLARE
            r RECORD;
        BEGIN
            -- if the schema you operate on is not "current", you will want to
            -- replace current_schema() in query with 'schematodeletetablesfrom'
            -- *and* update the generate 'DROP...' accordingly.
            FOR r IN (SELECT pg_proc.proname, pg_proc.proargtypes FROM pg_proc, pg_namespace WHERE pg_proc.pronamespace = pg_namespace.oid AND pg_namespace.nspname = current_schema()) LOOP
                EXECUTE 'DROP FUNCTION IF EXISTS ' || quote_ident(r.proname) || '(' || oidvectortypes(r.proargtypes) || ')' || ' CASCADE';
            END LOOP;
        END $$;
        `
  );
}
async function dropAllTypes(client) {
  await client.unsafe(
    `
        DO $$ DECLARE
            r RECORD;
        BEGIN
            -- if the schema you operate on is not "current", you will want to
            -- replace current_schema() in query with 'schematodeletetablesfrom'
            -- *and* update the generate 'DROP...' accordingly.
            FOR r IN (SELECT pg_type.typname FROM pg_type, pg_namespace WHERE pg_namespace.oid = pg_type.typnamespace AND pg_namespace.nspname = current_schema()) LOOP
                EXECUTE 'DROP TYPE IF EXISTS ' || quote_ident(r.typname) || ' CASCADE';
            END LOOP;
        END $$;
        `
  );
}
function parsePostgreSqlError(err) {
  if (!(err instanceof import_postgres.default.PostgresError)) {
    return null;
  }
  return {
    code: err.code,
    position: parseInt(err.position, 10),
    message: err.message,
    detail: err.detail !== void 0 ? err.detail : null,
    hint: err.hint !== void 0 ? err.hint : null
  };
}
var Savepoint = class {
  constructor(name) {
    this.name = name;
  }
};
function randomSavepointName() {
  return new Promise((resolve, reject) => {
    crypto.randomBytes(24, (err, buf) => {
      if (err) {
        reject(err);
        return;
      }
      const token = buf.toString("hex");
      resolve("savepoint_" + token);
    });
  });
}
async function newSavepoint(conn) {
  const savepointName = await randomSavepointName();
  await conn.unsafe(`SAVEPOINT ${savepointName}`);
  return new Savepoint(savepointName);
}
async function rollbackToAndReleaseSavepoint(conn, savepoint) {
  await conn.unsafe(`ROLLBACK TO SAVEPOINT ${savepoint.name}; RELEASE SAVEPOINT ${savepoint.name}`);
}

// mfsqlchecker/views.ts
var import_assert_never = require("assert-never");
var ts3 = __toESM(require("typescript"));

// mfsqlchecker/ts_extra.ts
var ts2 = __toESM(require("typescript"));

// mfsqlchecker/views.ts
var QualifiedSqlViewName = class {
  static create(moduleId, viewName) {
    return moduleId + " " + viewName;
  }
  static moduleId(val) {
    return val.split(" ")[0];
  }
  static viewName(val) {
    return val.split(" ")[1];
  }
  _dummy;
};

// mfsqlchecker/queries.ts
var TypeScriptType = class {
  static wrap(val) {
    return val;
  }
  static unwrap(val) {
    return val;
  }
  _dummy;
};
var SqlType = class {
  static wrap(val) {
    return val;
  }
  static unwrap(val) {
    return val;
  }
  _dummy;
};

// mfsqlchecker/ConfigFile.ts
var defaultColTypesFormat = {
  includeRegionMarker: false,
  delimiter: ","
};
function normalizeConfigFile(configFile) {
  return {
    migrationsDir: configFile.migrationsDir !== void 0 ? configFile.migrationsDir : null,
    postgresVersion: configFile.postgresVersion !== void 0 ? configFile.postgresVersion : null,
    colTypesFormat: configFile.colTypesFormat !== void 0 ? toColTypesFormat(configFile.colTypesFormat) : defaultColTypesFormat,
    strictDateTimeChecking: configFile.strictDateTimeChecking === true,
    customSqlTypeMappings: configFile.customSqlTypeMappings !== void 0 ? configFile.customSqlTypeMappings.map(toCustomSqlTypeMapping) : [],
    uniqueTableColumnTypes: configFile.uniqueTableColumnTypes !== void 0 ? configFile.uniqueTableColumnTypes.map(toUniqueTableColumnType) : []
  };
}
function toColTypesFormat(v) {
  return {
    includeRegionMarker: v.includeRegionMarker !== void 0 ? v.includeRegionMarker : defaultColTypesFormat.includeRegionMarker,
    delimiter: v.delimiter !== void 0 ? v.delimiter : defaultColTypesFormat.delimiter
  };
}
function toCustomSqlTypeMapping(v) {
  return {
    sqlTypeName: SqlType.wrap(v.sqlTypeName),
    typeScriptTypeName: TypeScriptType.wrap(v.typeScriptTypeName)
  };
}
function toUniqueTableColumnType(v) {
  return {
    typeScriptTypeName: TypeScriptType.wrap(v.typeScriptTypeName),
    tableName: v.tableName,
    columnName: v.columnName
  };
}
function equalsUniqueTableColumnType(lhs, rhs) {
  return lhs.typeScriptTypeName === rhs.typeScriptTypeName && lhs.tableName === rhs.tableName && lhs.columnName === rhs.columnName;
}
function equalsUniqueTableColumnTypes(lhs, rhs) {
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
function sqlUniqueTypeName(tableName, columnName) {
  return tableName + "(" + columnName + ")";
}
function makeUniqueColumnTypes(uniqueTableColumnTypes) {
  const result = /* @__PURE__ */ new Map();
  for (const uniqueTableColumnType of uniqueTableColumnTypes) {
    const sqlTypeName = sqlUniqueTypeName(uniqueTableColumnType.tableName, uniqueTableColumnType.columnName);
    result.set(SqlType.wrap(sqlTypeName), uniqueTableColumnType.typeScriptTypeName);
  }
  return result;
}
function loadConfigFile(fileName) {
  let fileContents;
  try {
    fileContents = import_fs.default.readFileSync(fileName, { encoding: "utf8" });
  } catch (err) {
    return {
      type: "Left",
      value: {
        fileName,
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
  const mbConfigFile = parseConfigFile(fileName, fileContents);
  switch (mbConfigFile.type) {
    case "Left":
      return mbConfigFile;
    case "Right":
      return {
        type: "Right",
        value: normalizeConfigFile(mbConfigFile.value)
      };
    default:
      return (0, import_assert_never3.assertNever)(mbConfigFile);
  }
}
var ajv = new import_ajv.default();
ajv.addMetaSchema(require("ajv/lib/refs/json-schema-draft-06.json"));
function parseConfigFile(fileName, fileContents) {
  function error(messages) {
    return {
      type: "Left",
      value: {
        fileContents,
        fileName,
        span: {
          type: "File"
        },
        messages,
        epilogue: null,
        quickFix: null
      }
    };
  }
  let json;
  try {
    json = JSON.parse(fileContents);
  } catch (err) {
    return error(["JSON Parser Error", err.message]);
  }
  const valid = ajv.validate(configFileSchema, json);
  if (!valid) {
    if (ajv.errors === null || ajv.errors === void 0) {
      throw new Error("The Impossible Happened");
    }
    return error(ajv.errors.map((e) => JSON.stringify(e, null, 2)));
  }
  return {
    type: "Right",
    value: json
  };
}
var configFileSchema = {
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
        "colTypesFormat": {
          "type": "object",
          "properties": {
            "includeRegionMarker": {
              "type": "boolean"
            },
            "delimiter": {
              "type": "string",
              "enum": [
                ",",
                ";"
              ]
            }
          },
          "additionalProperties": false
        },
        "strictDateTimeChecking": {
          "type": "boolean"
        },
        "customSqlTypeMappings": {
          "type": "array",
          "items": {
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
          }
        },
        "uniqueTableColumnTypes": {
          "type": "array",
          "items": {
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
        }
      },
      "additionalProperties": false
    }
  },
  "$ref": "#/definitions/ConfigFile"
};

// mfsqlchecker/launch_postgres.ts
var import_adm_zip = __toESM(require("adm-zip"));
var import_assert_never4 = require("assert-never");
var childProcess = __toESM(require("child_process"));
var import_env_paths = __toESM(require("env-paths"));
var fs2 = __toESM(require("fs"));
var import_make_dir = __toESM(require("make-dir"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var import_promisify_child_process = require("promisify-child-process");
var readline = __toESM(require("readline"));
var import_request = __toESM(require("request"));
var import_rimraf = __toESM(require("rimraf"));
var tar = __toESM(require("tar"));
var APP_NAME = "launch-postgres";
var appEnvPaths = (0, import_env_paths.default)(APP_NAME);
function getCurrentPlatform() {
  switch (process.platform) {
    case "darwin":
      return "mac_os_x";
    case "linux":
      const output = childProcess.execSync("getconf LONG_BIT", { encoding: "utf8" });
      return output === "64\n" ? "linux_x86-64" : "linux_x86-32";
    case "cygwin":
    case "win32":
      let useEnv = false;
      try {
        useEnv = !!(process.env.SYSTEMROOT && fs2.statSync(process.env.SYSTEMROOT));
      } catch (err) {
      }
      const sysRoot = useEnv ? process.env.SYSTEMROOT : "C:\\Windows";
      let isWOW64 = false;
      try {
        isWOW64 = !!fs2.statSync(path.join(sysRoot, "sysnative"));
      } catch (err) {
      }
      return isWOW64 ? "win_x86-64" : "win_x86-32";
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}
function postgresDownloadUrl(platform, postgresVersion) {
  switch (postgresVersion) {
    case "9.4.24":
      switch (platform) {
        case "linux_x86-32":
          return "http://get.enterprisedb.com/postgresql/postgresql-9.4.24-1-linux-binaries.tar.gz";
        case "linux_x86-64":
          return "http://get.enterprisedb.com/postgresql/postgresql-9.4.24-1-linux-x64-binaries.tar.gz";
        case "win_x86-32":
          return "http://get.enterprisedb.com/postgresql/postgresql-9.4.24-1-windows-binaries.zip";
        case "win_x86-64":
          return "http://get.enterprisedb.com/postgresql/postgresql-9.4.24-1-windows-x64-binaries.zip";
        case "mac_os_x":
          return "http://get.enterprisedb.com/postgresql/postgresql-9.4.24-1-osx-binaries.zip";
        default:
          return (0, import_assert_never4.assertNever)(platform);
      }
    case "9.5.19":
      switch (platform) {
        case "linux_x86-32":
          return null;
        case "linux_x86-64":
          return null;
        case "win_x86-32":
          return "http://get.enterprisedb.com/postgresql/postgresql-9.5.19-1-windows-binaries.zip";
        case "win_x86-64":
          return "http://get.enterprisedb.com/postgresql/postgresql-9.5.19-1-windows-x64-binaries.zip";
        case "mac_os_x":
          return "http://get.enterprisedb.com/postgresql/postgresql-9.5.19-1-osx-binaries.zip";
        default:
          return (0, import_assert_never4.assertNever)(platform);
      }
    case "9.6.15":
      switch (platform) {
        case "linux_x86-32":
          return "http://get.enterprisedb.com/postgresql/postgresql-9.6.15-1-linux-binaries.tar.gz";
        case "linux_x86-64":
          return "http://get.enterprisedb.com/postgresql/postgresql-9.6.15-1-linux-x64-binaries.tar.gz";
        case "win_x86-32":
          return "http://get.enterprisedb.com/postgresql/postgresql-9.6.15-1-windows-binaries.zip";
        case "win_x86-64":
          return "http://get.enterprisedb.com/postgresql/postgresql-9.6.15-1-windows-x64-binaries.zip";
        case "mac_os_x":
          return "http://get.enterprisedb.com/postgresql/postgresql-9.6.15-1-osx-binaries.zip";
        default:
          return (0, import_assert_never4.assertNever)(platform);
      }
    case "10.10":
      switch (platform) {
        case "linux_x86-32":
          return "https://get.enterprisedb.com/postgresql/postgresql-10.10-1-linux-binaries.tar.gz";
        case "linux_x86-64":
          return "https://get.enterprisedb.com/postgresql/postgresql-10.10-1-linux-x64-binaries.tar.gz";
        case "win_x86-32":
          return "https://get.enterprisedb.com/postgresql/postgresql-10.10-1-windows-binaries.zip";
        case "win_x86-64":
          return "https://get.enterprisedb.com/postgresql/postgresql-10.10-1-windows-x64-binaries.zip";
        case "mac_os_x":
          return "https://get.enterprisedb.com/postgresql/postgresql-10.10-1-osx-binaries.zip";
        default:
          return (0, import_assert_never4.assertNever)(platform);
      }
    case "11.5":
      switch (platform) {
        case "linux_x86-32":
          return null;
        case "linux_x86-64":
          return null;
        case "win_x86-32":
          return null;
        case "win_x86-64":
          return "https://get.enterprisedb.com/postgresql/postgresql-11.5-1-windows-x64-binaries.zip";
        case "mac_os_x":
          return "https://get.enterprisedb.com/postgresql/postgresql-11.5-1-osx-binaries.zip";
        default:
          return (0, import_assert_never4.assertNever)(platform);
      }
    default:
      return (0, import_assert_never4.assertNever)(postgresVersion);
  }
}
function postgresDirectory(platform, postgresVersion) {
  return path.join(appEnvPaths.cache, postgresVersion + "-" + platform);
}
function checkPostgresInstalled(platform, postgresVersion) {
  return new Promise((resolve) => {
    fs2.stat(postgresDirectory(platform, postgresVersion), (err, stats) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(stats.isDirectory());
    });
  });
}
function downloadFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const stream = (0, import_request.default)(url).pipe(fs2.createWriteStream(filePath));
    stream.on("finish", () => {
      resolve();
    });
    stream.on("error", (err) => {
      reject(err);
    });
  });
}
async function downloadFileWithRetry(url, filePath) {
  const MAX_RETRIES = 10;
  let retryCount = 0;
  while (true) {
    try {
      console.log("Downloading:", url);
      const result = await downloadFile(url, filePath);
      return result;
    } catch (err) {
      retryCount++;
      if (retryCount === MAX_RETRIES) {
        throw err;
      }
      console.log("Error downloading:", url);
      console.log();
      console.log(err);
      console.log();
      console.log("Sleeping...");
      await delay(1e4);
    }
  }
}
function delay(millis) {
  return new Promise((resolve, _reject) => {
    setTimeout(resolve, millis);
  });
}
async function mkdtemp2(prefix) {
  return await new Promise((resolve, reject) => {
    fs2.mkdtemp(prefix, (err, folder) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(folder);
    });
  });
}
async function rimrafIgnoreErrors(filePath) {
  return new Promise((resolve) => {
    (0, import_rimraf.default)(filePath, () => {
      resolve();
    });
  });
}
var TempDir = class {
  static async create() {
    await new Promise((resolve, reject) => {
      fs2.mkdir(path.join(os.tmpdir(), APP_NAME), (err) => {
        if (err && err !== null && err.code !== "EEXIST") {
          reject(err);
          return;
        }
        resolve();
      });
    });
    const directory = await mkdtemp2(path.join(os.tmpdir(), APP_NAME) + path.sep + "tmp-");
    return new TempDir(directory);
  }
  async close() {
    await rimrafIgnoreErrors(this.directory);
  }
  directory;
  constructor(directory) {
    this.directory = directory;
  }
};
async function withTempDir(action) {
  const tempDir = await TempDir.create();
  try {
    const result = await action(tempDir.directory);
    return result;
  } finally {
    await tempDir.close();
  }
}
async function downloadPostgres(platform, postgresVersion, targetDir) {
  const url = postgresDownloadUrl(platform, postgresVersion);
  if (url === null) {
    throw new Error(`Binary Download of PostgreSQL version ${postgresVersion} not available for ${platform}`);
  }
  console.log("Downloading", url);
  await (0, import_make_dir.default)(path.dirname(targetDir));
  const extractDir = await mkdtemp2(targetDir + "-tmp-");
  await withTempDir(async (tmpDir) => {
    const file = path.join(tmpDir, "tmp.tar.gz");
    await downloadFileWithRetry(url, file);
    await (0, import_make_dir.default)(extractDir);
    console.log("extracting to", extractDir);
    if (url.endsWith(".zip")) {
      await new Promise((resolve, reject) => {
        const zip = new import_adm_zip.default(file);
        zip.extractAllToAsync(extractDir, true, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    } else {
      await tar.x({
        file,
        C: extractDir
      });
    }
    try {
      await new Promise((resolve, reject) => {
        fs2.rename(extractDir, targetDir, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    } catch (err) {
      if (err.code === "ENOTEMPTY") {
        console.log(`Target directory already exists (created by a concurrent process)`);
        await rimrafIgnoreErrors(extractDir);
      } else {
        throw err;
      }
    }
  });
  console.log(`PostgreSQL ${postgresVersion} ready`);
}
async function getPostgresBinaryPath(platform, postgresVersion, binaryName) {
  const isInstalled = await checkPostgresInstalled(platform, postgresVersion);
  if (!isInstalled) {
    await downloadPostgres(platform, postgresVersion, postgresDirectory(platform, postgresVersion));
  }
  const ext = platform === "win_x86-32" || platform === "win_x86-64" ? ".exe" : "";
  return path.join(postgresDirectory(platform, postgresVersion), "pgsql", "bin", binaryName + ext);
}
var MIN_PORT = 49152;
var MAX_PORT = 65534;
function randomPort() {
  return MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT));
}
function tryLaunchPostgres(postgres2, dataDir, port) {
  return new Promise((resolve, reject) => {
    const postgresChild = childProcess.spawn(postgres2, ["-F", "-D", dataDir, "-p", `${port}`], { detached: true, env: {} });
    process.on("exit", () => {
      postgresChild.kill();
    });
    let handled = false;
    readline.createInterface({
      input: postgresChild.stderr
    }).on("line", (line) => {
      if (handled) {
        return;
      }
      if (/database system is ready to accept connections/.test(line)) {
        handled = true;
        resolve(postgresChild);
      } else if (/could not bind/.test(line)) {
        handled = true;
        postgresChild.kill();
        resolve(null);
      }
    });
    postgresChild.on("error", (err) => {
      if (handled) {
        return;
      }
      reject(err);
    });
  });
}
var USERNAME = "test";
var PASSWORD = "test";
var PostgresServer = class {
  static async start(postgresVersion) {
    const platform = getCurrentPlatform();
    const initDb = await getPostgresBinaryPath(platform, postgresVersion, "initdb");
    const postgres2 = await getPostgresBinaryPath(platform, postgresVersion, "postgres");
    const tempDir = await TempDir.create();
    try {
      await withTempDir(async (pwTmpDir) => {
        const pwFile = path.join(pwTmpDir, "password.txt");
        await new Promise((resolve, reject) => {
          fs2.writeFile(pwFile, PASSWORD, { encoding: "utf8" }, (err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
        let initDbChild;
        try {
          initDbChild = (0, import_promisify_child_process.spawn)(initDb, ["-D", tempDir.directory, "-N", "-U", USERNAME, "--pwfile", pwFile], { encoding: "utf8", env: {} });
        } catch (err) {
          throw new Error(`initdb failed, error running command "${initDb}": ${err.message}`);
        }
        if (initDbChild.stdout === null) {
          throw new Error("initdb stdout is null");
        }
        if (initDbChild.stderr === null) {
          throw new Error("initdb stdout is null");
        }
        let output = "";
        initDbChild.stdout.on("data", (msg) => {
          output += msg.toString();
        });
        initDbChild.stderr.on("data", (msg) => {
          output += msg.toString();
        });
        try {
          await initDbChild;
        } catch (err) {
          throw new Error(`initdb failed:
${output}`);
        }
      });
      let postgresProc = null;
      let port = 0;
      while (postgresProc === null) {
        port = randomPort();
        postgresProc = await tryLaunchPostgres(postgres2, tempDir.directory, port);
      }
      return new PostgresServer(tempDir, postgresProc, port);
    } catch (err) {
      await tempDir.close();
      throw err;
    }
  }
  async close() {
    const SIGQUIT = 3;
    this.postgresProc.kill(SIGQUIT);
    await new Promise((resolve) => {
      this.postgresProc.on("close", resolve);
    });
    await this.tempDir.close();
  }
  port;
  url;
  tempDir;
  postgresProc;
  constructor(tempDir, postgresProc, port) {
    this.tempDir = tempDir;
    this.postgresProc = postgresProc;
    this.port = port;
    this.url = `postgres://${USERNAME}:${PASSWORD}@127.0.0.1:${this.port}/postgres`;
  }
};

// mfsqlchecker/pg_test_db.ts
var crypto2 = __toESM(require("crypto"));
var fs3 = __toESM(require("fs"));
var path2 = __toESM(require("path"));
var import_pg_connection_string = require("pg-connection-string");
var migrationsRegex = /^V\d+__.*\.sql$/;
function isMigrationFile(fileName) {
  return migrationsRegex.test(fileName);
}
async function calcDbMigrationsHash(migrationsDir) {
  const hash = await calcDirectoryContentsHash("sha1", migrationsDir, isMigrationFile);
  return hash;
}
async function calcDirectoryContentsHash(hashAlgorithm, dir, fileFilter) {
  const allFiles = await readdirAsync(dir);
  const matchingFiles = allFiles.filter(fileFilter).sort();
  const shasum = crypto2.createHash(hashAlgorithm);
  for (const fileName of matchingFiles) {
    shasum.update(fileName);
    const fileHash = await calcFileHash(path2.join(dir, fileName), hashAlgorithm);
    shasum.update(fileHash);
  }
  return shasum.digest("hex");
}
function connReplaceDbName(url, dbName) {
  const p = (0, import_pg_connection_string.parse)(url);
  return `postgres://${p.user}:${p.password}@${p.host}:${p.port}/${dbName}${p.ssl === true ? "?ssl=true" : ""}`;
}
function isTestDatabaseCluster(url) {
  const p = (0, import_pg_connection_string.parse)(url);
  return p.host === "localhost" || p.host === "127.0.0.1";
}
async function createBlankDatabase(conn, dbName) {
  await conn.unsafe(`CREATE DATABASE ${dbName} WITH TEMPLATE template0`);
}
async function dropDatabase(conn, dbName) {
  await conn.unsafe(
    `
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = '${dbName}'
        `
  );
  await conn.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
}
function readdirAsync(dir) {
  return new Promise((resolve, reject) => {
    fs3.readdir(dir, (err, files) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(files);
    });
  });
}
function calcFileHash(filename, hashAlgorithm) {
  return new Promise((resolve, reject) => {
    const shasum = crypto2.createHash(hashAlgorithm);
    try {
      const s = fs3.createReadStream(filename, { encoding: "utf8" });
      s.on("data", (data) => {
        shasum.update(data);
      });
      s.on("error", (err) => {
        reject(err);
      });
      s.on("end", () => {
        const hash = shasum.digest("hex");
        resolve(hash);
      });
    } catch (error) {
      reject("calc fail");
    }
  });
}
function testDatabaseName() {
  return new Promise((resolve, reject) => {
    crypto2.randomBytes(16, (err, buf) => {
      if (err) {
        reject(err);
        return;
      }
      const dbName = "db_test_" + buf.toString("hex");
      resolve(dbName);
    });
  });
}

// eslint-local-rules/rules/DbConnector.ts
var import_assert_never5 = require("assert-never");
var import_chalk3 = __toESM(require("chalk"));
var import_cli_progress = require("cli-progress");
var fs4 = __toESM(require("fs"));
var path3 = __toESM(require("path"));
var import_tiny_invariant = __toESM(require("tiny-invariant"));
var TE = __toESM(require("fp-ts/TaskEither"));
var E = __toESM(require("fp-ts/Either"));
var import_function = require("fp-ts/function");

// mfsqlchecker/source_maps.ts
function resolveFromSourceMap(fileContents, position, sourceMap) {
  if (sourceMap.length === 0) {
    throw new Error("Empty sourceMap");
  }
  let i = 0;
  while (true) {
    if (position >= sourceMap[i][1] && position < sourceMap[i][2]) {
      return toSrcSpan(fileContents, sourceMap[i][0] + (position - sourceMap[i][1]));
    }
    if (position < sourceMap[i][1]) {
      if (i > 0) {
        const start = toSrcSpan(fileContents, sourceMap[i - 1][0] + sourceMap[i - 1][2] - sourceMap[i - 1][1]);
        const end = toSrcSpan(fileContents, sourceMap[i][0]);
        return {
          type: "LineAndColRange",
          startLine: start.line,
          startCol: start.col,
          endLine: end.line,
          endCol: end.col
        };
      } else {
        return toSrcSpan(fileContents, sourceMap[0][0]);
      }
    }
    if (i === sourceMap.length - 1) {
      return toSrcSpan(fileContents, sourceMap[i][0] + sourceMap[i][2] - sourceMap[i][1] - 1);
    }
    i++;
  }
}

// eslint-local-rules/rules/DbConnector.ts
function runnerLog(...args) {
  console.log(import_chalk3.default.grey(`[${(/* @__PURE__ */ new Date()).toISOString()}]`), import_chalk3.default.green(`QueryRunner:`), ...args);
}
var QueryRunner = class {
  migrationsDir;
  client;
  constructor(config2) {
    this.migrationsDir = config2.migrationsDir;
    this.client = config2.client;
  }
  static async Connect(params) {
    const client = await newConnect(params.adminUrl, params.name);
    return new QueryRunner({ migrationsDir: params.migrationsDir, client });
  }
  static ConnectTE(params) {
    return (0, import_function.pipe)(
      TE.tryCatch(() => QueryRunner.Connect(params), E.toError),
      TE.mapLeft((err) => {
        const errors = [];
        const pgError = parsePostgreSqlError(err);
        if (pgError !== null) {
          errors.push(
            "Error connecting to database cluster:",
            pgError.message,
            `code: ${pgError.code}`
          );
          if (pgError.detail !== null && pgError.detail !== pgError.message) {
            errors.push("detail: " + pgError.detail);
          }
          if (pgError.hint !== null) {
            errors.push("hint: " + pgError.hint);
          }
          return new Error(errors.join("\n"));
        }
        if ("code" in err) {
          errors.push("Error connecting to database cluster:", err.message);
          return new Error(errors.join("\n"));
        }
        return err;
      })
    );
  }
  dbMigrationsHash = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  prevUniqueTableColumnTypes = [];
  queryCache = new QueryMap();
  insertCache = new InsertMap();
  viewNames = [];
  pgTypes = /* @__PURE__ */ new Map();
  uniqueColumnTypes = /* @__PURE__ */ new Map();
  tableColsLibrary = new TableColsLibrary();
  prevStrictDateTimeChecking = null;
  async initialize(params) {
    this.queryCache = new QueryMap();
    this.insertCache = new InsertMap();
    const hash = await calcDbMigrationsHash(this.migrationsDir);
    if (this.dbMigrationsHash !== hash || !equalsUniqueTableColumnTypes(
      params.uniqueTableColumnTypes,
      this.prevUniqueTableColumnTypes
    )) {
      this.dbMigrationsHash = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      this.queryCache.clear();
      this.insertCache.clear();
      await this.dropViews();
      await dropAllTables(this.client);
      await dropAllSequences(this.client);
      await dropAllTypes(this.client);
      await dropAllFunctions(this.client);
      const allFiles = await readdirAsync(this.config.migrationsDir);
      const matchingFiles = allFiles.filter(isMigrationFile).sort();
      for (const matchingFile of matchingFiles) {
        runnerLog("running migration", matchingFile);
        const text = await readFileAsync(
          path3.join(this.config.migrationsDir, matchingFile)
        );
        try {
          await this.client.unsafe(text);
        } catch (err) {
          const postgresError = parsePostgreSqlError(err);
          if (postgresError === null) {
            throw err;
          }
          const errorDiagnostic = postgresqlErrorDiagnostic(
            path3.join(this.config.migrationsDir, matchingFile),
            text,
            postgresError,
            postgresError.position !== null ? toSrcSpan(text, postgresError.position) : { type: "File" },
            "Error in migration file"
          );
          return [errorDiagnostic];
        }
      }
      this.prevUniqueTableColumnTypes = params.uniqueTableColumnTypes;
      this.uniqueColumnTypes = makeUniqueColumnTypes(this.prevUniqueTableColumnTypes);
      runnerLog("start applying unique table column types...");
      await applyUniqueTableColumnTypes(this.client, this.prevUniqueTableColumnTypes);
      runnerLog("done applying unique table column types");
      await this.tableColsLibrary.refreshTables(this.client);
      this.pgTypes = /* @__PURE__ */ new Map();
      const pgTypesResult = await this.client.unsafe(
        `
                SELECT
                    oid,
                    typname
                FROM pg_type
                ORDER BY oid
                `
      );
      for (const row of pgTypesResult) {
        const oid = row["oid"];
        const typname = row["typname"];
        this.pgTypes.set(oid, SqlType.wrap(typname));
      }
      this.dbMigrationsHash = hash;
    }
    if (params.strictDateTimeChecking !== this.prevStrictDateTimeChecking) {
      await this.dropViews();
    }
    this.prevStrictDateTimeChecking = params.strictDateTimeChecking;
    let queryErrors2 = [];
    const [updated, newViewNames] = await updateViews(
      this.client,
      params.strictDateTimeChecking,
      this.viewNames,
      params.viewLibrary
    );
    if (updated) {
      await this.tableColsLibrary.refreshViews(this.client);
    }
    this.viewNames = newViewNames;
    for (const [viewName, viewAnswer] of this.viewNames) {
      const createView = params.viewLibrary.find((x2) => x2.viewName === viewName);
      (0, import_tiny_invariant.default)(createView !== void 0, `view ${viewName} not found (probably a bug).`);
      queryErrors2 = queryErrors2.concat(viewAnswerToErrorDiagnostics(createView, viewAnswer));
    }
    if (params.strictDateTimeChecking) {
      await modifySystemCatalogs(this.client);
    }
  }
  async runQuery(params) {
    const description = await this.client.unsafe(params.query, [], { prepare: true }).describe();
    return description;
  }
  async x() {
    const queriesProgressBar = new import_cli_progress.Bar(
      {
        clearOnComplete: true,
        etaBuffer: 50
      },
      import_cli_progress.Presets.legacy
    );
    queriesProgressBar.start(manifest.queries.length, 0);
    try {
      let i = 0;
      for (const query of manifest.queries) {
        switch (query.type) {
          case "ResolvedSelect": {
            const cachedResult = this.queryCache.get(
              query.value.text,
              query.value.colTypes
            );
            if (cachedResult !== void 0) {
              queryErrors = queryErrors.concat(
                queryAnswerToErrorDiagnostics(
                  query.value,
                  cachedResult,
                  manifest.colTypesFormat
                )
              );
              newQueryCache.set(query.value.text, query.value.colTypes, cachedResult);
            } else {
              const result = await processQuery(
                this.client,
                manifest.colTypesFormat,
                this.pgTypes,
                this.tableColsLibrary,
                this.uniqueColumnTypes,
                query.value
              );
              newQueryCache.set(query.value.text, query.value.colTypes, result);
              queryErrors = queryErrors.concat(
                queryAnswerToErrorDiagnostics(
                  query.value,
                  result,
                  manifest.colTypesFormat
                )
              );
            }
            break;
          }
          case "ResolvedInsert": {
            const cachedResult = this.insertCache.get(
              query.value.text,
              query.value.colTypes,
              query.value.tableName,
              query.value.insertColumns
            );
            if (cachedResult !== void 0) {
              queryErrors = queryErrors.concat(
                insertAnswerToErrorDiagnostics(
                  query.value,
                  cachedResult,
                  manifest.colTypesFormat
                )
              );
              newInsertCache.set(
                query.value.text,
                query.value.colTypes,
                query.value.tableName,
                query.value.insertColumns,
                cachedResult
              );
            } else {
              const result = await processInsert(
                this.client,
                manifest.colTypesFormat,
                this.pgTypes,
                this.tableColsLibrary,
                this.uniqueColumnTypes,
                query.value
              );
              newInsertCache.set(
                query.value.text,
                query.value.colTypes,
                query.value.tableName,
                query.value.insertColumns,
                result
              );
              queryErrors = queryErrors.concat(
                insertAnswerToErrorDiagnostics(
                  query.value,
                  result,
                  manifest.colTypesFormat
                )
              );
            }
            break;
          }
          default:
            (0, import_assert_never5.assertNever)(query);
        }
        queriesProgressBar.update(++i);
      }
    } finally {
      queriesProgressBar.stop();
    }
    await this.client.unsafe("ROLLBACK");
    this.queryCache = newQueryCache;
    this.insertCache = newInsertCache;
    let finalErrors = [];
    for (const query of manifest.queries) {
      switch (query.type) {
        case "ResolvedSelect":
          finalErrors = finalErrors.concat(query.value.errors);
          break;
        case "ResolvedInsert":
          finalErrors = finalErrors.concat(query.value.errors);
          break;
        default:
          (0, import_assert_never5.assertNever)(query);
      }
    }
    return finalErrors.concat(queryErrors);
  }
  async dropViews() {
    for (let i = this.viewNames.length - 1; i >= 0; --i) {
      const viewName = this.viewNames[i];
      await dropView(this.client, viewName[0]);
    }
    this.viewNames = [];
  }
};
async function dropView(client, viewName) {
  await client.unsafe(`DROP VIEW IF EXISTS ${escapeIdentifier(viewName)}`);
}
async function updateViews(client, strictDateTimeChecking, oldViews, newViews) {
  let updated = false;
  const newViewNames = /* @__PURE__ */ new Set();
  newViews.forEach((v) => newViewNames.add(v.viewName));
  for (let i = oldViews.length - 1; i >= 0; --i) {
    const viewName = oldViews[i];
    if (!newViewNames.has(viewName[0])) {
      await dropView(client, viewName[0]);
      updated = true;
    }
  }
  const oldViewAnswers = /* @__PURE__ */ new Map();
  oldViews.forEach(([viewName, viewAnswer]) => oldViewAnswers.set(viewName, viewAnswer));
  const result = [];
  for (const view of newViews) {
    const oldAnswer = oldViewAnswers.get(view.viewName);
    if (oldAnswer !== void 0) {
      result.push([view.viewName, oldAnswer]);
    } else {
      const answer = await processCreateView(client, strictDateTimeChecking, view);
      result.push([view.viewName, answer]);
      updated = true;
    }
  }
  return [updated, result];
}
var SELECT_STAR_REGEX = new RegExp("(select|\\.|\\,)\\s*\\*", "i");
function validateViewFeatures(view) {
  const searchIndex = view.createQuery.search(SELECT_STAR_REGEX);
  if (searchIndex >= 0) {
    return {
      type: "InvalidFeatureError",
      viewName: view.viewName,
      message: "SELECT * not allowed in views. List all columns explicitly",
      position: view.createQuery.indexOf("*", searchIndex) + 1
    };
  }
  return {
    type: "NoErrors"
  };
}
async function processCreateView(client, strictDateTimeChecking, view) {
  await client.unsafe("BEGIN");
  if (strictDateTimeChecking) {
    await modifySystemCatalogs(client);
  }
  try {
    await client.unsafe(
      `CREATE OR REPLACE VIEW ${escapeIdentifier(view.viewName)} AS ${view.createQuery}`
    );
  } catch (err) {
    const perr = parsePostgreSqlError(err);
    if (perr === null) {
      throw err;
    } else {
      await client.unsafe("ROLLBACK");
      if (perr.position !== null) {
        perr.position -= `CREATE OR REPLACE VIEW ${escapeIdentifier(
          view.viewName
        )} AS `.length;
      }
      return {
        type: "CreateError",
        viewName: QualifiedSqlViewName.viewName(view.qualifiedViewname),
        perr
      };
    }
  }
  await client.unsafe("ROLLBACK");
  await client.unsafe(
    `CREATE OR REPLACE VIEW ${escapeIdentifier(view.viewName)} AS ${view.createQuery}`
  );
  const invalidFeatureError = validateViewFeatures(view);
  if (invalidFeatureError.type !== "NoErrors") {
    return invalidFeatureError;
  }
  return {
    type: "NoErrors"
  };
}
function viewAnswerToErrorDiagnostics(createView, viewAnswer) {
  switch (viewAnswer.type) {
    case "NoErrors":
      return [];
    case "CreateError": {
      const message = 'Error in view "' + import_chalk3.default.bold(viewAnswer.viewName) + '"';
      if (viewAnswer.perr.position !== null) {
        const srcSpan = resolveFromSourceMap(
          createView.fileContents,
          viewAnswer.perr.position - 1,
          createView.sourceMap
        );
        return [
          postgresqlErrorDiagnostic(
            createView.fileName,
            createView.fileContents,
            viewAnswer.perr,
            srcSpan,
            message
          )
        ];
      } else {
        return [
          postgresqlErrorDiagnostic(
            createView.fileName,
            createView.fileContents,
            viewAnswer.perr,
            querySourceStart(createView.fileContents, createView.sourceMap),
            message
          )
        ];
      }
    }
    case "InvalidFeatureError": {
      const srcSpan = resolveFromSourceMap(
        createView.fileContents,
        viewAnswer.position - 1,
        createView.sourceMap
      );
      return [
        {
          fileName: createView.fileName,
          fileContents: createView.fileContents,
          span: srcSpan,
          messages: [
            import_chalk3.default.bold('Error in view "' + import_chalk3.default.bold(viewAnswer.viewName) + '"'),
            viewAnswer.message
          ],
          epilogue: null,
          quickFix: null
        }
      ];
    }
    default:
      return (0, import_assert_never5.assertNever)(viewAnswer);
  }
}
var QueryMap = class {
  set(text, colTypes, value) {
    this.internalMap.set(QueryMap.toKey(text, colTypes), value);
  }
  get(text, colTypes) {
    return this.internalMap.get(QueryMap.toKey(text, colTypes));
  }
  clear() {
    this.internalMap = /* @__PURE__ */ new Map();
  }
  static toKey(text, colTypes) {
    return text + (colTypes === null ? "[NULL]" : stringifyColTypes(colTypes));
  }
  internalMap = /* @__PURE__ */ new Map();
};
var InsertMap = class {
  set(text, colTypes, tableName, insertColumns, value) {
    this.internalMap.set(InsertMap.toKey(text, colTypes, tableName, insertColumns), value);
  }
  get(text, colTypes, tableName, insertColumns) {
    return this.internalMap.get(InsertMap.toKey(text, colTypes, tableName, insertColumns));
  }
  clear() {
    this.internalMap = /* @__PURE__ */ new Map();
  }
  static toKey(text, colTypes, tableName, insertColumns) {
    return text + (colTypes === null ? "" : stringifyColTypes(colTypes)) + '"' + tableName + '"' + stringifyInsertColumns(insertColumns);
  }
  internalMap = /* @__PURE__ */ new Map();
};
function stringifyInsertColumns(insertColumns) {
  const keys = [...insertColumns.keys()];
  keys.sort();
  let result = "";
  for (const key of keys) {
    const value = insertColumns.get(key);
    if (value === void 0) {
      throw new Error("The Impossible Happened");
    }
    result += `${JSON.stringify(key)}:[${value[0]}, ${value[1]}]
`;
  }
  return result;
}
function querySourceStart(fileContents, sourceMap) {
  return toSrcSpan(
    fileContents,
    fileContents.slice(sourceMap[0][0] + 1).search(/\S/) + sourceMap[0][0] + 2
  );
}
function queryAnswerToErrorDiagnostics(query, queryAnswer, colTypesFormat) {
  switch (queryAnswer.type) {
    case "NoErrors":
      return [];
    case "DescribeError":
      if (queryAnswer.perr.position !== null) {
        const srcSpan = resolveFromSourceMap(
          query.fileContents,
          queryAnswer.perr.position - 1,
          query.sourceMap
        );
        return [
          postgresqlErrorDiagnostic(
            query.fileName,
            query.fileContents,
            queryAnswer.perr,
            srcSpan,
            null
          )
        ];
      } else {
        return [
          postgresqlErrorDiagnostic(
            query.fileName,
            query.fileContents,
            queryAnswer.perr,
            querySourceStart(query.fileContents, query.sourceMap),
            null
          )
        ];
      }
    case "DuplicateColNamesError":
      return [
        {
          fileName: query.fileName,
          fileContents: query.fileContents,
          span: querySourceStart(query.fileContents, query.sourceMap),
          messages: [
            `Query return row contains duplicate column names:
${JSON.stringify(
              queryAnswer.duplicateResultColumns,
              null,
              2
            )}`
          ],
          epilogue: import_chalk3.default.bold("hint") + ': Specify a different name for the column using the Sql "AS" keyword',
          quickFix: null
        }
      ];
    case "WrongColumnTypes":
      let replacementText;
      let colTypes = queryAnswer.renderedColTypes.split("\n");
      if (colTypes.length <= 2) {
        replacementText = "<{}>";
      } else if (colTypes.length === 3) {
        colTypes = colTypes.map((c) => c.trimLeft());
        colTypes[1] = " ".repeat(query.indentLevel + 4) + colTypes[1];
        colTypes[2] = " ".repeat(query.indentLevel) + colTypes[2];
        replacementText = "<" + colTypes.join("\n") + ">";
      } else if (colTypes.length > 3) {
        colTypes = colTypes.map((c) => c.trimLeft());
        for (let i = 1; i < colTypes.length - 1; ++i) {
          colTypes[i] = " ".repeat(query.indentLevel + 4) + colTypes[i];
        }
        colTypes[colTypes.length - 1] = " ".repeat(query.indentLevel) + colTypes[colTypes.length - 1];
        if (colTypesFormat.includeRegionMarker) {
          colTypes.splice(1, 0, " ".repeat(query.indentLevel + 4) + "//#region ColTypes");
          colTypes.splice(
            colTypes.length - 1,
            0,
            " ".repeat(query.indentLevel + 4) + "//#endregion"
          );
        }
        replacementText = "<" + colTypes.join("\n") + ">";
      } else {
        throw new Error(`Invalid colTypes.length: ${queryAnswer.renderedColTypes}`);
      }
      if (query.queryMethodName !== null) {
        replacementText = query.queryMethodName + replacementText;
      }
      return [
        {
          fileName: query.fileName,
          fileContents: query.fileContents,
          span: query.colTypeSpan,
          messages: ["Wrong Column Types"],
          epilogue: import_chalk3.default.bold("Fix it to:") + "\n" + queryAnswer.renderedColTypes,
          quickFix: {
            name: "Fix Column Types",
            replacementText
          }
        }
      ];
    default:
      return (0, import_assert_never5.assertNever)(queryAnswer);
  }
}
function insertAnswerToErrorDiagnostics(query, queryAnswer, colTypesFormat) {
  switch (queryAnswer.type) {
    case "NoErrors":
      return [];
    case "DescribeError":
    case "DuplicateColNamesError":
    case "WrongColumnTypes":
      return queryAnswerToErrorDiagnostics(query, queryAnswer, colTypesFormat);
    case "InvalidTableName":
      return [
        {
          fileName: query.fileName,
          fileContents: query.fileContents,
          span: query.tableNameExprSpan,
          messages: [`Table does not exist: "${query.tableName}"`],
          epilogue: null,
          quickFix: null
        }
      ];
    case "InvalidInsertCols":
      return [
        {
          fileName: query.fileName,
          fileContents: query.fileContents,
          span: query.insertExprSpan,
          messages: ["Inserted columns are invalid:"].concat(
            queryAnswer.invalidCols.map((e) => {
              switch (e.type) {
                case "MissingRequiredCol":
                  return `Insert to table "${e.tableName}" is missing the required column: "${e.colName}" (type "${e.colType}")`;
                case "ColWrongType":
                  return `Insert to table "${e.tableName}" has the wrong type for column "${e.colName}". It should be "${e.colType}" (instead of "${e.invalidType}")`;
                case "ColNotFound":
                  return `Column "${e.colName}" does not exist on table "${e.tableName}"`;
                default:
                  return (0, import_assert_never5.assertNever)(e);
              }
            })
          ),
          epilogue: null,
          quickFix: null
        }
      ];
    default:
      return (0, import_assert_never5.assertNever)(queryAnswer);
  }
}
async function processQuery(client, colTypesFormat, pgTypes, tableColsLibrary, uniqueColumnTypes, query) {
  let fields;
  const savepoint = await newSavepoint(client);
  try {
    fields = await pgDescribeQuery(client, query.text);
  } catch (err) {
    const perr = parsePostgreSqlError(err);
    if (perr === null) {
      throw err;
    } else {
      await rollbackToAndReleaseSavepoint(client, savepoint);
      return {
        type: "DescribeError",
        perr
      };
    }
  }
  await rollbackToAndReleaseSavepoint(client, savepoint);
  const duplicateResultColumns = [];
  if (fields === null) {
    if (query.colTypes !== null && query.colTypes.size !== 0) {
      return {
        type: "WrongColumnTypes",
        renderedColTypes: "{} (Or no type argument at all)"
      };
    }
  } else {
    for (let i = 0; i < fields.length; ++i) {
      const field = fields[i];
      if (fields.slice(i + 1).findIndex((f) => f.name === field.name) >= 0 && duplicateResultColumns.indexOf(field.name) < 0) {
        duplicateResultColumns.push(field.name);
      }
    }
    if (duplicateResultColumns.length > 0) {
      return {
        type: "DuplicateColNamesError",
        duplicateResultColumns
      };
    }
    const sqlFields = resolveFieldDefs(tableColsLibrary, pgTypes, uniqueColumnTypes, fields);
    if (query.colTypes !== null && stringifyColTypes(query.colTypes) !== stringifyColTypes(sqlFields)) {
      return {
        type: "WrongColumnTypes",
        renderedColTypes: renderColTypesType(colTypesFormat, sqlFields)
      };
    }
  }
  return {
    type: "NoErrors"
  };
}
async function processInsert(client, colTypesFormat, pgTypes, tableColsLibrary, uniqueColumnTypes, query) {
  const tableQuery = await client.unsafe(
    `
        select
            pg_attribute.attname,
            pg_type.typname,
            pg_attribute.atthasdef,
            pg_attribute.attnotnull
        from
            pg_attribute,
            pg_class,
            pg_type
        where
        pg_attribute.attrelid = pg_class.oid
        AND pg_attribute.attnum >= 1
        AND pg_attribute.atttypid = pg_type.oid
        AND pg_class.relname = $1
        ORDER BY pg_attribute.attname
        `,
    [query.tableName]
  );
  if (tableQuery.count === 0) {
    return {
      type: "InvalidTableName"
    };
  }
  const result = await processQuery(
    client,
    colTypesFormat,
    pgTypes,
    tableColsLibrary,
    uniqueColumnTypes,
    query
  );
  if (result.type !== "NoErrors") {
    return result;
  }
  const insertColumnFields = [...query.insertColumns.keys()];
  insertColumnFields.sort();
  const invalidInsertCols = [];
  for (const field of insertColumnFields) {
    const suppliedType = query.insertColumns.get(field);
    if (suppliedType === void 0) {
      throw new Error("The Impossible Happened");
    }
    const [suppliedTypeName, suppliedTypeNotNull] = suppliedType;
    const row = tableQuery.find((r) => r["attname"] === field);
    if (row === void 0) {
      invalidInsertCols.push({
        type: "ColNotFound",
        tableName: query.tableName,
        colName: field,
        invalidType: suppliedTypeName
      });
    } else {
      const typname = row["typname"];
      const attnotnull = row["attnotnull"];
      const tblType = sqlTypeToTypeScriptType(uniqueColumnTypes, SqlType.wrap(typname));
      if (suppliedTypeName !== TypeScriptType.wrap("null") && suppliedTypeName !== tblType || attnotnull && !suppliedTypeNotNull) {
        let suppliedTypeStr = TypeScriptType.unwrap(suppliedTypeName);
        if (!suppliedTypeNotNull && suppliedTypeStr !== "null") {
          suppliedTypeStr += " | null";
        }
        let typStr = TypeScriptType.unwrap(tblType);
        if (!attnotnull) {
          typStr += " | null";
        }
        invalidInsertCols.push({
          type: "ColWrongType",
          tableName: query.tableName,
          colName: field,
          colType: TypeScriptType.wrap(typStr),
          invalidType: TypeScriptType.wrap(suppliedTypeStr)
        });
      }
    }
  }
  for (const row of tableQuery) {
    const attname = row["attname"];
    const typname = row["typname"];
    const atthasdef = row["atthasdef"];
    const attnotnull = row["attnotnull"];
    if (!atthasdef) {
      if (!query.insertColumns.has(attname)) {
        let typStr = TypeScriptType.unwrap(
          sqlTypeToTypeScriptType(uniqueColumnTypes, SqlType.wrap(typname))
        );
        if (!attnotnull) {
          typStr += " | null";
        }
        invalidInsertCols.push({
          type: "MissingRequiredCol",
          tableName: query.tableName,
          colName: attname,
          colType: TypeScriptType.wrap(typStr)
        });
      }
    }
  }
  if (invalidInsertCols.length > 0) {
    return {
      type: "InvalidInsertCols",
      invalidCols: invalidInsertCols
    };
  } else {
    return {
      type: "NoErrors"
    };
  }
}
function psqlOidSqlType(pgTypes, oid) {
  const name = pgTypes.get(oid);
  if (name === void 0) {
    throw new Error(`pg_type oid ${oid} not found`);
  }
  return name;
}
var TableColsLibrary = class {
  /**
   * After calling this method, you should also call `refreshViews`
   */
  async refreshTables(client) {
    this.tableLookupTable = /* @__PURE__ */ new Map();
    const queryResult = await client.unsafe(
      `
            SELECT
                a.attrelid,
                a.attnum,
                a.attnotnull
            FROM
            pg_catalog.pg_attribute a,
            pg_catalog.pg_class c
            WHERE
            c.oid = a.attrelid
            AND a.attnum > 0
            AND c.relkind = 'r'
            `
    );
    for (const row of queryResult) {
      const attrelid = row["attrelid"];
      const attnum = row["attnum"];
      const attnotnull = row["attnotnull"];
      this.tableLookupTable.set(`${attrelid}-${attnum}`, attnotnull);
    }
  }
  async refreshViews(client) {
    this.viewLookupTable = /* @__PURE__ */ new Map();
    const queryResult = await client.unsafe(
      `
            with recursive
            views as (
              select
                c.oid       as view_id,
                n.nspname   as view_schema,
                c.relname   as view_name,
                c.oid       as view_oid,
                r.ev_action as view_definition
              from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
              join pg_rewrite r on r.ev_class = c.oid
              where c.relkind in ('v', 'm') and n.nspname = 'public'
            ),
            transform_json as (
              select
                view_id, view_schema, view_name, view_oid,
                -- the following formatting is without indentation on purpose
                -- to allow simple diffs, with less whitespace noise
                replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  regexp_replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                  replace(
                    view_definition::text,
                  -- This conversion to json is heavily optimized for performance.
                  -- The general idea is to use as few regexp_replace() calls as possible.
                  -- Simple replace() is a lot faster, so we jump through some hoops
                  -- to be able to use regexp_replace() only once.
                  -- This has been tested against a huge schema with 250+ different views.
                  -- The unit tests do NOT reflect all possible inputs. Be careful when changing this!
                  -- -----------------------------------------------
                  -- pattern           | replacement         | flags
                  -- -----------------------------------------------
                  -- "," is not part of the pg_node_tree format, but used in the regex.
                  -- This removes all "," that might be part of column names.
                      ','               , ''
                  -- The same applies for "{" and "}", although those are used a lot in pg_node_tree.
                  -- We remove the escaped ones, which might be part of column names again.
                  ), '\\{'              , ''
                  ), '\\}'              , ''
                  -- The fields we need are formatted as json manually to protect them from the regex.
                  ), ' :targetList '   , ',"targetList":'
                  ), ' :resno '        , ',"resno":'
                  ), ' :resorigtbl '   , ',"resorigtbl":'
                  ), ' :resorigcol '   , ',"resorigcol":'
                  -- Make the regex also match the node type, e.g. "{QUERY ...", to remove it in one pass.
                  ), '{'               , '{ :'
                  -- Protect node lists, which start with "({" or "((" from the greedy regex.
                  -- The extra "{" is removed again later.
                  ), '(('              , '{(('
                  ), '({'              , '{({'
                  -- This regex removes all unused fields to avoid the need to format all of them correctly.
                  -- This leads to a smaller json result as well.
                  -- Removal stops at "," for used fields (see above) and "}" for the end of the current node.
                  -- Nesting can't be parsed correctly with a regex, so we stop at "{" as well and
                  -- add an empty key for the followig node.
                  ), ' :[^}{,]+'       , ',"":'              , 'g'
                  -- For performance, the regex also added those empty keys when hitting a "," or "}".
                  -- Those are removed next.
                  ), ',"":}'           , '}'
                  ), ',"":,'           , ','
                  -- This reverses the "node list protection" from above.
                  ), '{('              , '('
                  -- Every key above has been added with a "," so far. The first key in an object doesn't need it.
                  ), '{,'              , '{'
                  -- pg_node_tree has "()" around lists, but JSON uses "[]"
                  ), '('               , '['
                  ), ')'               , ']'
                  -- pg_node_tree has " " between list items, but JSON uses ","
                  ), ' '             , ','
                  -- "<>" in pg_node_tree is the same as "null" in JSON, but due to very poor performance of json_typeof
                  -- we need to make this an empty array here to prevent json_array_elements from throwing an error
                  -- when the targetList is null.
                  ), '<>'              , '[]'
                )::json as view_definition
              from views
            ),
            target_entries as(
              select
                view_id, view_schema, view_name, view_oid,
                json_array_elements(view_definition->0->'targetList') as entry
              from transform_json
            ),
            results as(
              select
                view_id, view_schema, view_name, view_oid,
                (entry->>'resno')::int as view_column,
                (entry->>'resorigtbl')::oid as resorigtbl,
                (entry->>'resorigcol')::int as resorigcol
              from target_entries
            ),
            recursion as(
              select r.*
              from results r
              where view_schema = 'public'
              union all
              select
                view.view_id,
                view.view_schema,
                view.view_name,
                view.view_oid,
                view.view_column,
                tab.resorigtbl,
                tab.resorigcol
              from recursion view
              join results tab on view.resorigtbl=tab.view_id and view.resorigcol=tab.view_column
            )
            select
              -- sch.nspname as table_schema,
              -- tbl.relname as table_name,
              tbl.oid as table_oid,
              -- col.attname as table_column_name,
              col.attnum as table_column_num,
              -- rec.view_schema,
              -- rec.view_name,
              rec.view_oid,
              -- vcol.attname as view_column_name,
              vcol.attnum as view_column_num
            from recursion rec
            join pg_class tbl on tbl.oid = rec.resorigtbl
            join pg_attribute col on col.attrelid = tbl.oid and col.attnum = rec.resorigcol
            join pg_attribute vcol on vcol.attrelid = rec.view_id and vcol.attnum = rec.view_column
            join pg_namespace sch on sch.oid = tbl.relnamespace
            order by view_oid, view_column_num
            `
    );
    for (const row of queryResult) {
      const viewOid = row["view_oid"];
      const viewColumnNum = row["view_column_num"];
      const tableOid = row["table_oid"];
      const tableColumnNum = row["table_column_num"];
      const isNotNull = this.isNotNull(tableOid, tableColumnNum);
      this.viewLookupTable.set(`${viewOid}-${viewColumnNum}`, isNotNull);
    }
  }
  isNotNull(tableID, columnID) {
    const notNull1 = this.tableLookupTable.get(`${tableID}-${columnID}`);
    if (notNull1 !== void 0) {
      return notNull1;
    }
    const notNull2 = this.viewLookupTable.get(`${tableID}-${columnID}`);
    if (notNull2 !== void 0) {
      return notNull2;
    }
    return false;
  }
  tableLookupTable = /* @__PURE__ */ new Map();
  viewLookupTable = /* @__PURE__ */ new Map();
};
function resolveFieldDefs(tableColsLibrary, pgTypes, uniqueColumnTypes, fields) {
  const result = /* @__PURE__ */ new Map();
  for (const field of fields) {
    const sqlType = psqlOidSqlType(pgTypes, field.type);
    let colNullability = 1 /* OPT */;
    if (field.table > 0) {
      const notNull = tableColsLibrary.isNotNull(field.table, field.number);
      if (notNull) {
        colNullability = 0 /* REQ */;
      }
    }
    const typeScriptType = sqlTypeToTypeScriptType(uniqueColumnTypes, sqlType);
    result.set(field.name, [colNullability, typeScriptType]);
  }
  return result;
}
function sqlTypeToTypeScriptType(uniqueColumnTypes, sqlType) {
  if (SqlType.unwrap(sqlType).startsWith("_")) {
    const elemType = sqlTypeToTypeScriptType(
      uniqueColumnTypes,
      SqlType.wrap(SqlType.unwrap(sqlType).substring(1))
    );
    return TypeScriptType.wrap(`(${TypeScriptType.unwrap(elemType)} | null)[]`);
  }
  switch (SqlType.unwrap(sqlType)) {
    case "int2":
    case "int4":
    case "int8":
      return TypeScriptType.wrap("number");
    case "text":
      return TypeScriptType.wrap("string");
    case "bool":
      return TypeScriptType.wrap("boolean");
    case "float4":
    case "float8":
      return TypeScriptType.wrap("number");
    case "jsonb":
      return TypeScriptType.wrap("DbJson");
    case "timestamp":
      return TypeScriptType.wrap("LocalDateTime");
    case "timestamptz":
      return TypeScriptType.wrap("Instant");
    case "date":
      return TypeScriptType.wrap("LocalDate");
    case "time":
      return TypeScriptType.wrap("LocalTime");
    case "uuid":
      return TypeScriptType.wrap("UUID");
    default:
  }
  const uniqueType = uniqueColumnTypes.get(sqlType);
  if (uniqueType !== void 0) {
    return uniqueType;
  }
  return TypeScriptType.wrap(`/* sqlTypeToTypeScriptType Unknown/Invalid type: "${sqlType}" */`);
}
function colNullabilityStr(colNullability) {
  switch (colNullability) {
    case 0 /* REQ */:
      return "Req";
    case 1 /* OPT */:
      return "Opt";
    default:
      return (0, import_assert_never5.assertNever)(colNullability);
  }
}
function renderIdentifier(ident) {
  return ident;
}
function renderColTypesType(colTypesFormat, colTypes) {
  if (colTypes.size === 0) {
    return "{}";
  }
  let result = "{\n";
  const delim = colTypesFormat.delimiter;
  colTypes.forEach((value, key) => {
    result += `  ${renderIdentifier(key)}: ${colNullabilityStr(
      value[0]
    )}<${TypeScriptType.unwrap(value[1])}>${delim}
`;
  });
  switch (delim) {
    case ",":
      result = result.substr(0, result.length - 2);
      break;
    case ";":
      result = result.substr(0, result.length - 1);
      break;
    default:
      return (0, import_assert_never5.assertNever)(delim);
  }
  result += "\n}";
  return result;
}
function stringifyColTypes(colTypes) {
  const keys = [...colTypes.keys()];
  keys.sort();
  let result = "";
  for (const key of keys) {
    const value = colTypes.get(key);
    if (value === void 0) {
      throw new Error("The Impossible Happened");
    }
    result += `${JSON.stringify(key)}:${value[0]} ${value[1]}
`;
  }
  return result;
}
async function newConnect(adminUrl, name) {
  const newDbName = name !== void 0 ? name : await testDatabaseName();
  const adminConn1 = connectPg(adminUrl);
  try {
    if (name !== void 0) {
      await dropDatabase(adminConn1, name);
    }
    await createBlankDatabase(adminConn1, newDbName);
  } finally {
    await closePg(adminConn1);
  }
  const client = connectPg(connReplaceDbName(adminUrl, newDbName));
  return client;
}
function readFileAsync(fileName) {
  return new Promise((resolve, reject) => {
    fs4.readFile(fileName, { encoding: "utf-8" }, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}
async function queryTableColumn(client, tableName, columnName) {
  const result = await client.unsafe(
    `
        SELECT
        pg_class.oid AS tbloid,
        pg_attribute.attnum AS attnum,
        pg_type.typname AS typname
        FROM
        pg_attribute,
        pg_class,
        pg_type
        WHERE TRUE
        AND pg_class.oid = pg_attribute.attrelid
        AND pg_type.oid = pg_attribute.atttypid
        AND pg_class.relname = $1
        AND pg_attribute.attname = $2
        `,
    [tableName, columnName]
  );
  if (result.length === 0) {
    return null;
  } else if (result.length > 1) {
    throw new Error(
      `Multiple pg_attribute results found for Table "${tableName}" Column "${columnName}"`
    );
  }
  return {
    tableOid: result[0].tbloid,
    colAttnum: result[0].attnum,
    typeName: result[0].typname
  };
}
async function dropTableConstraints(client) {
  const queryResult = await client.unsafe(
    `
        select
            pg_class.relname,
            pg_constraint.conname
        from
            pg_constraint,
            pg_class
        WHERE TRUE
        AND pg_constraint.conrelid = pg_class.oid
        AND pg_constraint.conrelid > 0
        AND pg_constraint.contype IN ('c', 'x');
        `
  );
  for (const row of queryResult) {
    const relname = row["relname"];
    const conname = row["conname"];
    await client.unsafe(
      `
            ALTER TABLE ${escapeIdentifier(relname)} DROP CONSTRAINT IF EXISTS ${escapeIdentifier(
        conname
      )} CASCADE
            `
    );
  }
}
async function dropTableIndexes(client) {
  const queryResult = await client.unsafe(
    `
        SELECT
            pg_class.relname AS indexname
        FROM
            pg_index,
            pg_class,
            pg_namespace
        WHERE
            pg_class.oid = pg_index.indexrelid
            AND pg_namespace.oid = pg_class.relnamespace
            AND pg_namespace.nspname = 'public'
            AND (
                indpred IS NOT NULL
                OR indexprs IS NOT NULL);
        `
  );
  for (const row of queryResult) {
    const indexname = row["indexname"];
    await client.unsafe(
      `
            DROP INDEX IF EXISTS ${escapeIdentifier(indexname)} CASCADE
            `
    );
  }
}
async function applyUniqueTableColumnTypes(client, uniqueTableColumnTypes) {
  await dropTableConstraints(client);
  await dropTableIndexes(client);
  for (const uniqueTableColumnType of uniqueTableColumnTypes) {
    const tableColumn = await queryTableColumn(
      client,
      uniqueTableColumnType.tableName,
      uniqueTableColumnType.columnName
    );
    if (tableColumn !== null) {
      const queryResult = await client.unsafe(
        `
                SELECT
                    pg_constraint.conname,
                    sc.relname,
                    sa.attname
                FROM
                    pg_constraint,
                    pg_class sc,
                    pg_attribute sa,
                    pg_class tc,
                    pg_attribute ta
                WHERE TRUE
                    AND sc.oid = pg_constraint.conrelid
                    AND tc.oid = pg_constraint.confrelid
                    AND sa.attrelid = sc.oid
                    AND ta.attrelid = tc.oid
                    AND sa.attnum = pg_constraint.conkey[1]
                    AND ta.attnum = pg_constraint.confkey[1]
                    AND pg_constraint.contype = 'f'
                    AND array_length(pg_constraint.conkey, 1) = 1
                    AND array_length(pg_constraint.confkey, 1) = 1
                    AND tc.relname = $1
                    AND ta.attname = $2
                `,
        [uniqueTableColumnType.tableName, uniqueTableColumnType.columnName]
      );
      for (const row of queryResult) {
        const conname = row["conname"];
        const relname = row["relname"];
        await client.unsafe(
          `
                    ALTER TABLE ${escapeIdentifier(relname)} DROP CONSTRAINT ${escapeIdentifier(
            conname
          )}
                    `
        );
      }
      const typeName = sqlUniqueTypeName(
        uniqueTableColumnType.tableName,
        uniqueTableColumnType.columnName
      );
      await client.unsafe(
        `
                CREATE TYPE ${escapeIdentifier(typeName)} AS RANGE (SUBTYPE = ${escapeIdentifier(
          tableColumn.typeName
        )})
                `
      );
      const colName = uniqueTableColumnType.columnName;
      const colHasDefault = await tableColHasDefault(
        client,
        uniqueTableColumnType.tableName,
        colName
      );
      await client.unsafe(
        `
                ALTER TABLE ${escapeIdentifier(uniqueTableColumnType.tableName)}
                    ALTER COLUMN ${escapeIdentifier(colName)} DROP DEFAULT,
                    ALTER COLUMN ${escapeIdentifier(colName)} SET DATA TYPE ${escapeIdentifier(
          typeName
        )} USING CASE WHEN ${escapeIdentifier(
          colName
        )} IS NULL THEN NULL ELSE ${escapeIdentifier(typeName)}(${escapeIdentifier(
          colName
        )}, ${escapeIdentifier(colName)}, '[]') END
                `
      );
      if (colHasDefault) {
        await client.unsafe(
          `
                    ALTER TABLE ${escapeIdentifier(uniqueTableColumnType.tableName)}
                        ALTER COLUMN ${escapeIdentifier(colName)} SET DEFAULT 'empty'
                    `
        );
      }
      for (const row of queryResult) {
        const relname = row["relname"];
        const attname = row["attname"];
        const refColHasDefault = await tableColHasDefault(client, relname, attname);
        await client.unsafe(
          `
                    ALTER TABLE ${escapeIdentifier(relname)}
                        ALTER COLUMN ${escapeIdentifier(attname)} DROP DEFAULT,
                        ALTER COLUMN ${escapeIdentifier(attname)} SET DATA TYPE ${escapeIdentifier(
            typeName
          )} USING CASE WHEN ${escapeIdentifier(
            attname
          )} IS NULL THEN NULL ELSE ${escapeIdentifier(typeName)}(${escapeIdentifier(
            attname
          )}, ${escapeIdentifier(attname)}, '[]') END
                    `
        );
        if (refColHasDefault) {
          await client.unsafe(
            `
                        ALTER TABLE ${escapeIdentifier(relname)}
                            ALTER COLUMN ${escapeIdentifier(attname)} SET DEFAULT 'empty'
                        `
          );
        }
      }
    }
  }
}
async function tableColHasDefault(client, tableName, colName) {
  const result = await client.unsafe(
    `
        select pg_attribute.atthasdef
        from
            pg_attribute,
            pg_class
        where
        pg_attribute.attrelid = pg_class.oid
        and pg_attribute.attnum >= 1
        and pg_class.relname = $1
        and pg_attribute.attname = $2
        `,
    [tableName, colName]
  );
  if (result.count === 0) {
    throw new Error(`No pg_attribute row found for "${tableName}"."${colName}"`);
  }
  if (result.count > 1) {
    throw new Error(`Multiple pg_attribute rows found for "${tableName}"."${colName}"`);
  }
  const atthasdef = result[0]["atthasdef"];
  return atthasdef;
}
async function modifySystemCatalogs(client) {
  const operatorOids = [
    2345,
    // date_lt_timestamp
    2346,
    // date_le_timestamp
    2347,
    // date_eq_timestamp
    2348,
    // date_ge_timestamp
    2349,
    // date_gt_timestamp
    2350,
    // date_ne_timestamp
    2358,
    // date_lt_timestamptz
    2359,
    // date_le_timestamptz
    2360,
    // date_eq_timestamptz
    2361,
    // date_ge_timestamptz
    2362,
    // date_gt_timestamptz
    2363,
    // date_ne_timestamptz
    2371,
    // timestamp_lt_date
    2372,
    // timestamp_le_date
    2373,
    // timestamp_eq_date
    2374,
    // timestamp_ge_date
    2375,
    // timestamp_gt_date
    2376,
    // timestamp_ne_date
    2384,
    // timestamptz_lt_date
    2385,
    // timestamptz_le_date
    2386,
    // timestamptz_eq_date
    2387,
    // timestamptz_ge_date
    2388,
    // timestamptz_gt_date
    2389,
    // timestamptz_ne_date
    2534,
    // timestamp_lt_timestamptz
    2535,
    // timestamp_le_timestamptz
    2536,
    // timestamp_eq_timestamptz
    2537,
    // timestamp_ge_timestamptz
    2538,
    // timestamp_gt_timestamptz
    2539,
    // timestamp_ne_timestamptz
    2540,
    // timestamptz_lt_timestamp
    2541,
    // timestamptz_le_timestamp
    2542,
    // timestamptz_eq_timestamp
    2543,
    // timestamptz_ge_timestamp
    2544,
    // timestamptz_gt_timestamp
    2545
    // timestamptz_ne_timestamp
  ];
  const explicitCasts = [
    [1114, 1082],
    // timestamp -> date
    [1114, 1083]
    // timestamp -> time
  ];
  const illegalCasts = [
    [1082, 1114],
    // date -> timestamp
    [1082, 1184],
    // date -> timestamptz
    [1114, 1184],
    // timestamp -> timestamptz
    [1184, 1082],
    // timestamptz -> date
    [1184, 1083],
    // timestamptz -> time
    [1184, 1114],
    // timestamptz -> timestamp
    [1184, 1266]
    // timestamptz -> timetz
  ];
  await client.unsafe(
    `
        delete from pg_operator
        where oid = any($1)
        `,
    [operatorOids]
  );
  await client.unsafe(
    `
        update pg_cast
        set castcontext = 'e'
        where (castsource, casttarget) in (select * from unnest($1::oid[], $2::oid[]));
        `,
    [explicitCasts.map((c) => c[0]), explicitCasts.map((c) => c[1])]
  );
  await client.unsafe(
    `
        delete from pg_cast
        where (castsource, casttarget) in (select * from unnest($1::oid[], $2::oid[]));
        `,
    [illegalCasts.map((c) => c[0]), illegalCasts.map((c) => c[1])]
  );
}

// eslint-local-rules/rules/sql-check.utils.ts
var DEFAULT_POSTGRES_VERSION = "10.10";
var QUERY_METHOD_NAMES = /* @__PURE__ */ new Set(["query", "queryOne", "queryOneOrNone"]);
var INSERT_METHOD_NAMES = /* @__PURE__ */ new Set(["insert", "insertMaybe"]);
var VALID_METHOD_NAMES = /* @__PURE__ */ new Set([...QUERY_METHOD_NAMES, ...INSERT_METHOD_NAMES]);
function initializeTE(params) {
  return (0, import_function2.pipe)(
    TE2.Do,
    TE2.chainFirstW(() => {
      console.log("init");
      return TE2.of(void 0);
    }),
    TE2.bindW(
      "options",
      () => initOptionsTE({
        projectDir: params.projectDir,
        configFile: "demo/mfsqlchecker.json",
        migrationsDir: "demo/migrations",
        postgresConnection: null
      })
    ),
    TE2.bindW("server", ({ options }) => initPgServerTE(options)),
    TE2.bindW("runner", ({ server, options }) => {
      return QueryRunner.ConnectTE({
        adminUrl: server.url,
        name: server.dbName,
        migrationsDir: options.migrationsDir
      });
    })
  );
}
function initOptionsTE(options) {
  return TE2.fromEither(initOptionsE(options));
}
function initOptionsE(options) {
  if (options.postgresConnection !== null && !isTestDatabaseCluster(options.postgresConnection.url)) {
    return E2.left(
      "Database Cluster url is not a local connection or is invalid:\n" + options.postgresConnection.url
    );
  }
  if (options.postgresConnection !== null && !isTestDatabaseCluster(options.postgresConnection.url)) {
    return E2.left(
      "Database Cluster url is not a local connection or is invalid:\n" + options.postgresConnection.url
    );
  }
  let migrationsDir = null;
  let postgresVersion = DEFAULT_POSTGRES_VERSION;
  if (options.configFile !== null) {
    const absoluteConfigFile = import_path.default.join(options.projectDir, options.configFile);
    const config2 = loadConfigFile(absoluteConfigFile);
    switch (config2.type) {
      case "Left": {
        const errors = [
          `Error Loading config file: ${absoluteConfigFile}`,
          ...config2.value.messages
        ];
        return E2.left(errors.join("\n"));
      }
      case "Right":
        if (config2.value.postgresVersion !== null) {
          postgresVersion = config2.value.postgresVersion;
        }
        if (config2.value.migrationsDir !== null) {
          if (import_path.default.isAbsolute(config2.value.migrationsDir)) {
            migrationsDir = config2.value.migrationsDir;
          } else {
            migrationsDir = import_path.default.join(
              import_path.default.dirname(options.configFile),
              config2.value.migrationsDir
            );
          }
        }
        break;
      default:
        return (0, import_assert_never6.default)(config2);
    }
  }
  if (options.migrationsDir !== null) {
    migrationsDir = options.migrationsDir;
  }
  if (migrationsDir === null) {
    return E2.left("migrations-dir is missing. Must be set in config file or command line");
  }
  return E2.right({
    ...options,
    migrationsDir,
    postgresVersion
  });
}
var startOrGetPgServer = (options) => {
  if (options.postgresConnection !== null) {
    return TE2.right({
      url: options.postgresConnection.url,
      dbName: options.postgresConnection.databaseName,
      pgServer: null
    });
  } else {
    return (0, import_function2.pipe)(
      TE2.tryCatch(() => PostgresServer.start(options.postgresVersion), E2.toError),
      TE2.map((pgServer) => ({
        url: pgServer.url,
        dbName: void 0,
        pgServer
      }))
    );
  }
};
function initPgServerTE(options) {
  return (0, import_function2.pipe)(
    startOrGetPgServer(options),
    TE2.chain((result) => {
      process.on("crash", () => result.pgServer?.close());
      process.on("SIGINT", () => result.pgServer?.close());
      return TE2.right(result);
    })
  );
}

// eslint-local-rules/rules/sql-check.worker.ts
var config = null;
console.log("a");
(0, import_synckit.runAsWorker)(async (params) => {
  console.log("runAsWorker");
  switch (params.action) {
    case "INITIALIZE":
      return runInitialize(params)();
    case "CHECK":
      return runCheck(params)();
    case "END":
      return runEnd(params)();
  }
});
function runInitialize(params) {
  console.log("runInitialize");
  return (0, import_function3.pipe)(
    initializeTE({ projectDir: params.projectDir }),
    TE3.map((result) => {
      config = result;
      return result;
    }),
    TE3.mapLeft((error) => ({ type: "INTERNAL_ERROR", error }))
  );
}
function runCheck(params) {
  if (config?.runner === void 0) {
    return TE3.left({ type: "INTERNAL_ERROR", error: new Error("runner is not initialized") });
  }
  const runner = config.runner;
  return (0, import_function3.pipe)(
    TE3.tryCatch(() => runner.runQuery({ query: params.query }), E3.toError),
    TE3.mapLeft((error) => ({ type: "RUNNER_ERROR", error }))
  );
}
function runEnd(params) {
  return (0, import_function3.pipe)(
    TE3.tryCatch(() => config?.server.pgServer?.close() ?? Promise.resolve(), E3.toError),
    TE3.mapLeft((error) => ({ type: "INTERNAL_ERROR", error }))
  );
}
var program = (0, import_function3.flow)((projectDir) => initializeTE({ projectDir }));
