// Typed as `unknown` on purpose: the SLM seed JSON is ~1.6MB and would bloat
// the tsc type graph if resolveJsonModule inferred its literal shape. The
// loader casts it to SlmSeedData at the single import site.
declare module "*/slm-articles.json" {
  const data: unknown;
  export default data;
}
