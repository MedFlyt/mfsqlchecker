import { customLog } from "./log";

export const metrics: {
    ok: number;
    no: number;
    duration: number;
} = { ok: 0, no: 0, duration: 0 };

export function withMetrics<T>(fn: () => T) {
    const now = Date.now();
    const result = fn();
    metrics.duration += Date.now() - now;

    if (metrics.ok > 0 || metrics.duration > 1000) {
        customLog.stream(
            `qualified: ${metrics.ok}\tnon-qualified: ${metrics.no}\tduration: ${metrics.duration}ms`
        );
    }

    return result;
}
