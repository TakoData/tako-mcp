/**
 * Vite `?raw` imports — used by `freetier.test.ts` to read
 * `wrangler.jsonc` as text for the limit-drift assertion (JSONC has
 * comments, so it can't be imported as JSON).
 */
declare module "*.jsonc?raw" {
  const text: string;
  export default text;
}
