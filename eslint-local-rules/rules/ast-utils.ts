import { TSESTree } from "@typescript-eslint/utils";

export const CustomASTUtils = {
    isOneOf<T extends TSESTree.AST_NODE_TYPES>(
        node: TSESTree.Node,
        types: readonly T[]
    ): node is TSESTree.Node & { type: T } {
        return types.includes(node.type as T);
    }
};
