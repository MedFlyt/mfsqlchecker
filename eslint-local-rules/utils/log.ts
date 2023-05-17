import chalk from "chalk";

const now = () => new Date().toISOString();

export const customLog = {
    success: (...args: any[]) => {
        console.log(chalk.grey(`[${now()}]`), chalk.green(`sql-checker`), ...args);
    },
    info: (...args: any[]) => {
        console.log(chalk.grey(`[${now()}]`), chalk.blue(`sql-checker`), ...args);
    },
    error: (...args: any[]) => {
        console.log(chalk.grey(`[${now()}]`), chalk.red(`sql-checker`), ...args);
    }
}
