import * as childProcess from "child_process";
import * as envPaths from "env-paths";
import * as fs from "fs";
import * as path from "path";
import { ChildProcessPromise, spawn } from "promisify-child-process";
import * as readline from "readline";
import { BinaryDownloadArch, BinaryDownloadPlatform, getCurrentArchForDownload, getCurrentPlatformForDownload } from "./DownloadUtils/TargetPlatforms";
import { runBinariesJarFileProcess } from "./download_postgres";
import { createTempDir, withTempDir } from "./DownloadUtils/tempDir";

const APP_NAME = "launch-postgres";

const appEnvPaths = envPaths(APP_NAME);

interface PlatformArch {
    platform: BinaryDownloadPlatform;
    arch: BinaryDownloadArch;
}

function getCurrentPlatform() {
    return {
        platform: getCurrentPlatformForDownload(),
        arch: getCurrentArchForDownload()
    }
}

function postgresDirectory(platform: PlatformArch, postgresVersion: string): string {
    return path.join(appEnvPaths.cache, postgresVersion + "-" + platform.platform + "-" + platform.arch);
}

export function checkPostgresInstalled(platform: PlatformArch, postgresVersion: string): Promise<boolean> {
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

export async function getPostgresBinaryPath(platform: PlatformArch, postgresVersion: string, binaryName: string): Promise<string> {
    const isInstalled = await checkPostgresInstalled(platform, postgresVersion);
    if (!isInstalled) {
        await runBinariesJarFileProcess(APP_NAME, platform.platform, platform.arch, postgresVersion, postgresDirectory(platform, postgresVersion));
    }

    const ext = platform.platform === "windows" ? ".exe" : "";

    return path.join(postgresDirectory(platform, postgresVersion), "bin", binaryName + ext);
}

// See: <https://en.wikipedia.org/wiki/Ephemeral_port>
const MIN_PORT = 49152;
const MAX_PORT = 65534;

export function randomPort(): number {
    return MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT));
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

type PromiseType<T> = T extends Promise<infer U> ? U : never;

type TempDir = PromiseType<ReturnType<typeof createTempDir>>;

export class PostgresServer {
    static async start(postgresVersion: string): Promise<PostgresServer> {
        const platform = getCurrentPlatform();

        const initDb = await getPostgresBinaryPath(platform, postgresVersion, "initdb");
        const postgres = await getPostgresBinaryPath(platform, postgresVersion, "postgres");

        const tempDir = await createTempDir(APP_NAME);
        try {
            await withTempDir(APP_NAME, async (pwTmpDir) => {
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
                    throw new Error(`initdb failed, error running command "${initDb}": ${(err as any).message}`);
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

    const pgServer = await PostgresServer.start("15.4.0");
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
