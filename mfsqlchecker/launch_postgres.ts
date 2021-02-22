import * as AdmZip from "adm-zip";
import { assertNever } from "assert-never";
import * as childProcess from "child_process";
import * as envPaths from "env-paths";
import * as fs from "fs";
import * as makeDir from "make-dir";
import * as os from "os";
import * as path from "path";
import { ChildProcessPromise, spawn } from "promisify-child-process";
import * as readline from "readline";
import * as request from "request";
import * as rimraf from "rimraf";
import * as tar from "tar";

const APP_NAME = "launch-postgres";

const appEnvPaths = envPaths(APP_NAME);

export type Platform
    = "linux_x86-32"
    | "linux_x86-64"
    | "mac_os_x"
    | "win_x86-32"
    | "win_x86-64";

export function getCurrentPlatform(): Platform {
    switch (process.platform) {
        case "darwin":
            return "mac_os_x";
        case "linux":
            const output = childProcess.execSync("getconf LONG_BIT", { encoding: "utf8" });
            return output === "64\n"
                ? "linux_x86-64"
                : "linux_x86-32";
        case "cygwin":
        case "win32":
            let useEnv = false;
            try {
                useEnv = !!((<any>(process.env.SYSTEMROOT) && <any>fs.statSync(<any>process.env.SYSTEMROOT)));
            } catch (err) { /* Ignore */ }

            const sysRoot = useEnv ? process.env.SYSTEMROOT : "C:\\Windows";

            // If %SystemRoot%\SysNative exists, we are in a WOW64 FS Redirected application.
            let isWOW64 = false;
            try {
                isWOW64 = !!<any>(fs.statSync(path.join(<any>sysRoot, "sysnative")));
            } catch (err) { /* Ignore */ }

            return isWOW64
                ? "win_x86-64"
                : "win_x86-32";
        default:
            throw new Error(`Unsupported platform: ${process.platform}`);
    }
}

export type PostgresVersion
    = "9.4.24"
    | "9.5.19"
    | "9.6.15"
    | "10.10"
    | "11.5";

function postgresDownloadUrl(platform: Platform, postgresVersion: PostgresVersion): string | null {
    switch (postgresVersion) {
        case "9.4.24":
            switch (platform) {
                case "linux_x86-32": return "http://get.enterprisedb.com/postgresql/postgresql-9.4.24-1-linux-binaries.tar.gz";
                case "linux_x86-64": return "http://get.enterprisedb.com/postgresql/postgresql-9.4.24-1-linux-x64-binaries.tar.gz";
                case "win_x86-32": return "http://get.enterprisedb.com/postgresql/postgresql-9.4.24-1-windows-binaries.zip";
                case "win_x86-64": return "http://get.enterprisedb.com/postgresql/postgresql-9.4.24-1-windows-x64-binaries.zip";
                case "mac_os_x": return "http://get.enterprisedb.com/postgresql/postgresql-9.4.24-1-osx-binaries.zip";
                default: return assertNever(platform);
            }
        case "9.5.19":
            switch (platform) {
                case "linux_x86-32": return null;
                case "linux_x86-64": return null;
                case "win_x86-32": return "http://get.enterprisedb.com/postgresql/postgresql-9.5.19-1-windows-binaries.zip";
                case "win_x86-64": return "http://get.enterprisedb.com/postgresql/postgresql-9.5.19-1-windows-x64-binaries.zip";
                case "mac_os_x": return "http://get.enterprisedb.com/postgresql/postgresql-9.5.19-1-osx-binaries.zip";
                default: return assertNever(platform);
            }
        case "9.6.15":
            switch (platform) {
                case "linux_x86-32": return "http://get.enterprisedb.com/postgresql/postgresql-9.6.15-1-linux-binaries.tar.gz";
                case "linux_x86-64": return "http://get.enterprisedb.com/postgresql/postgresql-9.6.15-1-linux-x64-binaries.tar.gz";
                case "win_x86-32": return "http://get.enterprisedb.com/postgresql/postgresql-9.6.15-1-windows-binaries.zip";
                case "win_x86-64": return "http://get.enterprisedb.com/postgresql/postgresql-9.6.15-1-windows-x64-binaries.zip";
                case "mac_os_x": return "http://get.enterprisedb.com/postgresql/postgresql-9.6.15-1-osx-binaries.zip";
                default: return assertNever(platform);
            }
        case "10.10":
            switch (platform) {
                case "linux_x86-32": return "https://get.enterprisedb.com/postgresql/postgresql-10.10-1-linux-binaries.tar.gz";
                case "linux_x86-64": return "https://get.enterprisedb.com/postgresql/postgresql-10.10-1-linux-x64-binaries.tar.gz";
                case "win_x86-32": return "https://get.enterprisedb.com/postgresql/postgresql-10.10-1-windows-binaries.zip";
                case "win_x86-64": return "https://get.enterprisedb.com/postgresql/postgresql-10.10-1-windows-x64-binaries.zip";
                case "mac_os_x": return "https://get.enterprisedb.com/postgresql/postgresql-10.10-1-osx-binaries.zip";
                default: return assertNever(platform);
            }
        case "11.5":
            switch (platform) {
                case "linux_x86-32": return null;
                case "linux_x86-64": return null;
                case "win_x86-32": return null;
                case "win_x86-64": return "https://get.enterprisedb.com/postgresql/postgresql-11.5-1-windows-x64-binaries.zip";
                case "mac_os_x": return "https://get.enterprisedb.com/postgresql/postgresql-11.5-1-osx-binaries.zip";
                default: return assertNever(platform);
            }
        default:
            return assertNever(postgresVersion);
    }
}

function postgresDirectory(platform: Platform, postgresVersion: PostgresVersion): string {
    return path.join(appEnvPaths.cache, postgresVersion + "-" + platform);
}

export function checkPostgresInstalled(platform: Platform, postgresVersion: PostgresVersion): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        fs.stat(postgresDirectory(platform, postgresVersion), (err, stats) => {
            if (<any>err) {
                resolve(false);
                return;
            }
            resolve(stats.isDirectory());
        });
    });
}

function downloadFile(url: string, filePath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const stream = request(url).pipe(fs.createWriteStream(filePath));
        stream.on("finish", () => {
            resolve();
        });
        stream.on("error", err => {
            reject(err);
        });
    });
}

async function downloadFileWithRetry(url: string, filePath: string): Promise<void> {
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
            await delay(10000);
        }
    }
}

function delay(millis: number): Promise<void> {
    return new Promise<void>((resolve, _reject) => {
        setTimeout(resolve, millis);
    });
}

async function mkdtemp(prefix: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        fs.mkdtemp(prefix, (err, folder) => {
            if (<any>err) {
                reject(err);
                return;
            }
            resolve(folder);
        });
    });
}

async function rimrafIgnoreErrors(filePath: string): Promise<void> {
    return new Promise<void>((resolve) => {
        rimraf(filePath, () => {
            resolve();
        });
    });
}

class TempDir {
    static async create(): Promise<TempDir> {
        await new Promise<void>((resolve, reject) => {
            fs.mkdir(path.join(os.tmpdir(), APP_NAME), err => {
                if (<any>err && err !== null && err.code !== "EEXIST") {
                    reject(err);
                    return;
                }
                resolve();
            });
        });
        const directory = await mkdtemp(path.join(os.tmpdir(), APP_NAME) + path.sep + "tmp-");
        return new TempDir(directory);
    }

    async close(): Promise<void> {
        // Ignore any errors since there is nothing we can do about them
        await rimrafIgnoreErrors(this.directory);
    }

    readonly directory: string;

    private constructor(directory: string) {
        this.directory = directory;
    }
}

async function withTempDir<T>(action: (tmpDir: string) => Promise<T>): Promise<T> {
    const tempDir = await TempDir.create();
    try {
        const result = await action(tempDir.directory);
        return result;
    } finally {
        await tempDir.close();
    }
}

export async function downloadPostgres(platform: Platform, postgresVersion: PostgresVersion, targetDir: string): Promise<void> {
    const url = postgresDownloadUrl(platform, postgresVersion);

    if (url === null) {
        throw new Error(`Binary Download of PostgreSQL version ${postgresVersion} not available for ${platform}`);
    }

    console.log("Downloading", url);

    await makeDir(path.dirname(targetDir));

    const extractDir = await mkdtemp(targetDir + "-tmp-");

    await withTempDir(async tmpDir => {
        const file = path.join(tmpDir, "tmp.tar.gz");
        await downloadFileWithRetry(url, file);

        await makeDir(extractDir);

        console.log("extracting to", extractDir);

        if (url.endsWith(".zip")) {
            await new Promise<void>((resolve, reject) => {
                const zip = new AdmZip(file);
                zip.extractAllToAsync(extractDir, true, (err) => {
                    if (<any>err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            });
        } else {
            await tar.x({
                file: file,
                C: extractDir
            });
        }

        try {
            await new Promise<void>((resolve, reject) => {
                fs.rename(extractDir, targetDir, (err) => {
                    if (<any>err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            });
        } catch (err) {
            if (err.code === "ENOTEMPTY") {
                // The target directory already exists. We can ignore, because
                // it means that some concurrent process was racing us to
                // install it and finished before us
                console.log(`Target directory already exists (created by a concurrent process)`);

                // Cleanup after ourselves:
                await rimrafIgnoreErrors(extractDir);
            } else {
                throw err;
            }
        }
    });

    console.log(`PostgreSQL ${postgresVersion} ready`);
}

export async function getPostgresBinaryPath(platform: Platform, postgresVersion: PostgresVersion, binaryName: string): Promise<string> {
    const isInstalled = await checkPostgresInstalled(platform, postgresVersion);
    if (!isInstalled) {
        await downloadPostgres(platform, postgresVersion, postgresDirectory(platform, postgresVersion));
    }

    const ext = platform === "win_x86-32" || platform === "win_x86-64" ? ".exe" : "";

    return path.join(postgresDirectory(platform, postgresVersion), "pgsql", "bin", binaryName + ext);
}

const MIN_PORT = 49152;
const MAX_PORT = 65534;

function randomPort(): number {
    return MIN_PORT + Math.floor(Math.random() * MAX_PORT - MIN_PORT);
}

/**
 * @returns null if the port is not available
 */
function tryLaunchPostgres(postgres: string, dataDir: string, port: number): Promise<childProcess.ChildProcess | null> {
    return new Promise<childProcess.ChildProcess | null>((resolve, reject) => {
        const postgresChild = childProcess.spawn(postgres, ["-F", "-D", dataDir, "-p", `${port}`], { detached: true, env: {} });

        process.on("exit", () => { postgresChild.kill(); });

        let handled = false;

        readline.createInterface({
            input: postgresChild.stderr
        }).on("line", line => {
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

const USERNAME = "test";
const PASSWORD = "test";

export class PostgresServer {
    static async start(postgresVersion: PostgresVersion): Promise<PostgresServer> {
        const platform: Platform = getCurrentPlatform();

        const initDb = await getPostgresBinaryPath(platform, postgresVersion, "initdb");
        const postgres = await getPostgresBinaryPath(platform, postgresVersion, "postgres");

        const tempDir = await TempDir.create();
        try {
            await withTempDir(async (pwTmpDir) => {
                const pwFile = path.join(pwTmpDir, "password.txt");
                await new Promise<void>((resolve, reject) => {
                    fs.writeFile(pwFile, PASSWORD, { encoding: "utf8" }, (err) => {
                        if (<any>err) {
                            reject(err);
                            return;
                        }
                        resolve();
                    });
                });

                let initDbChild: ChildProcessPromise;
                try {
                    initDbChild = spawn(initDb, ["-D", tempDir.directory, "-N", "-U", USERNAME, "--pwfile", pwFile], { encoding: "utf8", env: {} });
                } catch (err) {
                    throw new Error(`initdb failed, error running command "${initDb}": ${err.message}`);
                }

                if (initDbChild.stdout === null) {
                    throw new Error("initdb stdout is null");
                }
                if (initDbChild.stderr === null) {
                    throw new Error("initdb stdout is null");
                }

                let output: string = "";
                initDbChild.stdout.on("data", (msg) => { output += msg.toString(); });
                initDbChild.stderr.on("data", (msg) => { output += msg.toString(); });
                try {
                    await initDbChild;
                } catch (err) {
                    throw new Error(`initdb failed:\n${output}`);
                }
            });

            let postgresProc: childProcess.ChildProcess | null = null;
            let port: number = 0;
            while (postgresProc === null) {
                port = randomPort();
                postgresProc = await tryLaunchPostgres(postgres, tempDir.directory, port);
            }

            return new PostgresServer(tempDir, postgresProc, port);
        } catch (err) {
            await tempDir.close();
            throw err;
        }
    }

    async close(): Promise<void> {
        // <https://www.postgresql.org/docs/current/server-shutdown.html>
        const SIGQUIT = 3;
        this.postgresProc.kill(<any>SIGQUIT);

        await new Promise<void>((resolve) => {
            this.postgresProc.on("close", resolve);
        });

        await this.tempDir.close();
    }

    readonly port: number;
    readonly url: string;

    private tempDir: TempDir;
    private postgresProc: childProcess.ChildProcess;

    private constructor(tempDir: TempDir, postgresProc: childProcess.ChildProcess, port: number) {
        this.tempDir = tempDir;
        this.postgresProc = postgresProc;
        this.port = port;
        this.url = `postgres://${USERNAME}:${PASSWORD}@127.0.0.1:${this.port}/postgres`;
    }
}

export async function test() {
    process.on("SIGINT", () => process.exit());

    const pgServer = await PostgresServer.start("10.10");
    try {
        console.log("Running", pgServer.port, pgServer.url);

        await new Promise<void>((resolve) => {
            setTimeout(resolve, 10000);
        });
    } finally {
        await pgServer.close();
    }
}
// test();
