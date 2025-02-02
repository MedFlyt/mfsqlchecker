import * as AdmZip from "adm-zip";
import * as fs from "fs";
import { mkdtemp } from "fs/promises";
import * as makeDir from "make-dir";
import * as path from "path";
import { spawn } from "promisify-child-process";
import * as request from "request";

import {
    BinaryDownloadArch,
    BinaryDownloadPlatform
} from "./DownloadUtils/TargetPlatforms";
import { rimrafIgnoreErrors, withTempDir } from "./DownloadUtils/tempDir";

function getBinariesDownloadJarUrl(
    platform: BinaryDownloadPlatform,
    cpuArch: BinaryDownloadArch,
    postgresVersion: string
): string {
    return `https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-${platform}-${cpuArch}/${postgresVersion}/embedded-postgres-binaries-${platform}-${cpuArch}-${postgresVersion}.jar`;
}

export async function runBinariesJarFileProcess(
    appName: string,
    platform: BinaryDownloadPlatform,
    cpuArch: BinaryDownloadArch,
    postgresVersion: string,
    targetDir: string
): Promise<void> {
    const url = getBinariesDownloadJarUrl(platform, cpuArch, postgresVersion);

    const exists = await checkIfLinkExists(url);

    if (!exists) {
        throw new Error(
            `Binary Download of PostgreSQL version ${postgresVersion} not available for ${platform}`
        );
    }

    await makeDir(path.dirname(targetDir));

    const extractDir = await mkdtemp(targetDir + "-tmp-");

    await withTempExtractPostgresTo(appName, url, targetDir, extractDir);
}

async function withTempExtractPostgresTo(
    appName: string,
    url: string,
    targetDir: string,
    extractDir: string
): Promise<void> {
    await withTempDir(appName, async (tmpDir) => {
        const jarFilePath = path.join(tmpDir, "tmp.jar");
        await downloadFileWithRetry(url, jarFilePath);

        await makeDir(extractDir);

        const jarFile = new AdmZip(jarFilePath);
        const txzFile = jarFile
            .getEntries()
            .find((f) => f.entryName.endsWith(".txz"));

        if (txzFile === undefined) {
            throw new Error("No txz file found in jar");
        }

        jarFile.extractEntryTo(txzFile, tmpDir, false, true);
        const txzFilePath = path.join(tmpDir, txzFile.name);

        if (url.endsWith(".zip")) {
            await new Promise<void>((resolve, reject) => {
                const zip = new AdmZip(txzFilePath);
                zip.extractAllToAsync(extractDir, true, (err) => {
                    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions, @typescript-eslint/consistent-type-assertions
                    if (<any>err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            });
        } else {
            // Not clear on why this doesn't work.
            // await tar.x({
            //     f: txzFilePath,
            //     C: extractDir
            // });

            const result = await spawn(
                "tar",
                ["xf", txzFilePath, "-C", extractDir],
                { stdio: "inherit", encoding: "utf-8" }
            );

            if (result.code !== 0) {
                throw new Error(`Failed to extract txz file: ${result.stderr}`);
            }
        }

        try {
            await new Promise<void>((resolve, reject) => {
                fs.rename(extractDir, targetDir, (err) => {
                    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions, @typescript-eslint/consistent-type-assertions
                    if (err !== null) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            });
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOTEMPTY") {
                // The target directory already exists. We can ignore, because
                // it means that some concurrent process was racing us to
                // install it and finished before us
                console.log(
                    `Target directory already exists (created by a concurrent process)`
                );

                // Cleanup after ourselves:
                await rimrafIgnoreErrors(extractDir);
            } else {
                throw err;
            }
        }
    });
}

async function checkIfLinkExists(url: string): Promise<boolean> {
    try {
        await request(url, { method: "HEAD" });
        return true;
    } catch (err) {
        return false;
    }
}

function downloadFile(url: string, filePath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const stream = request(url).pipe(fs.createWriteStream(filePath));
        stream.on("finish", () => {
            resolve();
        });
        stream.on("error", (err) => {
            reject(err);
        });
    });
}

async function downloadFileWithRetry(
    url: string,
    filePath: string
): Promise<void> {
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
