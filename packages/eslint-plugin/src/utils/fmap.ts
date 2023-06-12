export function fmap<T>(value: T | null | undefined, f: (value: T) => T): T | null {
    return value === null || value === undefined ? null : f(value);
}
