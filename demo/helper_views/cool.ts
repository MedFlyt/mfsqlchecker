import { Opt, Req } from "@mfsqlchecker/client";
import { defineSqlView } from "../core";

export const coolView = defineSqlView`SELECT 5`;

export function x(): void {
    //
}

export interface XXX {
    blah: Opt<number>;
    asdf: Req<null>;
}
