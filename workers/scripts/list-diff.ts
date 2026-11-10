/**
 * How two ordered lists of names differ, as one line for a drift message.
 *
 * Its own module so `list-diff.test.ts` can import it: `smoke.ts` runs on
 * import and exits without its environment.
 */
export function listDiff(expected: readonly string[], actual: readonly string[]): string {
  const missing = expected.filter((name) => !actual.includes(name));
  const added = actual.filter((name) => !expected.includes(name));
  if (missing.length === 0 && added.length === 0) {
    return `the API returns the same names in a different order: expected [${expected.join(", ")}], got [${actual.join(", ")}]`;
  }
  return `the API dropped [${missing.join(", ")}] and added [${added.join(", ")}]`;
}
