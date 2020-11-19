// @ts-check

const childProcess = require("child_process");
const glob = require("glob");

// Make sure to run `npm run build` before running these tests

function main() {
    const dirs = process.argv.slice(2);

    glob("tests/test_*/", (err, files) => {
        if (err) {
            console.error(err);
            return;
        }

        // TODO Better filtering of "dirs"
        const filteredFiles = dirs.length === 0
            ? files
            : files.filter(file => {
                for (const dir of dirs) {
                    if (file.indexOf(dir) >= 0) {
                        return true;
                    }
                }
                return false;
            });

        const passed = runTests(filteredFiles);
        if (!passed) {
            process.exit(1);
        }
    });
}

/**
 * @param {string[]} dirs
 * @returns {boolean}
 */
function runTests(dirs) {
    /**
     * @type {string[]}
     */
    const errors = [];

    for (const dir of dirs) {
        console.log(`Running ${dir}`);

        const typechecked = runTypeCheck(dir);
        if (!typechecked) {
            errors.push(dir);
            continue;
        }

        const mfsqlcheckerPassed = runMfsqlchecker(dir);
        if (!mfsqlcheckerPassed) {
            errors.push(dir);
            continue;
        }
    }

    console.log(`(${dirs.length - errors.length}/${dirs.length}) Passed`);

    if (errors.length > 0) {
        return false;
    } else {
        return true;
    }
}

/**
 * @param {string} proj
 * @returns {boolean}
 */
function runTypeCheck(proj) {
    try {
        // $ ./node_modules/.bin/tsc --noEmit --project tests/test_simple/
        childProcess.execFileSync("node", ["./node_modules/.bin/tsc", "--noEmit", "--project", proj], { encoding: "utf8" });
    } catch (err) {
        if (typeof err.status !== "number") {
            throw err;
        }
        console.error(`Status: ${err.status}`);
        console.error(err.stdout);
        console.error(`${proj} TypeCheck failed!`)
        return false;
    }

    return true;
}

/**
 * @param {string} proj
 * @returns {boolean}
 */
function runMfsqlchecker(proj) {
    // TODO Compare stdout with "expected_out.txt" file

    try {
        // $ node mfsqlchecker.js --project tests/test_simple/ --migrations tests/migrations/ --format vscode
        childProcess.execFileSync("node", ["mfsqlchecker.js", "--project", proj, "--migrations", "tests/migrations", "--format", "vscode"], { encoding: "utf8" });
    } catch (err) {
        if (typeof err.status !== "number") {
            throw err;
        }
        console.error(`Status: ${err.status}`);
        console.error(err.stdout);
        console.error(`${proj} mfsqlchecker failed!`)
        return false;
    }

    return true;
}

if (require.main === module) {
    main();
}

// TODO:
// For each directory "tests_*":
//     Check that ts code typechecks:
//     ./node_modules/.bin/tsc --noEmit --project tests/test_simple/
//
//     Run mfsqlchecker:
//     node mfsqlchecker.js -p tests/test_simple/ -m tests/migrations/ --format vscode
//     Compare stdout with "expected_out.txt" file


// Bonus points: Use a single launch_postgres invocation here in the test runner
// so it can be re-used (with mfsqlchecker --postgres-url option)
