/**
 * Bundle `worker/` into the constants the app needs to deploy it itself.
 *
 * ── WHY THE APP HAS TO CARRY THE WORKER'S SOURCE ────────────────────────────
 * The in-app cloud setup wizard deploys the Worker over the Cloudflare REST
 * API, and that API takes a script — one ES module, complete, in a multipart
 * body. There is no wrangler, no build step on the owner's machine and no
 * network fetch of the source: the app must already hold the exact JavaScript
 * it intends to run in the cloud, plus the schema to apply and the
 * compatibility date to pin.
 *
 * ── THE FAILURE THIS FILE EXISTS TO PREVENT ─────────────────────────────────
 * An embedded copy of another directory's source is a stale copy waiting to
 * happen. Edit `worker/src/routes.ts`, forget to regenerate, and the wizard
 * cheerfully deploys last month's Worker — green tests, successful deploy,
 * wrong code in production, no error anywhere. So the generated file records a
 * SHA-256 over every input and `test/cloud/worker-bundle.test.ts` recomputes it
 * from disk. Drift is a failing test, not a mystery.
 *
 * The same test also RUNS the embedded bundle against `worker/test/fake-d1.ts`
 * and drives real requests through it, because "the hash matches" only proves
 * the input was current — not that the output works.
 *
 *   npm run bundle:worker            regenerate
 *   node tools/bundle-worker.mjs --check   exit 1 if the tracked file is stale
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = join(REPO, "worker");
const WORKER_SRC = join(WORKER_DIR, "src");
const ENTRY = join(WORKER_SRC, "index.ts");
const WRANGLER_TOML = join(WORKER_DIR, "wrangler.toml");
const SCHEMA_SQL = join(WORKER_DIR, "schema.sql");
const OUT = join(REPO, "src", "cloud", "worker-bundle.generated.ts");

/**
 * `name` and `compatibility_date`, read out of the tracked `wrangler.toml`.
 *
 * Read rather than restated, because `worker/wrangler.toml` is the file a
 * person edits when they mean to change either, and the fallback deploy path
 * (`scripts/bringup-cloud.sh`, which really does run wrangler) reads that same
 * file. Two deploy paths pinning two different compatibility dates would give
 * the Worker two different runtimes depending on which one last ran — a
 * difference nothing would report.
 *
 * A regex rather than a TOML parser: these are two flat top-level string keys
 * in a file this repo owns, and a parser dependency to read them would be the
 * larger risk. If either key is missing this THROWS, so a reformatted
 * `wrangler.toml` fails the build instead of silently defaulting — an
 * unpinned `compatibility_date` on the Workers API means 2021-11-02.
 */
export function readWranglerFields(path = WRANGLER_TOML) {
  const toml = readFileSync(path, "utf8");
  const pick = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(toml);
    if (m === null || m[1] === "") throw new Error(`${path} has no ${key}`);
    return m[1];
  };
  return { name: pick("name"), compatibilityDate: pick("compatibility_date") };
}

/**
 * A stable digest of every input the generated file is derived from.
 *
 * Filenames are hashed alongside their bytes and the list is sorted, so the
 * digest does not depend on directory order and renaming a file counts as a
 * change. It is deliberately computed from the SOURCES rather than from the
 * bundle: bundler output moves when the bundler is upgraded, and a test that
 * fails on an esbuild bump teaches people to regenerate without reading, which
 * is exactly the habit that lets real drift through.
 */
export function hashWorkerInputs(workerDir = WORKER_DIR) {
  const srcDir = join(workerDir, "src");
  const inputs = [
    ...readdirSync(srcDir)
      .filter((n) => n.endsWith(".ts"))
      .sort()
      .map((n) => [`src/${n}`, join(srcDir, n)]),
    ["schema.sql", join(workerDir, "schema.sql")],
    ["wrangler.toml", join(workerDir, "wrangler.toml")],
  ];
  const h = createHash("sha256");
  for (const [label, path] of inputs) {
    h.update(label);
    h.update("\0");
    h.update(readFileSync(path));
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * The Worker as one ES module.
 *
 * `format: "esm"` and a default export are what the Workers upload API means by
 * a module Worker; `platform: "neutral"` keeps esbuild from injecting a Node or
 * browser shim for anything, which on the Workers runtime would be a reference
 * to a global that does not exist. Nothing under `worker/src/` has a dependency
 * outside itself, so there is nothing to mark external — and if that ever stops
 * being true the build fails rather than quietly emitting an `import` the
 * Workers runtime cannot resolve.
 *
 * Not minified. The bundle is eight kilobytes either way, it ships inside an
 * Electron app rather than over a wire, and a readable one is a Worker whose
 * deployed source can be read back in the Cloudflare dashboard and compared
 * with this repo by eye.
 */
export async function bundleWorker(entry = ENTRY) {
  const res = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    minify: false,
    legalComments: "none",
    sourcemap: false,
    absWorkingDir: REPO,
  });
  const out = res.outputFiles?.[0];
  if (!out) throw new Error("esbuild produced no output for the Worker bundle");
  return out.text;
}

const HEADER = `/**
 * GENERATED — do not edit. Run \`npm run bundle:worker\`.
 *
 * \`worker/\`, reduced to the four constants \`src/cloud/\` needs to deploy it over
 * the Cloudflare REST API with no wrangler and no network fetch of the source.
 *
 * \`WORKER_INPUTS_SHA256\` is a digest of \`worker/src/*.ts\`, \`worker/schema.sql\`
 * and \`worker/wrangler.toml\`. \`test/cloud/worker-bundle.test.ts\` recomputes it
 * from disk and fails if the two disagree — which is what stops an edit to the
 * Worker from shipping a wizard that deploys the previous version of it. That
 * test also EXECUTES \`WORKER_BUNDLE\` against \`worker/test/fake-d1.ts\`, because
 * a matching hash only proves the input was current, not that the output runs.
 */
`;

export function renderModule({ code, sha, name, compatibilityDate, schemaSql }) {
  return (
    HEADER +
    `\n/** sha256 over worker/src/*.ts + schema.sql + wrangler.toml. */\n` +
    `export const WORKER_INPUTS_SHA256 = ${JSON.stringify(sha)};\n` +
    `\n/** \`name\` from worker/wrangler.toml — the Worker's name on Cloudflare. */\n` +
    `export const WORKER_NAME = ${JSON.stringify(name)};\n` +
    `\n/**\n * \`compatibility_date\` from worker/wrangler.toml.\n *\n * Sent on every upload. The Workers API defaults an unset one to 2021-11-02,\n * which is a different runtime from the one the tests run against.\n */\n` +
    `export const WORKER_COMPATIBILITY_DATE = ${JSON.stringify(compatibilityDate)};\n` +
    `\n/** The part name inside the multipart upload, and \`main_module\`. */\n` +
    `export const WORKER_MAIN_MODULE = "index.js";\n` +
    `\n/** worker/schema.sql — CREATE TABLE IF NOT EXISTS throughout, so re-applying is free. */\n` +
    `export const WORKER_SCHEMA_SQL = ${JSON.stringify(schemaSql)};\n` +
    `\nexport const WORKER_BUNDLE = ${JSON.stringify(code)};\n`
  );
}

export async function renderCurrent() {
  const { name, compatibilityDate } = readWranglerFields();
  return renderModule({
    code: await bundleWorker(),
    sha: hashWorkerInputs(),
    name,
    compatibilityDate,
    schemaSql: readFileSync(SCHEMA_SQL, "utf8"),
  });
}

async function main() {
  const next = await renderCurrent();
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(OUT, "utf8");
    } catch {
      current = "";
    }
    if (current !== next) {
      process.stderr.write(`${OUT} is stale.\nRun: npm run bundle:worker\n`);
      process.exit(1);
    }
    process.stdout.write("worker bundle is current\n");
    return;
  }
  writeFileSync(OUT, next, "utf8");
  process.stdout.write(`wrote ${OUT}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
