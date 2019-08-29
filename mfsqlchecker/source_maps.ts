export function resolveFromSourceMap(position: number, sourceMap: [number, number][]): number {
    if (sourceMap.length === 0) {
        throw new Error("Empty sourceMap");
    }

    let i = 0;
    while (true) {
        if (i === sourceMap.length - 1) {
            break;
        }
        if (position < sourceMap[i + 1][0]) {
            break;
        }
        i++;
    }

    return sourceMap[i][1] + (position + 1 - sourceMap[i][0]);
}
