import { defineSqlView, Opt, Req } from "../../lib/mfsqltool";

export const coolView = defineSqlView`SELECT 5`;

export function x(): void {
}

export interface XXX {
    blah: Opt<number>;
    asdf: Req<null>;
};
