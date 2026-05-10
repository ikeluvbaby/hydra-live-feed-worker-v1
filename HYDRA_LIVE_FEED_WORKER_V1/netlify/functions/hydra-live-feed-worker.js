'use strict';

/**
 * HYDRA LIVE FEED WORKER V1 — NETLIFY SELF-TEST SAFE BUILD
 * ---------------------------------------------------------
 * Netlify-compatible CommonJS function.
 * Adds diagnostic endpoints so the operator does not need to manually guess what failed.
 *
 * URLs:
 *   /.netlify/functions/hydra-live-feed-worker?selftest=1
 *   /.netlify/functions/hydra-live-feed-worker?mock=1
 *   /.netlify/functions/hydra-live-feed-worker?posttest=1
 *   /.netlify/functions/hydra-live-feed-worker
 */

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

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

    const result = await runLiveFeed(startedAt);
    return json(200, result);
  } catch (err) {
    return json(200, {
      status: 'ERROR',
      message: err.message || String(err),
      stack: String(err.stack || '').split('\n').slice(0, 5),
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
    check('BROWSERBASE_API_KEY', !!process.env.BROWSERBASE_API_KEY, 'Optional. Only needed for browser extraction targets.'),
    check('BROWSERBASE_PROJECT_ID', !!process.env.BROWSERBASE_PROJECT_ID, 'Optional. Only needed for browser extraction targets.')
  ];

  const requiredPassed = checks
    .filter(c => !c.optional)
    .every(c => c.pass);

  return {
    status: requiredPassed ? 'PASS' : 'FAIL',
    selftest: true,
    version: 'HYDRA_LIVE_FEED_WORKER_V1_NETLIFY_SELFTEST_SAFE_BUILD',
    checks,
    next_urls: {
      mock_ai_only: '/.netlify/functions/hydra-live-feed-worker?mock=1',
      post_test_to_hydra: '/.netlify/functions/hydra-live-feed-worker?posttest=1',
      live_run: '/.netlify/functions/hydra-live-feed-worker'
    },
    finished_at: new Date().toISOString()
  };
}

function check(name, pass, note) {
  const optionalNames = ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'];
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
      started_at: startedAt,
      targets: parsed.targets.length,
      extracted_candidates: 0,
      accepted_signals: 0,
      rejected_candidates: 0,
      posted: [],
      errors: []
    }
  };

  for (const target of parsed.targets) {
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
      result.result.errors.push({ target: target.name || target.url || 'unknown', message: err.message || String(err) });
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

  // Direct fetch first. This avoids burning Browserbase minutes for simple public pages.
  if (target.url) {
    const text = await fetchPlainText(target.url);
    const cleaned = cleanText(text).slice(0, 6000);
    if (!cleaned || cleaned.length < 80) return [];
    return [{
      name: target.name || target.url,
      source_type: sourceType,
      source_name: target.name || target.url,
      source_url: target.url,
      vertical_hint: target.vertical_hint || target.vertical || 'General',
      text: cleaned
    }];
  }

  return [];
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
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function classifyCandidate(candidate) {
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY.');

  const prompt = `You are Hydra's leverage-intelligence classifier. Analyze the raw public signal for buyer/seller leverage. Return strict JSON only with keys: status, vertical, primary_friction, leverage_density, conversion_probability, summary, route_type, reason. Accept only real leverage: urgency, bad credit/access gap, trust friction, coordination failure, fulfillment bottleneck, liquidity pressure, pricing asymmetry.\n\nVertical hint: ${candidate.vertical_hint}\nSource: ${candidate.source_name}\nText:\n${candidate.text}`;

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: 'Return strict JSON only. No markdown.' },
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
  return status === 'ACCEPT' || route.includes('HOT') || (leverage >= 60 && conversion >= 45);
}

function buildHydraPayload(candidate, classified) {
  return {
    source_module: 'HYDRA_LIVE_FEED_WORKER_V1',
    source_type: candidate.source_type || 'url',
    source_channel: candidate.source_type || 'url',
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
    route_type: classified.route_type || 'ARCHIVE_OR_MONITOR',
    ai_summary: classified.summary || '',
    ai_reason: classified.reason || '',
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
