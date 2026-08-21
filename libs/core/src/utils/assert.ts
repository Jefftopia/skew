/**
 * A generic assertion function.
 *
 * Typescript doesn't consider `console.assert` to be an assertion function, hence this wrapper.
 * https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-7.html#assertion-functions
 */
export function assert(value: boolean, message: string): asserts value {
  console.assert(value, message);
}
