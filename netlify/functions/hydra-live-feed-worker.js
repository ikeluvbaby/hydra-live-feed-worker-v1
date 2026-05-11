'use strict';

/**
 * HYDRA LIVE FEED WORKER V1 — BROWSERBASE FULL POWER BUILD
 * ---------------------------------------------------------
 * Netlify-compatible CommonJS function.
 *
 * What changed:
 * - Browserbase is now an ACTIVE extraction mode, not just env-ready.
 * - Supports source_type:
 *    - "url"               = direct fetch first, Browserbase fallback if fetch fails
 *    - "browserbase_url"   = force Browserbase browser extraction
 *    - "browserbase_search"= Browserbase Search API → Browserbase browser extraction on results
 *    - "mock"              = local test signal
 *
 * Diagnostic URLs:
 *   /.netlify/functions/hydra-live-feed-worker?selftest=1
 *   /.netlify/functions/hydra-live-feed-worker?mock=1
 *   /.netlify/functions/hydra-live-feed-worker?posttest=1
 *   /.netlify/functions/hydra-live-feed-worker?bbtest=1
 *   /.netlify/functions/hydra-live-feed-worker?bbsearch=need%20car%20bad%20credit
 *   /.netlify/functions/hydra-live-feed-worker
 */

const { chromium } = require('playwright-core');

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const BROWSERBASE_API = 'https://api.browserbase.com/v1';

exports.handler = async function handler(event) {
  const startedAt = new Date().toISOString();
  const query = event.queryStringParameters || {};

  try {
    if (query.selftest === '1' || query.mode === 'selftest') {
      return json(200, runSelfTest());
    }

    if (query.mock === '1' || query.mode === 'mock') {
      const result = await runMockClassificationOnly(startedAt);
      return json(200, result);
    }

    if (query.posttest === '1' || query.mode === 'posttest') {
      const result = await runMockPostToHydra(startedAt);
      return json(200, result);
    }

    if (query.bbtest === '1' || query.mode === 'bbtest') {
      const url = query.url || 'https://example.com';
      const result = await runBrowserbaseExtractionTest(startedAt, url);
      return json(200, result);
    }

    if (query.bbsearch || query.mode === 'bbsearch') {
      const searchQuery = query.bbsearch || query.q || 'need car bad credit';
      const result = await runBrowserbaseSearchTest(startedAt, searchQuery);
      return json(200, result);
    }

    const result = await runLiveFeed(startedAt);
    return json(200, result);
  } catch (err) {
    return json(200, {
      status: 'ERROR',
      message: err.message || String(err),
      stack: String(err.stack || '').split('\n').slice(0, 8),
      finished_at: new Date().toISOString()
    });
  }
};

function runSelfTest() {
  const targetsRaw = process.env.HYDRA_FEED_TARGETS_JSON || process.env.HYDRA_FEED_TARGETS || '';
  const parsed = parseTargetsSafe(targetsRaw);
  const checks = [
    check('OPENAI_API_KEY', !!process.env.OPENAI_API_KEY, 'Required for AI leverage classification.'),
    check('HYDRA_WEBHOOK_URL', !!process.env.HYDRA_WEBHOOK_URL, 'Required to post accepted signals into Hydra.'),
    check('HYDRA_FEED_TARGETS_JSON_OR_HYDRA_FEED_TARGETS', !!targetsRaw, 'Required for live feed targets.'),
    check('FEED_TARGETS_PARSE', parsed.ok, parsed.ok ? `Parsed ${parsed.targets.length} target(s).` : parsed.error),
    check('BROWSERBASE_API_KEY', !!process.env.BROWSERBASE_API_KEY, 'Required for Browserbase extraction mode.'),
    check('BROWSERBASE_PROJECT_ID', !!process.env.BROWSERBASE_PROJECT_ID, 'Recommended for Browserbase session creation.')
  ];

  const requiredPassed = checks
    .filter(c => !c.optional)
    .every(c => c.pass);

  return {
    status: requiredPassed ? 'PASS' : 'FAIL',
    selftest: true,
    version: 'HYDRA_LIVE_FEED_WORKER_V1_BROWSERBASE_FULL_POWER',
    browserbase_active_modes: ['browserbase_url', 'browserbase_search', 'url_with_fallback'],
    checks,
    next_urls: {
      browserbase_extract_test: '/.netlify/functions/hydra-live-feed-worker?bbtest=1',
      browserbase_search_test: '/.netlify/functions/hydra-live-feed-worker?bbsearch=need%20car%20bad%20credit',
      mock_ai_only: '/.netlify/functions/hydra-live-feed-worker?mock=1',
      post_test_to_hydra: '/.netlify/functions/hydra-live-feed-worker?posttest=1',
      live_run: '/.netlify/functions/hydra-live-feed-worker'
    },
    finished_at: new Date().toISOString()
  };
}

function check(name, pass, note) {
  const optionalNames = ['BROWSERBASE_PROJECT_ID'];
  return { name, pass: !!pass, optional: optionalNames.includes(name), note };
}

async function runMockClassificationOnly(startedAt) {
  const candidate = {
    name: 'Hydra Mock Cars Buyer Intent',
    source_type: 'mock',
    source_name: 'Hydra Self-Test',
    source_url: 'selftest://mock-cars-buyer',
    vertical_hint: 'Cars',
    text: 'I need a car this week. My credit is bad, I was denied by two dealers, but I have $2000 down and need something reliable for work ASAP.'
  };

  const classified = await classifyCandidate(candidate);
  return {
    status: 'OK',
    mode: 'mock_ai_only',
    started_at: startedAt,
    extracted_candidates: 1,
    classification: classified,
    accepted_signals: isAccepted(classified) ? 1 : 0,
    posted: [],
    finished_at: new Date().toISOString()
  };
}

async function runMockPostToHydra(startedAt) {
  const candidate = {
    name: 'Hydra Mock Post Test',
    source_type: 'mock',
    source_name: 'Hydra Self-Test',
    source_url: 'selftest://mock-post-to-hydra',
    vertical_hint: 'Cars',
    text: 'I need a car this week. Bad credit. I have $2000 down. Need vehicle for work ASAP.'
  };

  const classified = await classifyCandidate(candidate);
  const payload = buildHydraPayload(candidate, classified);
  const post = await postToHydra(payload);

  return {
    status: post.ok ? 'OK' : 'ERROR',
    mode: 'posttest',
    started_at: startedAt,
    extracted_candidates: 1,
    accepted_signals: isAccepted(classified) ? 1 : 0,
    hydra_post: post,
    payload_preview: payload,
    finished_at: new Date().toISOString()
  };
}

async function runBrowserbaseExtractionTest(startedAt, url) {
  const target = {
    name: 'Browserbase Extraction Test',
    source_type: 'browserbase_url',
    url,
    vertical_hint: 'Cars'
  };

  const candidates = await extractViaBrowserbase(target);
  const classifications = [];
  let accepted = 0;

  for (const candidate of candidates) {
    const classified = await classifyCandidate(candidate);
    classifications.push({ candidate_preview: previewCandidate(candidate), classified });
    if (isAccepted(classified)) accepted++;
  }

  return {
    status: 'OK',
    mode: 'bbtest',
    started_at: startedAt,
    target_url: url,
    extracted_candidates: candidates.length,
    accepted_signals: accepted,
    classifications,
    finished_at: new Date().toISOString()
  };
}

async function runBrowserbaseSearchTest(startedAt, query) {
  const target = {
    name: 'Browserbase Search Test',
    source_type: 'browserbase_search',
    query,
    num_results: 3,
    vertical_hint: 'Cars'
  };

  const candidates = await extractCandidates(target);
  const classifications = [];
  let accepted = 0;

  for (const candidate of candidates) {
    const classified = await classifyCandidate(candidate);
    classifications.push({ candidate_preview: previewCandidate(candidate), classified });
    if (isAccepted(classified)) accepted++;
  }

  return {
    status: 'OK',
    mode: 'bbsearch',
    started_at: startedAt,
    query,
    extracted_candidates: candidates.length,
    accepted_signals: accepted,
    classifications,
    finished_at: new Date().toISOString()
  };
}

async function runLiveFeed(startedAt) {
  const targetsRaw = process.env.HYDRA_FEED_TARGETS_JSON || process.env.HYDRA_FEED_TARGETS || '';
  const parsed = parseTargetsSafe(targetsRaw);
  if (!parsed.ok || parsed.targets.length === 0) {
    return {
      status: 'ERROR',
      message: 'No feed targets configured or JSON parse failed.',
      parse_error: parsed.error || null,
      env_hint: 'Set HYDRA_FEED_TARGETS_JSON to an array of target objects.',
      finished_at: new Date().toISOString()
    };
  }

  const result = {
    status: 'OK',
    result: {
      run_id: 'HYDRA-FEED-' + Date.now(),
      version: 'BROWSERBASE_FULL_POWER',
      started_at: startedAt,
      targets: parsed.targets.length,
      extracted_candidates: 0,
      accepted_signals: 0,
      rejected_candidates: 0,
      posted: [],
      errors: []
    }
  };

  const maxTargets = Number(process.env.HYDRA_MAX_TARGETS_PER_RUN || 5);
  const activeTargets = parsed.targets.slice(0, maxTargets);

  for (const target of activeTargets) {
    try {
      const candidates = await extractCandidates(target);
      result.result.extracted_candidates += candidates.length;

      for (const candidate of candidates) {
        const classified = await classifyCandidate(candidate);

        if (!isAccepted(classified)) {
          result.result.rejected_candidates += 1;
          continue;
        }

        result.result.accepted_signals += 1;
        const payload = buildHydraPayload(candidate, classified);
        const post = await postToHydra(payload);
        result.result.posted.push(post);
      }
    } catch (err) {
      result.result.errors.push({
        target: target.name || target.url || target.query || 'unknown',
        source_type: target.source_type || 'url',
        message: err.message || String(err)
      });
    }
  }

  result.result.finished_at = new Date().toISOString();
  return result;
}

function parseTargetsSafe(raw) {
  if (!raw) return { ok: false, targets: [], error: 'Empty target env var.' };
  try {
    const parsed = JSON.parse(raw);
    const targets = Array.isArray(parsed) ? parsed : [parsed];
    return { ok: true, targets, error: null };
  } catch (err) {
    return { ok: false, targets: [], error: err.message };
  }
}

async function extractCandidates(target) {
  const sourceType = String(target.source_type || 'url').toLowerCase();

  if (sourceType === 'mock') {
    return [{
      name: target.name || 'Mock target',
      source_type: 'mock',
      source_name: target.source_name || target.name || 'Mock',
      source_url: target.url || 'mock://target',
      vertical_hint: target.vertical_hint || 'General',
      text: target.text || target.raw_text || ''
    }].filter(c => c.text);
  }

  if (sourceType === 'browserbase_search') {
    return await extractViaBrowserbaseSearch(target);
  }

  if (sourceType === 'browserbase_url' || sourceType === 'browserbase_browser' || target.use_browserbase === true) {
    return await extractViaBrowserbase(target);
  }

  if (target.url) {
    try {
      const text = await fetchPlainText(target.url);
      const cleaned = cleanText(text).slice(0, 7000);
      if (!cleaned || cleaned.length < 80) return [];
      return [{
        name: target.name || target.url,
        source_type: sourceType,
        source_name: target.name || target.url,
        source_url: target.url,
        vertical_hint: target.vertical_hint || target.vertical || 'General',
        text: cleaned,
        extractor: 'direct_fetch'
      }];
    } catch (err) {
      const fallbackEnabled = target.browserbase_fallback !== false && !!process.env.BROWSERBASE_API_KEY;
      if (fallbackEnabled) return await extractViaBrowserbase({ ...target, fallback_reason: err.message });
      throw err;
    }
  }

  return [];
}

async function extractViaBrowserbaseSearch(target) {
  requireBrowserbaseEnv();
  const query = target.query || target.search_query || target.q;
  if (!query) throw new Error('browserbase_search target missing query.');

  const numResults = Math.min(Math.max(Number(target.num_results || target.numResults || 5), 1), 10);
  const searchResponse = await browserbaseSearch(query, numResults);
  const results = Array.isArray(searchResponse.results) ? searchResponse.results : [];

  const maxOpen = Math.min(Number(target.open_results || target.openResults || 3), results.length);
  const candidates = [];

  for (const result of results.slice(0, maxOpen)) {
    try {
      const pageCandidates = await extractViaBrowserbase({
        ...target,
        source_type: 'browserbase_url',
        name: `${target.name || 'Browserbase Search'} — ${result.title || result.url}`,
        url: result.url,
        search_query: query,
        search_title: result.title
      });
      candidates.push(...pageCandidates);
    } catch (err) {
      candidates.push({
        name: `${target.name || 'Browserbase Search'} — failed result`,
        source_type: 'browserbase_search_error',
        source_name: target.name || 'Browserbase Search',
        source_url: result.url,
        vertical_hint: target.vertical_hint || target.vertical || 'General',
        text: `Browserbase could not open result: ${result.url}. Error: ${err.message}`,
        extractor: 'browserbase_search_error'
      });
    }
  }

  return candidates.filter(c => c.text && c.text.length > 80);
}

async function extractViaBrowserbase(target) {
  requireBrowserbaseEnv();
  if (!target.url) throw new Error('Browserbase extraction target missing url.');

  const session = await createBrowserbaseSession(target);
  let browser;
  try {
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    await page.setDefaultNavigationTimeout(Number(process.env.HYDRA_BROWSERBASE_NAV_TIMEOUT_MS || 25000));
    await page.setDefaultTimeout(Number(process.env.HYDRA_BROWSERBASE_TIMEOUT_MS || 20000));

    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: Number(process.env.HYDRA_BROWSERBASE_NAV_TIMEOUT_MS || 25000) });

    const settleMs = Number(target.settle_ms || target.settleMs || process.env.HYDRA_BROWSERBASE_SETTLE_MS || 2500);
    await page.waitForTimeout(settleMs);

    if (target.scroll !== false) {
      await autoScroll(page, Number(target.scroll_steps || target.scrollSteps || 3));
    }

    const title = await page.title().catch(() => '');
    const visibleText = await page.locator('body').innerText({ timeout: 10000 }).catch(async () => {
      return await page.evaluate(() => document.body ? document.body.innerText : '');
    });

    const cleaned = cleanText(visibleText).slice(0, Number(process.env.HYDRA_BROWSERBASE_MAX_CHARS || 9000));

    if (!cleaned || cleaned.length < 80) return [];

    return [{
      name: target.name || title || target.url,
      source_type: target.source_type || 'browserbase_url',
      source_name: target.name || title || target.url,
      source_url: target.url,
      vertical_hint: target.vertical_hint || target.vertical || 'General',
      text: cleaned,
      extractor: 'browserbase_playwright',
      browserbase_session_id: session.id,
      browserbase_recording_url: `https://browserbase.com/sessions/${session.id}`,
      fallback_reason: target.fallback_reason || ''
    }];
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await releaseBrowserbaseSession(session.id).catch(() => {});
  }
}

async function browserbaseSearch(query, numResults) {
  const res = await fetch(`${BROWSERBASE_API}/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bb-api-key': process.env.BROWSERBASE_API_KEY
    },
    body: JSON.stringify({ query, numResults })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Browserbase Search failed ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function createBrowserbaseSession(target) {
  const body = {
    projectId: process.env.BROWSERBASE_PROJECT_ID || undefined,
    timeout: Number(target.session_timeout || process.env.HYDRA_BROWSERBASE_SESSION_TIMEOUT || 120),
    proxies: target.proxies === undefined ? true : target.proxies,
    region: target.region || process.env.BROWSERBASE_REGION || 'us-east-1',   
    browserSettings: {
      blockAds: true,
      solveCaptchas: target.solve_captchas === undefined ? true : !!target.solve_captchas,
      recordSession: true,
      logSession: true
    }
  };

  const res = await fetch(`${BROWSERBASE_API}/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-BB-API-Key': process.env.BROWSERBASE_API_KEY
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Browserbase session create failed ${res.status}: ${text.slice(0, 700)}`);
  return JSON.parse(text);
}

async function releaseBrowserbaseSession(sessionId) {
  if (!sessionId || !process.env.BROWSERBASE_API_KEY) return;
  await fetch(`${BROWSERBASE_API}/sessions/${sessionId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-BB-API-Key': process.env.BROWSERBASE_API_KEY
    },
    body: JSON.stringify({
      status: 'REQUEST_RELEASE',
      projectId: process.env.BROWSERBASE_PROJECT_ID || undefined
    })
  });
}

async function autoScroll(page, steps) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.85)));
    await page.waitForTimeout(800);
  }
}

function requireBrowserbaseEnv() {
  if (!process.env.BROWSERBASE_API_KEY) throw new Error('Missing BROWSERBASE_API_KEY.');
}

async function fetchPlainText(url) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'user-agent': 'Mozilla/5.0 HydraLiveFeedWorker/1.0',
      'accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8'
    }
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  const html = await res.text();
  return stripHtml(html);
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function classifyCandidate(candidate) {
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY.');

  const prompt = `You are Hydra's leverage-intelligence classifier.

Analyze the raw public signal for buyer/seller leverage. Return strict JSON only with keys:
status, vertical, primary_friction, leverage_density, conversion_probability, urgency_score, access_gap_score, trust_friction_score, summary, route_type, reason.

Accept only real leverage:
- first-person urgency
- bad credit/access gap
- denied financing
- need vehicle for work/family
- low down payment pressure
- trust friction
- coordination failure
- fulfillment bottleneck
- liquidity pressure
- pricing asymmetry

Reject:
- dealership sales copy
- SEO articles
- generic search pages
- pure advice content
- weak/non-actionable discussions

Vertical hint: ${candidate.vertical_hint}
Source: ${candidate.source_name}
Extractor: ${candidate.extractor || candidate.source_type}
URL: ${candidate.source_url}

Text:
${candidate.text}`;

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: 'Return strict JSON only. No markdown. Use numeric scores 0-100.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1
    })
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`OpenAI error ${response.status}: ${raw.slice(0, 400)}`);
  const data = JSON.parse(raw);
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return parseJsonFromText(content || '{}');
}

function parseJsonFromText(text) {
  const s = String(text || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(s); } catch (err) {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw err;
  }
}

function isAccepted(classified) {
  const status = String(classified.status || '').toUpperCase();
  const route = String(classified.route_type || '').toUpperCase();
  const leverage = Number(classified.leverage_density || 0);
  const conversion = Number(classified.conversion_probability || 0);
  const urgency = Number(classified.urgency_score || 0);
  const access = Number(classified.access_gap_score || 0);

  return status === 'ACCEPT'
    || route.includes('HOT')
    || (leverage >= 60 && conversion >= 45)
    || (urgency >= 70 && access >= 60);
}

function buildHydraPayload(candidate, classified) {
  return {
    source_module: 'HYDRA_LIVE_FEED_WORKER_V1_BROWSERBASE_FULL_POWER',
    source_type: candidate.source_type || 'url',
    source_channel: candidate.extractor || candidate.source_type || 'url',
    source_name: candidate.source_name || candidate.name || '',
    source_url: candidate.source_url || '',
    vertical: classified.vertical || candidate.vertical_hint || 'General',
    vertical_hint: candidate.vertical_hint || classified.vertical || 'General',
    raw_signal: candidate.text || '',
    raw_text: candidate.text || '',
    message: classified.summary || candidate.text || '',
    primary_friction: classified.primary_friction || 'UNKNOWN',
    leverage_density: Number(classified.leverage_density || 0),
    conversion_probability: Number(classified.conversion_probability || 0),
    urgency_score: Number(classified.urgency_score || 0),
    access_gap_score: Number(classified.access_gap_score || 0),
    trust_friction_score: Number(classified.trust_friction_score || 0),
    route_type: classified.route_type || 'ARCHIVE_OR_MONITOR',
    ai_summary: classified.summary || '',
    ai_reason: classified.reason || '',
    browserbase_session_id: candidate.browserbase_session_id || '',
    browserbase_recording_url: candidate.browserbase_recording_url || '',
    status: 'NEW'
  };
}

async function postToHydra(payload) {
  if (!process.env.HYDRA_WEBHOOK_URL) throw new Error('Missing HYDRA_WEBHOOK_URL.');
  const res = await fetch(process.env.HYDRA_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    response: text.slice(0, 500),
    posted_at: new Date().toISOString()
  };
}

function previewCandidate(candidate) {
  return {
    source_name: candidate.source_name,
    source_url: candidate.source_url,
    extractor: candidate.extractor,
    text_preview: String(candidate.text || '').slice(0, 350),
    browserbase_session_id: candidate.browserbase_session_id || '',
    browserbase_recording_url: candidate.browserbase_recording_url || ''
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}
