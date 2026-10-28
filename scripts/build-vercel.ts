/**
 * Build the Vercel surface: Build Output API (`.vercel/output`).
 *
 * Why this exists: under the legacy `builds` pin, @vercel/node compiled only the
 * entry file of each function, so any relative import (`../src/config/env.ts`)
 * survived into the Lambda as a runtime `require` of a raw `.ts` file — which
 * fails at module load with an empty-bodied FUNCTION_INVOCATION_FAILED. Entry-only
 * functions (api/health.ts imports types only) worked, which is why the failure
 * looked arbitrary. esbuild bundling removes the whole class: one file per
 * function, nothing to resolve at runtime but Node builtins.
 *
 * What it produces:
 *
 *   .vercel/output/functions/api/<entry>.ts.func/index.js   — bundled handler
 *   .vercel/output/functions/api/<entry>.ts.func/.vc-config.json
 *   .vercel/output/config.json                              — routes = vercel.json routes
 *
 * Route paths keep their source shape (`.ts`, `[...path]`) because CI probes
 * `/api/health.ts` and the contract test asserts a source file exists behind
 * every route dest — vercel.json stays the single source of truth for routing,
 * this script only copies it into the Build Output.
 *
 * Run via `npm run build` (after tsc). Fails the build on any bundling error.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import process from "node:process";
import { build } from "esbuild";

const ROOT = process.cwd();
const API_DIR = join(ROOT, "api");
const OUT = join(ROOT, ".vercel", "output");

/** One route as vercel.json declares it (transform args: string, not array). */
interface ConfigRoute {
  src?: string;
  dest?: string;
  handle?: string;
  transforms?: { type: string; op: string; args: string | string[] }[];
}

/**
 * Vercel launcher config, copied from what Vercel's own zero-config build
 * emitted for this project (minus filePathMap — our bundle is self-contained).
 */
const VC_CONFIG = {
  handler: "index.js",
  runtime: "nodejs24.x",
  architecture: "x86_64",
  environment: {},
  framework: { slug: "", version: "" },
  shouldDisableAutomaticFetchInstrumentation: false,
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  shouldAddSourcemapSupport: false,
  awsLambdaHandler: "",
};

async function collectEntries(dir: string): Promise<string[]> {
  const entries: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      entries.push(...(await collectEntries(path)));
    } else if (item.isFile() && item.name.endsWith(".ts")) {
      entries.push(path);
    }
  }
  return entries;
}

async function main(): Promise<void> {
  await rm(OUT, { recursive: true, force: true });

  const entries = (await collectEntries(API_DIR)).sort();
  if (entries.length === 0) {
    throw new Error("build-vercel: no api/**/*.ts entries found — nothing to serve");
  }

  for (const entry of entries) {
    // Route path = source path minus the .ts extension (posix separators),
    // function dir = route path + ".func". Extensionless for both reasons:
    // dynamic entries ([...path].ts) must parse as catch-all patterns, and a
    // route whose src equals its dest (e.g. /api/health.ts -> /api/health.ts)
    // is a self-rewrite Vercel skips, which404'd the CI probe path.
    const sourcePath = "/" + relative(ROOT, entry).split(sep).join("/");
    const routePath = sourcePath.replace(/\.ts$/, "");
    const funcDir = join(OUT, "functions", routePath.slice(1) + ".func");
    await build({
      entryPoints: [entry],
      outfile: join(funcDir, "index.js"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      // pg guards its optional native binding in a try/catch that never runs here.
      external: ["pg-native"],
      logLevel: "warning",
      // Entries export default handlers; CJS interop leaves them under .default,
      // and the launcher must find a plain function at module.exports.
      footer: { js: "module.exports = module.exports.default || module.exports;" },
    });
    // The repo is "type": "module"; without this the .js bundle inside the func
    // resolves to the ROOT package.json and dies at `module is not defined`.
    await writeFile(
      join(funcDir, "package.json"),
      `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
    );
    await writeFile(join(funcDir, ".vc-config.json"), `${JSON.stringify(VC_CONFIG, null, 2)}\n`);
    process.stdout.write(`bundled ${routePath}\n`);
  }

  // Routes: vercel.json is the contract (contract-coverage.test.ts validates it),
  // so the Build Output carries them verbatim rather than growing a second
  // opinion. Transform `args` stay STRINGS on both sides: `vercel deploy
  // --prebuilt` validates config.json against the same schema and rejects an
  // array with "should be string" — and an array-args transform is silently
  // ignored at runtime, which is why the review handler first saw the dest
  // path instead of the request path.
  const vercelJson = JSON.parse(await readFile(join(ROOT, "vercel.json"), "utf8")) as {
    routes?: ConfigRoute[];
  };
  if (!Array.isArray(vercelJson.routes) || vercelJson.routes.length === 0) {
    throw new Error("build-vercel: vercel.json has no routes — the surface would serve nothing");
  }
  const routes = vercelJson.routes;
  await mkdir(OUT, { recursive: true });
  await writeFile(
    join(OUT, "config.json"),
    `${JSON.stringify({ version: 3, routes, crons: [] }, null, 2)}\n`,
  );
  process.stdout.write(`config.json ← vercel.json routes (${routes.length})\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`build-vercel: ${(error as Error).message}\n`);
  process.exit(1);
});
