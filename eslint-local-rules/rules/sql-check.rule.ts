import { TSESTree } from "@typescript-eslint/typescript-estree";
import { TSESLint } from "@typescript-eslint/utils";
import { createRule } from "../utils";
import * as E from "fp-ts/Either";
import * as TE from "fp-ts/TaskEither";
import { pipe } from "fp-ts/function";
import { initialize, Options } from "../../mfsqlchecker/main_utils";
import { DbConnector } from "../../mfsqlchecker/DbConnector";
import { SqlCheckerEngine } from "../../mfsqlchecker/sqlchecker_engine";

const messages = {
    missing: "Missing: {{value}}",
    invalid: "Invalid: {{value}}"
};

const pendingTasks: Promise<unknown>[] = [];

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
        return {
            CallExpression: (node) => pendingTasks.push(checkCallExpression({ node, context })),
            "Program:exit": () => Promise.all(pendingTasks)
        };
    }
});

type RuleMessage = keyof typeof messages;
type RuleOptions = never[];
type RuleContext = TSESLint.RuleContext<RuleMessage, RuleOptions>;

const queryMethodNames = new Set(["query", "queryOne", "queryOneOrNone"]);
const insertMethodNames = new Set(["insert", "insertMaybe"]);
const validMethodNames = new Set([...queryMethodNames, ...insertMethodNames]);

let settingsCache: {
    options: Options;
    dbConnector: DbConnector;
} | null = null;

async function checkCallExpression(params: {
    node: TSESTree.CallExpression;
    context: RuleContext;
}) {
    const { node, context } = params;
    const callExpressionValidityE = getCallExpressionValidity(node);

    if (E.isLeft(callExpressionValidityE) || context.parserServices === undefined) {
        return;
    }

    const { callee, property } = callExpressionValidityE.right;

    const tsProgram = context.parserServices.program;
    const checker = tsProgram.getTypeChecker();
    const fileName = context.getFilename();

    const program = pipe(
        TE.Do,
        TE.bindW("settings", () => (settingsCache !== null ? TE.of(settingsCache) : initialize)),
        TE.bindW("engine", ({ settings }) => {
            return TE.of(new SqlCheckerEngine(settings.options.configFile, settings.dbConnector));
        }),
        TE.match((err) => {
            context.report({
                node: callee,
                messageId: "invalid",
                data: err.toString()
            })
        }, ())
    );

    const sourceCode = context.getSourceCode();
    const asText = sourceCode.getText(node);

    if (isFirst) {
        const result = await initialize();

        if (E.isLeft(result)) {
            console.error(result.left);
            process.exit(1);
        }
        isFirst = false;
        console.log("start");
    }

    console.log("x");
}

function getCallExpressionValidity(node: TSESTree.CallExpression) {
    if (node.callee.type !== "MemberExpression") {
        return E.left("CALLEE_NOT_MEMBER_EXPRESSION");
    }

    if (node.callee.property.type !== "Identifier") {
        return E.left("CALLEE_PROPERTY_NOT_IDENTIFIER");
    }

    if (!validMethodNames.has(node.callee.property.name)) {
        return E.left("CALLEE_PROPERTY_NOT_VALID");
    }

    return E.right({
        callee: node.callee,
        property: node.callee.property
    });
}

const initDbConnectorTE = pipe(
    initialize,
    TE.map((r) => r.dbConnector)
);
