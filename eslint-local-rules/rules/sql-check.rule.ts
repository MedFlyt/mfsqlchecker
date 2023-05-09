import { TSESTree } from "@typescript-eslint/typescript-estree";
import { TSESLint } from "@typescript-eslint/utils";
import * as E from "fp-ts/Either";
import { createSyncFn } from "synckit";
import { createRule } from "../utils";
import { memoize } from "../utils/memoize";
import { locateNearestPackageJsonDir, VALID_METHOD_NAMES } from "./sql-check.utils";
import { WorkerParams } from "./sql-check.worker";

export type RuleMessage = keyof typeof messages;
export type RuleOptions = never[];
export type RuleContext = TSESLint.RuleContext<RuleMessage, RuleOptions>;

const messages = {
    missing: "Missing: {{value}}",
    invalid: "Invalid: {{value}}"
};

export const sqlCheck = createRule({
    name: "sql-check",
    meta: {
        docs: {
            description:
                "Statically validate correctness of all your SQL queries. TypeScript, PostgreSQL",
            recommended: "error"
        },
        messages: {
            missing: "Missing: {{value}}",
            invalid: "Invalid: {{value}}"
        },
        type: "suggestion",
        schema: []
    },
    defaultOptions: [],
    create(context) {
        const projectDir = memoize({
            key: context.getFilename(),
            value: () => locateNearestPackageJsonDir(context.getFilename())
        });

        return {
            CallExpression: (node) => checkCallExpression({ node, context, projectDir })
        };
    }
});

const workerPath = require.resolve("./sql-check.worker");
console.log(workerPath);
const runWorker = createSyncFn<(params: WorkerParams) => Promise<E.Either<unknown, string>>>(
    workerPath,
    {
        tsRunner: "tsx",
        timeout: 3000,
        // timeout: 1000 * 60 * 5
    }
);

let isInitial = true;

function checkCallExpression(params: {
    node: TSESTree.CallExpression;
    context: RuleContext;
    projectDir: string;
}) {
    const { node, context } = params;
    const callExpressionValidityE = getCallExpressionValidity(node);

    if (E.isLeft(callExpressionValidityE) || context.parserServices === undefined) {
        return;
    }

    if (isInitial) {
        console.log("xxx");
        runWorker({ action: "INITIALIZE", projectDir: params.projectDir });
        isInitial = false;
    }

    // const r = initOptions({
    //     projectDir: projectDir,
    //     configFile: "demo/mfsqlchecker.json",
    //     migrationsDir: "demo/migrations",
    //     postgresConnection: null
    // });

    // if (E.isLeft(r)) {
    //     return context.report({
    //         node: node.callee,
    //         messageId: "invalid",
    //         data: { value: r.left }
    //     });
    // }

    // const options = r.right;

    // const r2 = await initPgServerTE(options)();

    // console.log(r2);

    // const callExpressionValidityE = getCallExpressionValidity(node);

    // if (E.isLeft(callExpressionValidityE) || context.parserServices === undefined) {
    //     return;
    // }

    // const { callee, property, argument } = callExpressionValidityE.right;
    // const sourceCode = context.getSourceCode();

    // return context.report({
    //     node: callee,
    //     messageId: "invalid",
    //     data: { value: sourceCode.getText(argument.quasi) }
    // });

    // const program = pipe(
    //     TE.Do,
    //     TE.bindW("settings", () => (settingsCache !== null ? TE.of(settingsCache) : initializeTE)),
    //     // TE.bindW("runner", ({ settings }) => {
    //     //     return TE.of(new SqlCheckerEngine(settings.options.configFile, settings.queryRunner));
    //     // }),
    //     TE.match(
    //         (err) => {
    //             context.report({
    //                 node: callee,
    //                 messageId: "invalid",
    //                 data: { value: sourceCode.getText(argument) }
    //             });
    //         },
    //         () => {
    //             context.report({
    //                 node: callee,
    //                 messageId: "invalid",
    //                 data: { value: sourceCode.getText(argument) }
    //             });
    //         }
    //     )
    // );

    // return program();
}

function getCallExpressionValidity(node: TSESTree.CallExpression) {
    if (node.callee.type !== "MemberExpression") {
        return E.left("CALLEE_NOT_MEMBER_EXPRESSION");
    }

    if (node.callee.property.type !== "Identifier") {
        return E.left("CALLEE_PROPERTY_NOT_IDENTIFIER");
    }

    if (!VALID_METHOD_NAMES.has(node.callee.property.name)) {
        return E.left("CALLEE_PROPERTY_NOT_VALID");
    }

    const argument = node.arguments[0];

    if (argument === undefined) {
        return E.left("NO_ARGUMENT");
    }

    if (argument.type !== TSESTree.AST_NODE_TYPES.TaggedTemplateExpression) {
        return E.left("ARGUMENT_NOT_TAGGED_TEMPLATE_EXPRESSION");
    }

    return E.right({
        callee: node.callee,
        property: node.callee.property,
        argument: argument
    });
}
