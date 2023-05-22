import chalk from "chalk";

const isDebug = process.env.DEBUG_SQL_CHECKER === "true";

const now = () => new Date().toISOString();

export const customLog = {
    success: (...args: any[]) => {
        if (isDebug) {
            console.log(chalk.grey(`[${now()}]`), chalk.green(`sql-checker`), ...args);
        }
    },
    info: (...args: any[]) => {
        if (isDebug) {
            console.log(chalk.grey(`[${now()}]`), chalk.blue(`sql-checker`), ...args);
        }
    },
    error: (...args: any[]) => {
        if (isDebug) {
            console.log(chalk.grey(`[${now()}]`), chalk.red(`sql-checker`), ...args);
        }
    }
}
