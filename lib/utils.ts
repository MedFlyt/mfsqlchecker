import * as fs from "fs";

export function readdirAsync(dir: string): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
        fs.readdir(dir, (err, files) => {
            if (<any>err) {
                reject(err);
                return;
            }

            resolve(files);
        });
    });
}

export function readFileAsync(fileName: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        fs.readFile(fileName, { encoding: "utf8" }, (err, data) => {
            if (<boolean><any>err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

const migrationsRegex = /^V\d+__.*\.sql$/;

export function isMigrationFile(fileName: string): boolean {
    return migrationsRegex.test(fileName);
}
