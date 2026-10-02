#!/usr/bin/env node
/**
 * Live model-catalog drift checker.
 *
 * WHY THIS EXISTS
 * ---------------
 * lib/__tests__/providers-catalog.test.ts can verify the catalog is internally
 * consistent, but it cannot know that a provider RETIRED a model. That failure
 * is silent and total: Cerebras and OpenRouter both shipped a `default_model`
 * that no longer existed upstream, and because the same ID was used to verify
 * API keys, "Save + Verify" rejected perfectly valid keys. Neither provider
 * could be configured at all, and nothing in CI noticed.
 *
 * This script asks each provider what it actually serves and diffs that against
 * lib/providers/*. Run it whenever a provider ships something, or on a
 * schedule:
 *
 *   ANTHROPIC_API_KEY=... GROQ_API_KEY=... node scripts/check-models.cjs
 *
 * Keys are read from the environment or from .env.test.local (gitignored).
 * Providers without a key are skipped, EXCEPT OpenRouter, whose catalog is
 * public — so this reports something useful even with no keys at all.
 *
 * Exit code 1 if any configured model is missing upstream, so it can gate CI.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// --- key loading -----------------------------------------------------------
function loadKeys() {
  const env = { ...process.env };
  const f = path.join(ROOT, ".env.test.local");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      if (!env[k]) env[k] = t.slice(eq + 1).trim();
    }
  }
  return env;
}

// --- read the shipped catalog without a TS toolchain ------------------------
/** Pull `id: "..."` values out of a provider's `models: [...]` block. */
function catalogFor(file, providerConst) {
  const src = fs.readFileSync(path.join(ROOT, "lib", "providers", file), "utf8");
  const at = src.indexOf(`export const ${providerConst}: Provider`);
  if (at < 0) return null;
  const block = src.slice(at, src.indexOf("\n};", at));
  const defaultModel = (block.match(/default_model:\s*"([^"]+)"/) || [])[1];
  const modelsAt = block.indexOf("models: [");
  const modelsBlock = modelsAt < 0 ? "" : block.slice(modelsAt, block.indexOf("\n  ],", modelsAt));
  const ids = [...modelsBlock.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1]);
  return { defaultModel, ids };
}

/** testModel lives on the config objects, not the Provider. */
function testModelsFromConfigs() {
  const src = fs.readFileSync(path.join(ROOT, "lib", "providers", "openai-providers.ts"), "utf8");
  const out = {};
  for (const m of src.matchAll(/const (\w+)Cfg = \{[\s\S]*?testModel: "([^"]+)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

// --- provider endpoints -----------------------------------------------------
const PROVIDERS = [
  { id: "openrouter", file: "openai-providers.ts", konst: "openrouter", url: "https://openrouter.ai/api/v1/models", keyEnv: null, pick: (j) => j.data.map((m) => m.id) },
  { id: "anthropic", file: "anthropic.ts", konst: "anthropic", url: "https://api.anthropic.com/v1/models?limit=100", keyEnv: "ANTHROPIC_API_KEY", headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }), pick: (j) => j.data.map((m) => m.id) },
  { id: "openai", file: "openai-providers.ts", konst: "openai", url: "https://api.openai.com/v1/models", keyEnv: "OPENAI_API_KEY", pick: (j) => j.data.map((m) => m.id) },
  { id: "groq", file: "openai-providers.ts", konst: "groq", url: "https://api.groq.com/openai/v1/models", keyEnv: "GROQ_API_KEY", pick: (j) => j.data.map((m) => m.id) },
  { id: "cerebras", file: "openai-providers.ts", konst: "cerebras", url: "https://api.cerebras.ai/v1/models", keyEnv: "CEREBRAS_API_KEY", pick: (j) => j.data.map((m) => m.id) },
  { id: "together", file: "openai-providers.ts", konst: "together", url: "https://api.together.xyz/v1/models", keyEnv: "TOGETHER_API_KEY", pick: (j) => (Array.isArray(j) ? j.map((m) => m.id) : j.data.map((m) => m.id)) },
  { id: "deepseek", file: "openai-providers.ts", konst: "deepseek", url: "https://api.deepseek.com/v1/models", keyEnv: "DEEPSEEK_API_KEY", pick: (j) => j.data.map((m) => m.id) },
  { id: "mistral", file: "openai-providers.ts", konst: "mistral", url: "https://api.mistral.ai/v1/models", keyEnv: "MISTRAL_API_KEY", pick: (j) => j.data.map((m) => m.id) },
  { id: "google", file: "google.ts", konst: "google", url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", keyEnv: "GOOGLE_API_KEY", headers: (k) => ({ "x-goog-api-key": k }), pick: (j) => j.models.map((m) => m.name.replace(/^models\//, "")) },
];

async function main() {
  const env = loadKeys();
  const testModels = testModelsFromConfigs();
  let failures = 0;
  let checked = 0;

  for (const p of PROVIDERS) {
    const key = p.keyEnv ? env[p.keyEnv] : null;
    if (p.keyEnv && !key) {
      console.log(`· ${p.id.padEnd(11)} skipped (no ${p.keyEnv})`);
      continue;
    }
    const cat = catalogFor(p.file, p.konst);
    if (!cat) {
      console.log(`? ${p.id.padEnd(11)} could not read catalog`);
      continue;
    }

    let live;
    try {
      const headers = { Accept: "application/json", ...(p.headers ? p.headers(key) : key ? { Authorization: `Bearer ${key}` } : {}) };
      const res = await fetch(p.url, { headers });
      if (!res.ok) {
        console.log(`! ${p.id.padEnd(11)} HTTP ${res.status} querying ${p.url}`);
        continue;
      }
      live = new Set(p.pick(await res.json()));
    } catch (e) {
      console.log(`! ${p.id.padEnd(11)} ${e.message}`);
      continue;
    }

    checked++;
    const missing = cat.ids.filter((id) => !live.has(id));
    const testModel = testModels[p.konst];
    const testMissing = testModel && !live.has(testModel);

    if (!missing.length && !testMissing) {
      console.log(`✓ ${p.id.padEnd(11)} all ${cat.ids.length} models live (${live.size} offered)`);
      continue;
    }
    failures++;
    console.log(`✗ ${p.id.padEnd(11)} DRIFT`);
    for (const id of missing) {
      const isDefault = id === cat.defaultModel;
      console.log(`    missing upstream: ${id}${isDefault ? "   <-- default_model! provider is unusable" : ""}`);
    }
    if (testMissing) {
      console.log(`    missing upstream: ${testModel}   <-- testModel! key verification will reject valid keys`);
    }
  }

  console.log(`\n${checked} provider(s) checked, ${failures} with drift.`);
  if (failures) {
    console.log("Update lib/providers/* — a retired model breaks generation silently.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
