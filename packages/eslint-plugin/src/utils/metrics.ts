import { customLog } from "./log";

export const metrics: {
    checked: number;
    skipped: number;
    fatal: number;
    duration: number;
} = { checked: 0, skipped: 0, fatal: 0, duration: 0 };

export function withMetrics<T>(fn: () => T) {
    const now = Date.now();
    const result = fn();

    if (process.env.CI) {
        return result;
    }

    metrics.duration += Date.now() - now;

    if (metrics.checked > 0 || metrics.duration > 1000) {
        customLog.stream(
            `checked: ${metrics.checked}\tskipped: ${metrics.skipped}\tfatal: ${metrics.fatal}\tduration: ${metrics.duration}ms`
        );
    }

    return result;
}
