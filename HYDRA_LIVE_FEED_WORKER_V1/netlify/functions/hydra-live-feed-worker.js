/**
 * HYDRA_LIVE_FEED_WORKER_V1 — NETLIFY FUNCTION UPDATE
 * Browserbase + OpenAI -> Hydra live leverage signal feed.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const BrowserbaseModule = require("@browserbasehq/sdk");
const Browserbase = BrowserbaseModule.default || BrowserbaseModule;
const { chromium } = require("playwright-core");
const OpenAIModule = require("openai");
const OpenAI = OpenAIModule.default || OpenAIModule;

const DEFAULT_KEYWORDS = [
  "need", "asap", "urgent", "today", "tomorrow", "this week", "denied", "declined",
  "bad credit", "down payment", "for work", "looking for", "reliable", "installer",
  "delayed", "backup", "overflow", "vendor", "contractor", "scam", "scammers",
  "verified", "proof", "direct", "mandate", "funds ready", "seller", "buyer",
  "budget", "payment", "wholesale", "below market"
];

const CLASSIFICATION_SCHEMA = {
  name: "hydra_live_feed_signal",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "is_signal", "vertical", "primary_friction", "secondary_friction", "leverage_density",
      "conversion_probability", "priority", "route_type", "next_action", "risk_notes", "summary"
    ],
    properties: {
      is_signal: { type: "boolean" },
      vertical: { type: "string", enum: ["Cars", "Appliances / Trades", "OTC / Bitcoin", "Real Estate", "Gold", "Pharmaceuticals", "General"] },
      primary_friction: { type: "string", enum: ["ACCESS_GAP", "URGENCY_PRESSURE", "TRUST_FRICTION", "COORDINATION_FAILURE", "SUPPLIER_GAP", "LIQUIDITY_PRESSURE", "PRICING_ASYMMETRY", "BUYER_INTENT", "DISTRESS_SIGNAL", "GENERAL_FRICTION"] },
      secondary_friction: { type: "string" },
      leverage_density: { type: "integer", minimum: 0, maximum: 100 },
      conversion_probability: { type: "integer", minimum: 0, maximum: 100 },
      priority: { type: "string", enum: ["HOT", "ACTIVE", "WATCH", "LOW", "REJECT"] },
      route_type: { type: "string", enum: ["DEAL_DESK", "VERIFY_FIRST", "QUALIFY_FAST", "WATCH", "ARCHIVE", "REJECT"] },
      next_action: { type: "string" },
      risk_notes: { type: "string" },
      summary: { type: "string" }
    }
  }
};

function env(name, fallback = "") { return process.env[name] || fallback; }
function intEnv(name, fallback) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : fallback; }
function boolEnv(name, fallback = false) {
  const v = String(process.env[name] || "").toLowerCase();
  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;
  return fallback;
}
function requireEnv(name) { const value = process.env[name]; if (!value) throw new Error(`Missing required environment variable: ${name}`); return value; }
function requireEnvAny(names) { for (const name of names) { if (process.env[name]) return process.env[name]; } throw new Error(`Missing required environment variable. Provide one of: ${names.join(", ")}`); }
function stableHash(text) { return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 24); }
function normalizeWhitespace(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
function truncate(text, max = 4000) { const s = normalizeWhitespace(text); return s.length > max ? s.slice(0, max) + "..." : s; }

function parseTargets() {
  const raw = process.env.HYDRA_FEED_TARGETS_JSON;
  if (raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("HYDRA_FEED_TARGETS_JSON must be a JSON array.");
    return parsed.filter((t) => t.enabled !== false);
  }
  const configPath = path.join(process.cwd(), "hydra-feeds.config.example.json");
  if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, "utf8")).filter((t) => t.enabled !== false);
  return [];
}

function buildSearchUrl(query) { return `https://www.google.com/search?q=${encodeURIComponent(query)}`; }

async function createBrowserbasePage() {
  const apiKey = requireEnv("BROWSERBASE_API_KEY");
  const projectId = requireEnv("BROWSERBASE_PROJECT_ID");
  const bb = new Browserbase({ apiKey });
  const session = await bb.sessions.create({ projectId });
  const connectUrl = session.connectUrl || session.connect_url || session.browserUrl || session.browser_url || session.wsEndpoint || session.ws_endpoint;
  if (!connectUrl) throw new Error(`Browserbase session created but no connect URL returned. Session keys: ${Object.keys(session).join(", ")}`);
  const browser = await chromium.connectOverCDP(connectUrl);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  return { browser, page, session };
}

async function extractVisibleTextFromTarget(page, target) {
  const timeout = intEnv("BROWSERBASE_TIMEOUT_MS", 45000);
  const url = target.type === "search" ? buildSearchUrl(target.query) : target.url;
  if (!url) throw new Error(`Target ${target.name || "unnamed"} has no url/query.`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await page.waitForTimeout(2000);
  const title = await page.title().catch(() => "");
  const pageUrl = page.url();
  const bodyText = await page.evaluate(() => {
    ["script", "style", "noscript", "svg", "canvas"].forEach((selector) => document.querySelectorAll(selector).forEach((n) => n.remove()));
    return document.body ? document.body.innerText : "";
  });
  return { target_name: target.name || "", target_type: target.type || "url", source_url: pageUrl, original_url: url, page_title: title, text: normalizeWhitespace(bodyText) };
}

function extractCandidateSnippets(extracted, target) {
  const maxCandidates = intEnv("MAX_CANDIDATES_PER_TARGET", 8);
  const keywords = Array.isArray(target.keywords) && target.keywords.length ? target.keywords : DEFAULT_KEYWORDS;
  const rawParts = String(extracted.text || "").split(/\n|(?<=\.)\s+/).map(normalizeWhitespace).filter((p) => p.length >= 40 && p.length <= 900);
  const scored = rawParts.map((text) => {
    const lower = text.toLowerCase();
    let score = 0;
    for (const kw of keywords) if (lower.includes(String(kw).toLowerCase())) score += 1;
    return { text, score };
  });
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, maxCandidates).map((x) => ({
    candidate_id: stableHash(`${extracted.source_url}|${x.text}`),
    raw_text: x.text,
    keyword_score: x.score,
    source_url: extracted.source_url,
    page_title: extracted.page_title,
    target_name: extracted.target_name,
    vertical_hint: target.vertical || "General",
    source_channel: target.source_channel || "Browserbase",
    source_type: target.type === "search" ? "Browserbase Search" : "Browserbase URL"
  }));
}

async function classifyCandidate(openai, candidate) {
  const model = env("OPENAI_MODEL", "gpt-4.1-mini");
  const prompt = `You are Hydra's leverage signal classifier.\n\nClassify this public web text for monetizable leverage: buyers under pressure, access gaps, urgency, trust friction, coordination failure, supplier gaps, liquidity pressure, pricing asymmetry, distress. Reject weak/noisy/non-actionable text.\n\nVertical hint: ${candidate.vertical_hint}\nSource: ${candidate.source_channel}\nURL: ${candidate.source_url}\n\nTEXT:\n${truncate(candidate.raw_text, 2500)}`;
  const response = await openai.chat.completions.create({
    model,
    temperature: 0.1,
    messages: [
      { role: "system", content: "You extract structured Hydra leverage intelligence. Be strict. Only mark is_signal=true when there is clear monetizable pressure or buyer/supplier friction." },
      { role: "user", content: prompt }
    ],
    response_format: { type: "json_schema", json_schema: CLASSIFICATION_SCHEMA }
  });
  const content = response.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

function buildHydraPayload(candidate, classification) {
  const now = new Date().toISOString();
  return {
    system: "HYDRA_LIVE_FEED_WORKER_V1",
    timestamp: now,
    source_type: candidate.source_type,
    source_channel: candidate.source_channel,
    source_name: candidate.target_name,
    source_url: candidate.source_url,
    source_title: candidate.page_title,
    raw_text: candidate.raw_text,
    raw_signal: candidate.raw_text,
    message: candidate.raw_text,
    vertical: classification.vertical,
    vertical_hint: classification.vertical,
    primary_friction: classification.primary_friction,
    secondary_friction: classification.secondary_friction,
    leverage_density: classification.leverage_density,
    conversion_probability: classification.conversion_probability,
    priority: classification.priority,
    route_type: classification.route_type,
    next_action: classification.next_action,
    risk_notes: classification.risk_notes,
    ai_summary: classification.summary,
    duplicate_key: candidate.candidate_id,
    operator_note: `Live feed candidate classified by OpenAI. ${classification.summary}`
  };
}

async function postToHydra(payload) {
  const dryRun = boolEnv("HYDRA_DRY_RUN", false);
  if (dryRun) return { status: "DRY_RUN", payload };
  const webhook = requireEnvAny(["HYDRA_WEBHOOK_URL", "HYDRA_APPS_SCRIPT_WEBHOOK"]);
  const res = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!res.ok) throw new Error(`Hydra webhook failed ${res.status}: ${text}`);
  return { status: "POSTED", response: parsed };
}

async function runLiveFeed() {
  requireEnv("OPENAI_API_KEY");
  requireEnv("BROWSERBASE_API_KEY");
  requireEnv("BROWSERBASE_PROJECT_ID");
  if (!boolEnv("HYDRA_DRY_RUN", false)) requireEnvAny(["HYDRA_WEBHOOK_URL", "HYDRA_APPS_SCRIPT_WEBHOOK"]);
  const targets = parseTargets().slice(0, intEnv("MAX_TARGETS_PER_RUN", 8));
  if (!targets.length) throw new Error("No feed targets configured.");
  const minDensity = intEnv("MIN_LEVERAGE_DENSITY", 60);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const run = { run_id: `HYDRA-FEED-${Date.now()}`, started_at: new Date().toISOString(), targets: targets.length, extracted_candidates: 0, accepted_signals: 0, rejected_candidates: 0, posted: [], errors: [] };
  let browser;
  try {
    const browserSession = await createBrowserbasePage();
    browser = browserSession.browser;
    const page = browserSession.page;
    for (const target of targets) {
      try {
        const extracted = await extractVisibleTextFromTarget(page, target);
        const candidates = extractCandidateSnippets(extracted, target);
        run.extracted_candidates += candidates.length;
        for (const candidate of candidates) {
          try {
            const classification = await classifyCandidate(openai, candidate);
            if (!classification.is_signal || classification.priority === "REJECT" || Number(classification.leverage_density || 0) < minDensity) {
              run.rejected_candidates += 1;
              continue;
            }
            const payload = buildHydraPayload(candidate, classification);
            const postResult = await postToHydra(payload);
            run.accepted_signals += 1;
            run.posted.push({ duplicate_key: payload.duplicate_key, vertical: payload.vertical, primary_friction: payload.primary_friction, leverage_density: payload.leverage_density, priority: payload.priority, post_status: postResult.status });
          } catch (err) { run.errors.push({ scope: "candidate", target: target.name, message: err.message }); }
        }
      } catch (err) { run.errors.push({ scope: "target", target: target.name, message: err.message }); }
    }
  } finally { if (browser) await browser.close().catch(() => {}); }
  run.finished_at = new Date().toISOString();
  return run;
}

function configCheck() {
  const targets = parseTargets();
  return {
    status: "OK",
    required_env: {
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      BROWSERBASE_API_KEY: !!process.env.BROWSERBASE_API_KEY,
      BROWSERBASE_PROJECT_ID: !!process.env.BROWSERBASE_PROJECT_ID,
      HYDRA_WEBHOOK_URL: !!process.env.HYDRA_WEBHOOK_URL,
      HYDRA_APPS_SCRIPT_WEBHOOK: !!process.env.HYDRA_APPS_SCRIPT_WEBHOOK,
      HYDRA_WORKER_SECRET: !!process.env.HYDRA_WORKER_SECRET
    },
    optional_env: {
      OPENAI_MODEL: env("OPENAI_MODEL", "gpt-4.1-mini"),
      MIN_LEVERAGE_DENSITY: intEnv("MIN_LEVERAGE_DENSITY", 60),
      MAX_CANDIDATES_PER_TARGET: intEnv("MAX_CANDIDATES_PER_TARGET", 8),
      MAX_TARGETS_PER_RUN: intEnv("MAX_TARGETS_PER_RUN", 8),
      HYDRA_DRY_RUN: boolEnv("HYDRA_DRY_RUN", false)
    },
    target_count: targets.length,
    targets
  };
}

exports.handler = async function(event) {
  try {
    const params = event.queryStringParameters || {};
    const headers = event.headers || {};
    const secret = params.secret || headers["x-hydra-secret"] || headers["X-Hydra-Secret"];
    const expected = process.env.HYDRA_WORKER_SECRET;

    if (expected && secret !== expected) {
      return jsonResponse(401, { status: "ERROR", message: "Unauthorized." });
    }

    if (params.mode === "config" || params.config === "1") {
      return jsonResponse(200, configCheck());
    }

    const result = await runLiveFeed();
    return jsonResponse(200, { status: "OK", result });
  } catch (err) {
    return jsonResponse(500, {
      status: "ERROR",
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined
    });
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

if (process.argv.includes("--config-check")) console.log(JSON.stringify(configCheck(), null, 2));
if (process.argv.includes("--once")) {
  runLiveFeed().then((result) => { console.log(JSON.stringify({ status: "OK", result }, null, 2)); process.exit(0); }).catch((err) => { console.error(JSON.stringify({ status: "ERROR", message: err.message, stack: err.stack }, null, 2)); process.exit(1); });
}
