import * as fs from "fs";
import { mkdtemp } from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as rimraf from "rimraf";

export async function createTempDir(APP_NAME: string): Promise<{
    directory: string;
    close: () => Promise<void>;
}> {
    await new Promise<void>((resolve, reject) => {
        fs.mkdir(path.join(os.tmpdir(), APP_NAME), (err) => {
            if (err !== null && err.code !== "EEXIST") {
                reject(err);
                return;
            }
            resolve();
        });
    });
    const directory = await mkdtemp(
        path.join(os.tmpdir(), APP_NAME) + path.sep + "tmp-"
    );

    return {
        directory,
        close: async () => {
            await rimrafIgnoreErrors(directory);
        }
    };
}

export function rimrafIgnoreErrors(filePath: string): Promise<void> {
    return new Promise<void>((resolve) => {
        rimraf(filePath, () => {
            resolve();
        });
    });
}

export async function withTempDir<T>(
    appName: string,
    action: (tmpDir: string) => Promise<T>
): Promise<T> {
    const tempDir = await createTempDir(appName);
    try {
        const result = await action(tempDir.directory);
        return result;
    } finally {
        await tempDir.close();
    }
}
