import * as E from "fp-ts/Either";
import * as TE from "fp-ts/TaskEither";

/**
 * A collection of fp-ts helpers.
 */
export const X = {
    E: {
        logLeft: <E>(prefix?: string) =>
            E.mapLeft((e: E) => {
                prefix ? console.error(prefix, e) : console.error(e);
                return e;
            })
    },
    TE: {
        logLeft: <E>(prefix?: string) =>
            TE.mapLeft((e: E) => {
                prefix ? console.error(prefix, e) : console.error(e);
                return e;
            })
    }
};

export * as E from "fp-ts/Either";
export * as J from "fp-ts/Json";
export * as TE from "fp-ts/TaskEither";
export { flow, pipe } from "fp-ts/function";
