import chalk from "chalk";
import readline from "readline";

const isVerbose = () => process.env.DEBUG_SQL_CHECKER === "true";

const now = () => new Date().toISOString();

export const customLog = {
    success: (...args: any[]) => {
        if (isVerbose()) {
            console.log(chalk.grey(`[${now()}]`), chalk.green(`sql-checker`), ...args);
        }
    },
    stream: (...args: any[]) => {
        if (isVerbose()) {
            readline.clearLine(process.stdout, 0)
            readline.cursorTo(process.stdout, 0)
            process.stdout.write(
                `${chalk.grey(`[${now()}]`)} ${chalk.green(`sql-checker`)} ${args.join(" ")}`
            );
        }
    },
    info: (...args: any[]) => {
        if (isVerbose()) {
            console.log(chalk.grey(`[${now()}]`), chalk.blue(`sql-checker`), ...args);
        }
    },
    error: (...args: any[]) => {
        if (isVerbose()) {
            console.log(chalk.grey(`[${now()}]`), chalk.red(`sql-checker`), ...args);
        }
    }
};
