import { SrcSpan, toSrcSpan } from "./ErrorDiagnostic";

/**
 * @param sourceMap First element of tuple is character position inside
 * `fileContents`. Second element of tuple is is start character position of
 * mapped string. Third element of tuple is end character position of mapped
 * string.
 *
 * @param position first character starts at 0
 */
export function resolveFromSourceMap(fileContents: string, position: number, sourceMap: [number, number, number][]): SrcSpan {
    if (sourceMap.length === 0) {
        throw new Error("Empty sourceMap");
    }

    let i = 0;
    while (true) {
        if (position >= sourceMap[i][1] && position < sourceMap[i][2]) {
            return toSrcSpan(fileContents,  sourceMap[i][0] + (position - sourceMap[i][1]));
        }

        if (position < sourceMap[i][1]) {
            if (i > 0) {
                const start = toSrcSpan(fileContents, sourceMap[i - 1][0] + sourceMap[i - 1][2] - sourceMap[i - 1][1]);
                const end = toSrcSpan(fileContents, sourceMap[i][0]);
                return {
                    type: "LineAndColRange",
                    startLine: start.line,
                    startCol: start.col,
                    endLine: end.line,
                    endCol: end.col
                };
            } else {
                return toSrcSpan(fileContents, sourceMap[0][0]);
            }
        }

        if (i === sourceMap.length - 1) {
            return toSrcSpan(fileContents, sourceMap[i][0] + sourceMap[i][2] - sourceMap[i][1] - 1);
        }
        i++;
    }
}
