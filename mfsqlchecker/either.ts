/**
 * The Either type represents values with two possibilities: either "Left" or
 * "Right"
 *
 * The Either type is sometimes used to represent a value which is either
 * correct or an error; by convention, the Left constructor is used to hold an
 * error value and the Right constructor is used to hold a correct value
 * (mnemonic: "right" also means "correct").
 */
export type Either<L, R> = Either.Left<L> | Either.Right<R>;

export namespace Either {
    export interface Left<L> {
        type: "Left";
        value: L;
    }

    export interface Right<R> {
        type: "Right";
        value: R;
    }
}
