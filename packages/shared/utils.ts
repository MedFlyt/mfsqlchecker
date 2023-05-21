export function fmap<T, R>(value: T | null | undefined, f: (value: T) => R): R | null {
    return value === null || value === undefined ? null : f(value);
}
