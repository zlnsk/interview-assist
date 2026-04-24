require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { expressAuth } = require('shared-auth');

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);

const PORT = process.env.PORT || 3014;
const BASE_PATH = '/Interview';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';

const { verifySession } = require('shared-auth');
const cookie = require('cookie');

const SESSION_SECRET = process.env.OTP_SESSION_SECRET || '';
const wss = new WebSocketServer({ noServer: true });

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// OTP Authentication (shared-auth, same as other apps)
app.use(expressAuth({ basePath: BASE_PATH, appName: 'Interview' }));

app.use(BASE_PATH, express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function userKey(user) {
  return (user || 'anonymous').toLowerCase().replace(/[^a-z0-9._@-]/g, '_');
}

// Atomic write: write to tmp then rename so readers never see a half-written
// file. Crash-safe and concurrent-writer-safe on the same filesystem.
function atomicWriteSync(filePath, content) {
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function setSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Disable buffering in nginx / similar proxies so tokens stream live.
  res.setHeader('X-Accel-Buffering', 'no');
}

// =============================================================================
// PER-USER RATE LIMITER (sliding window, in-memory)
// =============================================================================
// Protects expensive LLM endpoints from spam by an authenticated user. Each
// endpoint has its own bucket and request budget per minute.
const RATE_LIMITS = {
  answer: { max: 30, windowMs: 60_000 },   // 30 LLM answers / min
  prep: { max: 5, windowMs: 60_000 },      // 5 prep briefs / min
  recap: { max: 5, windowMs: 60_000 },     // 5 recaps / min
  classify: { max: 120, windowMs: 60_000 },// 120 cheap classifies / min
  search: { max: 30, windowMs: 60_000 },   // 30 web searches / min
};
const rateBuckets = new Map(); // `${endpoint}:${user}` -> [timestamps]

function checkRateLimit(endpoint, user) {
  const cfg = RATE_LIMITS[endpoint];
  if (!cfg) return { ok: true };
  const key = `${endpoint}:${userKey(user)}`;
  const now = Date.now();
  const cutoff = now - cfg.windowMs;
  const arr = (rateBuckets.get(key) || []).filter(t => t > cutoff);
  if (arr.length >= cfg.max) {
    const retryMs = arr[0] + cfg.windowMs - now;
    return { ok: false, retryAfter: Math.ceil(retryMs / 1000), limit: cfg.max, windowMs: cfg.windowMs };
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  // Light cleanup: every 200 inserts, prune expired buckets
  if (rateBuckets.size > 200 && Math.random() < 0.05) {
    for (const [k, ts] of rateBuckets) {
      const fresh = ts.filter(t => t > cutoff);
      if (fresh.length === 0) rateBuckets.delete(k);
      else rateBuckets.set(k, fresh);
    }
  }
  return { ok: true, remaining: cfg.max - arr.length };
}

function rateLimitMiddleware(endpoint) {
  return (req, res, next) => {
    const r = checkRateLimit(endpoint, req.authUser);
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfter));
      res.setHeader('X-RateLimit-Limit', String(r.limit));
      res.setHeader('X-RateLimit-Remaining', '0');
      return res.status(429).json({
        error: 'Too many requests',
        retryAfterSeconds: r.retryAfter,
        limit: r.limit,
        windowMs: r.windowMs,
      });
    }
    if (typeof r.remaining === 'number') {
      res.setHeader('X-RateLimit-Remaining', String(r.remaining));
    }
    next();
  };
}

// =============================================================================
// PRICING & USAGE TRACKING (Phase 1)
// =============================================================================
// Per-1M token prices (USD). Anthropic via OpenRouter passes through cache reads.
const PRICING = {
  'anthropic/claude-sonnet-4-6': { in: 3, cacheWrite: 3.75, cacheRead: 0.30, out: 15 },
  'anthropic/claude-opus-4-6':   { in: 15, cacheWrite: 18.75, cacheRead: 1.50, out: 75 },
  'anthropic/claude-haiku-4.5':  { in: 1, cacheWrite: 1.25, cacheRead: 0.10, out: 5 },
};

function priceFor(model) {
  return PRICING[model] || { in: 0, cacheWrite: 0, cacheRead: 0, out: 0 };
}

function calcCost(model, usage) {
  const p = priceFor(model);
  const inT = usage.prompt_tokens || 0;
  const outT = usage.completion_tokens || 0;
  // OpenRouter normalises Anthropic cache fields into prompt_tokens_details
  const det = usage.prompt_tokens_details || {};
  const cacheWriteT = det.cache_creation_input_tokens || usage.cache_creation_input_tokens || 0;
  const cacheReadT = det.cached_tokens || usage.cache_read_input_tokens || 0;
  const uncachedIn = Math.max(0, inT - cacheWriteT - cacheReadT);
  return (uncachedIn * p.in + cacheWriteT * p.cacheWrite + cacheReadT * p.cacheRead + outT * p.out) / 1e6;
}

const USAGE_FILE = path.join(DATA_DIR, 'usage.jsonl');

function logUsage(user, entry) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    user: userKey(user),
    ...entry,
  }) + '\n';
  // Async so we never block the request path on disk I/O.
  fs.appendFile(USAGE_FILE, line, (e) => {
    if (e) console.error('[usage] log error:', e.message);
  });
}

function readUsageStats(user, days = 7) {
  const empty = { total: { cost: 0, in: 0, cacheRead: 0, cacheWrite: 0, out: 0, requests: 0, avgLatencyMs: 0, avgTtftMs: 0 }, byDay: [], byModel: {}, byMode: {} };
  if (!fs.existsSync(USAGE_FILE)) return empty;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const userK = userKey(user);
  const lines = fs.readFileSync(USAGE_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const total = { cost: 0, in: 0, cacheRead: 0, cacheWrite: 0, out: 0, requests: 0, latencyMs: 0, ttftMs: 0 };
  const byDay = new Map();
  const byModel = {};
  const byMode = {};
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (new Date(e.ts).getTime() < cutoff) continue;
    if (user && e.user !== userK) continue;
    total.cost += e.cost || 0;
    total.in += e.in || 0;
    total.cacheRead += e.cacheRead || 0;
    total.cacheWrite += e.cacheWrite || 0;
    total.out += e.out || 0;
    total.latencyMs += e.latencyMs || 0;
    total.ttftMs += e.ttftMs || 0;
    total.requests++;
    const day = e.ts.slice(0, 10);
    const d = byDay.get(day) || { day, cost: 0, requests: 0, in: 0, cacheRead: 0, cacheWrite: 0, out: 0 };
    d.cost += e.cost || 0; d.requests++;
    d.in += e.in || 0; d.cacheRead += e.cacheRead || 0; d.cacheWrite += e.cacheWrite || 0; d.out += e.out || 0;
    byDay.set(day, d);
    const m = byModel[e.model] || { cost: 0, requests: 0 };
    m.cost += e.cost || 0; m.requests++;
    byModel[e.model] = m;
    if (e.mode) {
      const mm = byMode[e.mode] || { cost: 0, requests: 0 };
      mm.cost += e.cost || 0; mm.requests++;
      byMode[e.mode] = mm;
    }
  }
  total.avgLatencyMs = total.requests > 0 ? Math.round(total.latencyMs / total.requests) : 0;
  total.avgTtftMs = total.requests > 0 ? Math.round(total.ttftMs / total.requests) : 0;
  delete total.latencyMs; delete total.ttftMs;
  return { total, byDay: [...byDay.values()].sort((a,b) => a.day.localeCompare(b.day)), byModel, byMode };
}

// =============================================================================
// MODE PROMPTS & REFINEMENT (Phase 2)
// =============================================================================
const BASE_RULES = `Rules:
- First person, as if the user is speaking
- Go straight to the point, no filler or preamble
- Draw from uploaded knowledge for concrete examples when relevant
- Never say "I don't know" — always give a strong answer
- The candidate is a senior engineer. Do NOT define well-known tech (Azure, AWS, GCP, CDN, REST, SQL, Kubernetes, Docker, React, ITIL, Scrum, OAuth, JWT, CI/CD, SLA, SLO, etc.) — assume fluency. Only gloss genuinely obscure, proprietary, or niche terms (e.g. internal product names, exotic libraries, rare protocols), and only if glossing adds signal. When in doubt, don't explain — sounding over-explained is worse than assuming knowledge.

Format:
- **Bold** key terms only
- Bullet points for lists (max 3-4 bullets)
- ### headers only when explicitly required by the format
- No walls of text — every word must earn its place`;

const MODE_PROMPTS = {
  answer: `You are a live interview assistant. Be concise — the user reads this during the interview.

${BASE_RULES}

CRITICAL: The user is the CANDIDATE being interviewed. They answer the interviewer; they do NOT ask follow-up questions back during the interview. NEVER suggest follow-up questions, clarifying questions, or any "questions to ask back". NEVER append a "Follow-up Questions You Can Ask" section, "Questions to ask the interviewer" section, or any similar trailing list. Output ONLY the direct answer the candidate should SAY.

If the interviewer's question is ambiguous and has two plausible interpretations, present BOTH answers as two clearly-labelled branches:
**Option A — <short label>:** ...answer...
**Option B — <short label>:** ...answer...
Keep each branch tight. The user will pick the one that fits.

Length: MAX 90 words per branch (180 total when ambiguous), 130 for behavioral questions.`,

  clarify: `You are a live interview assistant. The candidate wants to buy a few seconds to think AND narrow the question. Generate ONE short, natural clarifying question the candidate can ask the interviewer back — it should either confirm an assumption, narrow scope, or surface the key constraint.

Output ONLY the clarifying question, one sentence, first person, no preamble, no alternatives.`,

  followups: `You are a live interview assistant. The candidate just finished answering. Suggest 2-3 thoughtful follow-up questions the CANDIDATE could ask the INTERVIEWER back to show curiosity and seniority — tied to the specific topic of the interviewer's question.

Format: numbered list, one line each, no preamble, no trailing commentary. Avoid generic Glassdoor-style questions.`,

  star: `You are a live interview assistant for a behavioural interview. Answer using the STAR framework, drawing concrete details and numbers from the uploaded CV.

${BASE_RULES}

Format EXACTLY:
**Situation:** 1-2 lines of context.
**Task:** 1 line on what you were asked to do.
**Action:** 3-5 short bullets of what *you* did, with specifics.
**Result:** 1-2 lines with quantified outcomes.

First person throughout. Total under 200 words.`,

  code: `You are a live interview assistant for a live coding interview. Output EXACTLY these four labelled blocks, in order, nothing else:

**[SAY THIS FIRST]** 1-2 sentences restating the problem and the approach you're going to take, with the reason (e.g. "hash map for O(n) lookup").

**[THE CODE]** Complete, correct, runnable solution inside a fenced code block. Pick the language from context, default to Python. Short, idiomatic; no redundant comments.

**[SAY THIS AFTER]** 2-3 bullets walking through one concrete example input → output so the interviewer sees you traced through it.

**[COMPLEXITY]** One line: Time O(...), Space O(...), with one short justification.

${BASE_RULES}`,

  bridge: `You are a live interview assistant. The candidate has gone silent and needs ONE short, natural stalling sentence they can say right now to buy 10-15 seconds of thinking time — tied to the specific question.

Output ONE sentence only. First person. No preamble, no alternatives. Must sound human, not scripted.`,
};

const REFINEMENT_INSTRUCTIONS = {
  shorter: 'Make the previous answer 50% shorter while keeping the key points. Same format, same first-person voice.',
  longer: 'Expand the previous answer with more concrete details and one specific example. Stay under 200 words.',
  more_confident: 'Rewrite the previous answer with more confident, assertive language. Remove hedging like "might", "perhaps", "I think". Use stronger verbs.',
  more_casual: "Rewrite the previous answer in a casual, conversational tone — like you're talking to a colleague over coffee.",
  rephrase: 'Rephrase the previous answer entirely, keeping the same content but using different words and structure.',
  example: 'Add one specific concrete example to the previous answer. Use real numbers, technologies, and outcomes.',
  simpler: 'Simplify the previous answer for a non-technical interviewer. Remove jargon, use analogies.',
  redo: "Generate a completely different answer to the same question. Use a different angle, structure, and examples than the previous answer. Do not reuse its phrasing or framing — this should feel like a fresh answer from scratch, not a rewrite.",
};

// Detect refinement intent from a short user utterance (regex first, cheap)
function detectRefinement(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  if (/(make|say|do).*(short|brief|concise)/.test(t) || /shorter/.test(t)) return 'shorter';
  if (/(longer|more detail|expand|elaborate)/.test(t)) return 'longer';
  if (/(more confident|less hedging|stronger|assertive)/.test(t)) return 'more_confident';
  if (/(casual|informal|conversational)/.test(t)) return 'more_casual';
  if (/(redo|try again|different answer|something else|another answer)/.test(t)) return 'redo';
  if (/(rephrase|reword|different way|other way)/.test(t)) return 'rephrase';
  if (/(example|concrete|specific)/.test(t)) return 'example';
  if (/(simpler|simpl|non.?technical|jargon)/.test(t)) return 'simpler';
  return null;
}

// =============================================================================
// PERSONAS (Phase 3)
// =============================================================================
const PERSONAS_FILE = path.join(DATA_DIR, 'personas.json');

function loadPersonas() {
  if (!fs.existsSync(PERSONAS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PERSONAS_FILE, 'utf8')); }
  catch { return {}; }
}

function savePersonas(personas) {
  atomicWriteSync(PERSONAS_FILE, JSON.stringify(personas, null, 2));
}

function userPersonas(user) {
  const all = loadPersonas();
  return all[userKey(user)] || [];
}

function setUserPersonas(user, list) {
  const all = loadPersonas();
  all[userKey(user)] = list;
  savePersonas(all);
}

// =============================================================================
// JOBS — per-interview bundle (JD + application + resume doc + custom prompt)
// =============================================================================
// A Job is the primary unit for a specific interview with a specific company.
// When a job is "active", every /api/answer call pulls its bundle into the
// system prompt automatically so the candidate doesn't juggle doc toggles
// mid-interview. Docs still live in the shared doc store (resumes are reused
// across many jobs); JD + application text are inlined on the job record.
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

function loadJobsFile() {
  if (!fs.existsSync(JOBS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveJobsFile(all) { atomicWriteSync(JOBS_FILE, JSON.stringify(all, null, 2)); }
function userJobsBlob(user) {
  const all = loadJobsFile();
  const k = userKey(user);
  return all[k] || { jobs: [], activeJobId: null };
}
function setUserJobsBlob(user, blob) {
  const all = loadJobsFile();
  all[userKey(user)] = blob;
  saveJobsFile(all);
}
function findUserJob(user, jobId) {
  if (!jobId) return null;
  return userJobsBlob(user).jobs.find(j => j.id === jobId) || null;
}

app.get(`${BASE_PATH}/api/jobs`, (req, res) => {
  res.json(userJobsBlob(req.authUser));
});

app.post(`${BASE_PATH}/api/jobs`, (req, res) => {
  const {
    position = '', organisation = '', seniority = '', competencies = [],
    jdText = '', applicationText = '', resumeDocId = null, customPrompt = '',
  } = req.body || {};
  if (!position && !organisation && !jdText) {
    return res.status(400).json({ error: 'Need at least a position/organisation or JD text.' });
  }
  const blob = userJobsBlob(req.authUser);
  const id = 'j_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = {
    id,
    position: String(position).slice(0, 160),
    organisation: String(organisation).slice(0, 160),
    seniority: String(seniority).slice(0, 80),
    competencies: (Array.isArray(competencies) ? competencies : []).slice(0, 20).map(String),
    jdText: String(jdText).slice(0, 50_000),
    applicationText: String(applicationText).slice(0, 50_000),
    resumeDocId: resumeDocId ? String(resumeDocId) : null,
    customPrompt: String(customPrompt).slice(0, 4000),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  blob.jobs.unshift(job);
  blob.activeJobId = id; // a just-created job becomes active by default
  setUserJobsBlob(req.authUser, blob);
  res.json(job);
});

// IMPORTANT: /api/jobs/active must be declared BEFORE /api/jobs/:id so the
// generic :id handler doesn't swallow 'active' as a jobId.
app.put(`${BASE_PATH}/api/jobs/active`, (req, res) => {
  const { jobId = null } = req.body || {};
  const blob = userJobsBlob(req.authUser);
  if (jobId && !blob.jobs.find(j => j.id === jobId)) {
    return res.status(404).json({ error: 'Not found' });
  }
  blob.activeJobId = jobId;
  setUserJobsBlob(req.authUser, blob);
  res.json({ ok: true, activeJobId: jobId });
});

app.put(`${BASE_PATH}/api/jobs/:id`, (req, res) => {
  const blob = userJobsBlob(req.authUser);
  const idx = blob.jobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const cur = blob.jobs[idx];
  const body = req.body || {};
  const next = {
    ...cur,
    position: body.position !== undefined ? String(body.position).slice(0, 160) : cur.position,
    organisation: body.organisation !== undefined ? String(body.organisation).slice(0, 160) : cur.organisation,
    seniority: body.seniority !== undefined ? String(body.seniority).slice(0, 80) : cur.seniority,
    competencies: Array.isArray(body.competencies) ? body.competencies.slice(0, 20).map(String) : cur.competencies,
    jdText: body.jdText !== undefined ? String(body.jdText).slice(0, 50_000) : cur.jdText,
    applicationText: body.applicationText !== undefined ? String(body.applicationText).slice(0, 50_000) : cur.applicationText,
    resumeDocId: body.resumeDocId !== undefined ? (body.resumeDocId ? String(body.resumeDocId) : null) : cur.resumeDocId,
    customPrompt: body.customPrompt !== undefined ? String(body.customPrompt).slice(0, 4000) : cur.customPrompt,
    updatedAt: new Date().toISOString(),
  };
  blob.jobs[idx] = next;
  setUserJobsBlob(req.authUser, blob);
  res.json(next);
});

app.delete(`${BASE_PATH}/api/jobs/:id`, (req, res) => {
  const blob = userJobsBlob(req.authUser);
  blob.jobs = blob.jobs.filter(j => j.id !== req.params.id);
  if (blob.activeJobId === req.params.id) blob.activeJobId = null;
  setUserJobsBlob(req.authUser, blob);
  res.json({ ok: true });
});

// Extract {position, organisation, seniority, competencies} from a pasted JD
// via Haiku. Small call (~$0.001). The UI shows the result for user confirm
// before persisting a job record.
app.post(`${BASE_PATH}/api/jobs/extract`, rateLimitMiddleware('classify'), async (req, res) => {
  const { jdText } = req.body || {};
  if (!jdText || jdText.length < 40) return res.status(400).json({ error: 'JD text too short' });
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'No API key' });
  try {
    const { full, usage } = await callLLM({
      systemContent: [{
        type: 'text',
        text: 'Extract interview-relevant metadata from the job description. Return ONLY a JSON object with keys: {"position": string, "organisation": string, "seniority": string ("junior|mid|senior|staff|principal|director|vp|c-level|unknown"), "competencies": string[] (3-8 short phrases, the skills/areas this role will probe)}. No prose, no code fences.',
      }],
      messages: [{ role: 'user', content: `JOB DESCRIPTION:\n${jdText.slice(0, 16_000)}\n\nReturn JSON:` }],
      model: 'anthropic/claude-haiku-4.5',
      max_tokens: 400,
      temperature: 0,
    });
    if (usage) {
      logUsage(req.authUser, {
        model: 'anthropic/claude-haiku-4.5', mode: 'extract',
        in: usage.prompt_tokens || 0,
        cacheRead: usage.prompt_tokens_details?.cached_tokens || 0,
        cacheWrite: 0,
        out: usage.completion_tokens || 0,
        cost: calcCost('anthropic/claude-haiku-4.5', usage),
        ttftMs: 0, latencyMs: 0,
      });
    }
    const m = full.match(/\{[\s\S]*\}/);
    if (!m) return res.status(500).json({ error: 'extract parse failed', raw: full.slice(0, 200) });
    const parsed = JSON.parse(m[0]);
    res.json({
      position: String(parsed.position || ''),
      organisation: String(parsed.organisation || ''),
      seniority: String(parsed.seniority || ''),
      competencies: Array.isArray(parsed.competencies) ? parsed.competencies.slice(0, 8).map(String) : [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// SPEAKER PREFERENCES (Phase 3)
// =============================================================================
const SPEAKER_PREFS_FILE = path.join(DATA_DIR, 'speaker-prefs.json');

function loadSpeakerPrefs() {
  if (!fs.existsSync(SPEAKER_PREFS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SPEAKER_PREFS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveSpeakerPrefs(prefs) {
  atomicWriteSync(SPEAKER_PREFS_FILE, JSON.stringify(prefs, null, 2));
}

// =============================================================================
// DOCUMENTS WITH CHUNKING & RETRIEVAL (Phase 3 — light RAG, in-memory)
// =============================================================================
const documents = new Map();

// Naive paragraph chunker — good enough for resume/JD-sized docs.
function chunkText(text, targetChars = 1200) {
  if (!text) return [];
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paragraphs) {
    if ((buf + '\n\n' + p).length > targetChars && buf) {
      chunks.push(buf);
      buf = p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// TF-style scoring: count question keyword occurrences in each chunk.
function scoreChunks(chunks, query) {
  const stop = new Set(['the','a','an','and','or','of','to','in','for','on','with','is','are','was','were','i','you','he','she','it','we','they','at','by','as','that','this','my','your','our','do','does','did','have','has','had','be','been','being','from','what','how','why','when','where','who','can','could','would','should','will','tell','me','about','your','give','example']);
  const tokens = query.toLowerCase().match(/[a-z][a-z0-9+#-]{2,}/g) || [];
  const keywords = tokens.filter(t => !stop.has(t));
  if (keywords.length === 0) return chunks.map(c => ({ text: c, score: 0 }));
  return chunks.map(c => {
    const lower = c.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      const re = new RegExp('\\b' + kw.replace(/[+#-]/g, '\\$&') + '\\b', 'g');
      const matches = lower.match(re);
      if (matches) score += matches.length;
    }
    return { text: c, score };
  });
}

function retrieveTopChunks(query, docList, topK = 6) {
  const all = [];
  for (const d of docList) {
    const chunks = d.chunks || chunkText(d.text);
    for (const text of chunks) all.push({ text, doc: d.name, type: d.type });
  }
  const scored = scoreChunks(all.map(x => x.text), query);
  const indexed = scored.map((s, i) => ({ ...s, doc: all[i].doc, type: all[i].type }));
  indexed.sort((a, b) => b.score - a.score);
  const picked = indexed.filter(x => x.score > 0).slice(0, topK);
  return picked.length > 0 ? picked : indexed.slice(0, Math.min(2, topK));
}

function loadExistingDocs() {
  const metaPath = path.join(UPLOADS_DIR, 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      for (const doc of meta) {
        if (!doc.chunks) doc.chunks = chunkText(doc.text);
        documents.set(doc.id, doc);
      }
      console.log(`Loaded ${documents.size} documents from disk`);
    } catch (e) {
      console.error('Failed to load doc metadata:', e);
    }
  }
}
loadExistingDocs();

function saveMeta() {
  const metaPath = path.join(UPLOADS_DIR, 'meta.json');
  atomicWriteSync(metaPath, JSON.stringify([...documents.values()], null, 2));
}

// Docs visible to a user: strictly their own. Legacy docs (pre-scoping) have
// no `user` field and are treated as shared — they remain visible but are not
// deletable via the API until re-uploaded.
function userVisibleDocs(user) {
  const key = userKey(user);
  return [...documents.values()].filter(d => !d.user || d.user === key);
}
function userOwnsDoc(user, doc) {
  return !!doc && doc.user === userKey(user);
}

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.txt', '.md'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

app.post(`${BASE_PATH}/api/upload`, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  let text = '';
  try {
    if (ext === '.pdf') {
      const buf = fs.readFileSync(req.file.path);
      const data = await pdfParse(buf);
      text = data.text;
    } else {
      text = fs.readFileSync(req.file.path, 'utf8');
    }
  } catch (e) {
    return res.status(500).json({ error: 'Failed to parse file' });
  }
  const doc = {
    id: req.file.filename,
    user: userKey(req.authUser),
    name: req.file.originalname,
    type: req.body.type || 'other',
    text: text,
    chunks: chunkText(text),
    chars: text.length,
    uploadedAt: new Date().toISOString()
  };
  documents.set(doc.id, doc);
  saveMeta();
  res.json({ id: doc.id, name: doc.name, type: doc.type, chars: doc.chars, chunks: doc.chunks.length });
});

app.get(`${BASE_PATH}/api/documents`, (req, res) => {
  const docs = userVisibleDocs(req.authUser).map(d => ({
    id: d.id, name: d.name, type: d.type, uploadedAt: d.uploadedAt,
    chars: d.chars || (d.text || '').length,
    chunks: d.chunks ? d.chunks.length : 0,
  }));
  res.json(docs);
});

app.delete(`${BASE_PATH}/api/documents/:id`, (req, res) => {
  const doc = documents.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (!userOwnsDoc(req.authUser, doc)) return res.status(403).json({ error: 'Forbidden' });
  const filePath = path.join(UPLOADS_DIR, doc.id);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  documents.delete(doc.id);
  saveMeta();
  res.json({ ok: true });
});

// =============================================================================
// SESSIONS (per-user question log; existing, extended)
// =============================================================================
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
const SESSION_GAP_MS = 30 * 60 * 1000;
const activeSessions = new Map(); // user -> { id, lastQuestionAt, file }

// Evict stale entries so the Map can't grow unbounded with unique users.
// A stale entry will be recreated on the next event anyway.
setInterval(() => {
  const cutoff = Date.now() - 2 * SESSION_GAP_MS;
  for (const [k, s] of activeSessions) {
    if (s.lastQuestionAt < cutoff) activeSessions.delete(k);
  }
}, SESSION_GAP_MS).unref();

function getOrCreateSession(user) {
  const key = userKey(user);
  const now = Date.now();
  let s = activeSessions.get(key);
  if (s && (now - s.lastQuestionAt) < SESSION_GAP_MS) {
    s.lastQuestionAt = now;
    return s;
  }
  const id = new Date(now).toISOString().replace(/[:.]/g, '-');
  const userDir = path.join(SESSIONS_DIR, key);
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
  const file = path.join(userDir, `${id}.jsonl`);
  s = { id, file, lastQuestionAt: now, startedAt: now, count: 0 };
  activeSessions.set(key, s);
  fs.appendFileSync(file, JSON.stringify({
    type: 'session_start',
    sessionId: id,
    user: user || 'anonymous',
    startedAt: new Date(now).toISOString(),
  }) + '\n');
  console.log(`[interview-sessions] new session ${id} for ${key}`);
  return s;
}

function logSessionEvent(user, evt) {
  try {
    const s = getOrCreateSession(user);
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...evt,
    }) + '\n';
    fs.appendFile(s.file, line, (err) => {
      if (err) console.error('[interview-sessions] log error:', err.message);
    });
    if (evt.type === 'question') s.count++;
  } catch (err) {
    console.error('[interview-sessions] log error:', err.message);
  }
}

function logQuestion(user, question) {
  if (!question) return;
  logSessionEvent(user, { type: 'question', question: question.toString().slice(0, 4000) });
}

function logAnswer(user, question, answer, mode) {
  if (!answer) return;
  logSessionEvent(user, {
    type: 'answer',
    mode,
    question: (question || '').toString().slice(0, 4000),
    answer: answer.toString().slice(0, 8000),
  });
}

function listUserSessions(user) {
  const key = userKey(user);
  const userDir = path.join(SESSIONS_DIR, key);
  if (!fs.existsSync(userDir)) return [];
  return fs.readdirSync(userDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const filePath = path.join(userDir, f);
      const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
      const header = JSON.parse(lines[0] || '{}');
      const events = lines.slice(1).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const questions = events.filter(e => e.type === 'question');
      // Job binding wins over manual label; fall back to latest label.
      const jobEvents = events.filter(e => e.type === 'session_job');
      const jobEvt = jobEvents[jobEvents.length - 1] || null;
      const labels = events.filter(e => e.type === 'session_label');
      const label = labels[labels.length - 1] || {};
      return {
        sessionId: header.sessionId || f.replace('.jsonl', ''),
        startedAt: header.startedAt,
        questionCount: questions.length,
        firstQuestionAt: questions[0]?.timestamp || null,
        lastQuestionAt: questions[questions.length - 1]?.timestamp || null,
        position: jobEvt?.position || label.position || '',
        organisation: jobEvt?.organisation || label.organisation || '',
        jobId: jobEvt?.jobId || null,
      };
    })
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}

// Append a session_label to a specific past session file. Used by the PUT
// endpoint for retroactive labelling. Returns true if the file was updated.
function labelPastSession(user, sessionId, position, organisation) {
  const key = userKey(user);
  if (!/^[\w-]{1,64}$/.test(sessionId)) return false;
  const filePath = path.join(SESSIONS_DIR, key, sessionId + '.jsonl');
  if (!fs.existsSync(filePath)) return false;
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'session_label',
    position: String(position || '').slice(0, 160),
    organisation: String(organisation || '').slice(0, 160),
  }) + '\n';
  fs.appendFileSync(filePath, line);
  return true;
}

function readSession(user, sessionId) {
  const key = userKey(user);
  if (!/^[\w-]{1,64}$/.test(sessionId)) return null;
  const filePath = path.join(SESSIONS_DIR, key, sessionId + '.jsonl');
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
}

app.get(`${BASE_PATH}/api/sessions`, (req, res) => {
  res.json({ sessions: listUserSessions(req.authUser) });
});

app.get(`${BASE_PATH}/api/sessions/:id`, (req, res) => {
  const data = readSession(req.authUser, req.params.id);
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json({ sessionId: req.params.id, entries: data });
});

// Label the *current* (live) session — creates one if none exists yet, so the
// user can set position/org before any question fires. Stores the label as an
// event so mid-session re-labelling is preserved.
app.post(`${BASE_PATH}/api/sessions/label`, (req, res) => {
  const { position = '', organisation = '' } = req.body || {};
  logSessionEvent(req.authUser, {
    type: 'session_label',
    position: String(position).slice(0, 160),
    organisation: String(organisation).slice(0, 160),
  });
  const s = activeSessions.get(userKey(req.authUser));
  res.json({ ok: true, sessionId: s?.id || null });
});

// Label a past session retroactively.
app.put(`${BASE_PATH}/api/sessions/:id/label`, (req, res) => {
  const { position = '', organisation = '' } = req.body || {};
  const ok = labelPastSession(req.authUser, req.params.id, position, organisation);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// =============================================================================
// USAGE / DASHBOARD ENDPOINTS (Phase 1)
// =============================================================================
app.get(`${BASE_PATH}/api/usage`, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 90);
  res.json(readUsageStats(req.authUser, days));
});

// =============================================================================
// PERSONAS ENDPOINTS (Phase 3)
// =============================================================================
app.get(`${BASE_PATH}/api/personas`, (req, res) => {
  res.json({ personas: userPersonas(req.authUser) });
});

app.post(`${BASE_PATH}/api/personas`, (req, res) => {
  const { id, name, prompt, model, defaultMode } = req.body || {};
  if (!name || !prompt) return res.status(400).json({ error: 'name and prompt required' });
  const list = userPersonas(req.authUser);
  const pid = id || ('p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const existingIdx = list.findIndex(p => p.id === pid);
  const entry = { id: pid, name: String(name).slice(0, 80), prompt: String(prompt).slice(0, 4000), model: model || 'sonnet', defaultMode: defaultMode || 'answer', updatedAt: new Date().toISOString() };
  if (existingIdx >= 0) list[existingIdx] = entry; else list.push(entry);
  setUserPersonas(req.authUser, list);
  res.json(entry);
});

app.delete(`${BASE_PATH}/api/personas/:id`, (req, res) => {
  const list = userPersonas(req.authUser);
  const next = list.filter(p => p.id !== req.params.id);
  setUserPersonas(req.authUser, next);
  res.json({ ok: true });
});

// =============================================================================
// SPEAKER PREFS ENDPOINTS (Phase 3)
// =============================================================================
app.get(`${BASE_PATH}/api/speaker-prefs`, (req, res) => {
  const all = loadSpeakerPrefs();
  res.json(all[userKey(req.authUser)] || { strategy: 'manual' });
});

app.put(`${BASE_PATH}/api/speaker-prefs`, (req, res) => {
  const all = loadSpeakerPrefs();
  all[userKey(req.authUser)] = {
    strategy: req.body?.strategy || 'manual', // 'manual' | 'second_speaker' | 'longest_speaker'
    updatedAt: new Date().toISOString(),
  };
  saveSpeakerPrefs(all);
  res.json(all[userKey(req.authUser)]);
});

// =============================================================================
// LLM HELPER (Phase 1+2 — caching, modes, refinement, usage)
// =============================================================================
async function callLLM({ systemContent, messages, model, max_tokens, temperature, signal, onToken, onUsage }) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL || '',
      'X-Title': 'Interview Assistant',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemContent }, ...messages],
      stream: true,
      max_tokens: max_tokens || 1024,
      temperature: temperature ?? 0.3,
      usage: { include: true },
      stream_options: { include_usage: true },
    }),
    signal,
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${errBody.slice(0, 300)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let usage = null;
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const evt = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = evt.split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            full += content;
            if (onToken) onToken(content);
          }
          if (parsed.usage) usage = parsed.usage;
        } catch {}
      }
    }
  }
  if (usage && onUsage) onUsage(usage);
  return { full, usage };
}

// Build cacheable system content array. The big stable knowledge block is
// marked with cache_control so Anthropic caches the prefix on subsequent calls.
function buildSystemContent(modePrompt, docs, refinementInstr) {
  const headerText = modePrompt + (refinementInstr ? `\n\nREFINEMENT REQUEST: ${refinementInstr}` : '');
  const content = [{ type: 'text', text: headerText }];
  if (docs && docs.length > 0) {
    const docsText = docs.map(d => `--- ${d.type.toUpperCase()}: ${d.name} ---\n${d.text || (d.chunks || []).join('\n\n')}`).join('\n\n');
    if (docsText.length >= 800) {
      content.push({
        type: 'text',
        text: `KNOWLEDGE BASE (use only if relevant):\n${docsText}`,
        cache_control: { type: 'ephemeral' },
      });
    } else if (docsText) {
      content.push({ type: 'text', text: `KNOWLEDGE BASE:\n${docsText}` });
    }
  }
  return content;
}

function modelId(model) {
  if (model === 'opus') return 'anthropic/claude-opus-4-6';
  if (model === 'haiku') return 'anthropic/claude-haiku-4.5';
  return 'anthropic/claude-sonnet-4-6';
}

// =============================================================================
// /api/answer — REVAMPED (Phase 1+2+3)
// =============================================================================
app.post(`${BASE_PATH}/api/answer`, rateLimitMiddleware('answer'), async (req, res) => {
  const { question, transcript, model, enabledDocIds, mode = 'answer', refinement, persona, useRag, jobId } = req.body;
  const t0 = Date.now();
  console.log(`[answer] q="${(question || '').slice(0, 60)}" model=${model} mode=${mode} ref=${refinement || '-'} job=${jobId || '-'}`);
  // If a jobId is supplied, stamp the current session with it so sessions
  // list + recap can resolve position/org/application automatically.
  const activeJob = jobId ? findUserJob(req.authUser, jobId) : null;
  if (!refinement) {
    if (activeJob) logSessionEvent(req.authUser, { type: 'session_job', jobId: activeJob.id, position: activeJob.position, organisation: activeJob.organisation });
    logQuestion(req.authUser, question);
  }
  if (!question) return res.status(400).json({ error: 'No question' });
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'No API key configured' });

  // Filter to the user's own docs (security: no cross-user data injection).
  let docs = userVisibleDocs(req.authUser);
  if (Array.isArray(enabledDocIds) && enabledDocIds.length > 0) {
    const allow = new Set(enabledDocIds);
    docs = docs.filter(d => allow.has(d.id));
  } else if (activeJob) {
    // Active-job flow: ignore the shared doc pool, use only the job's
    // bound resume (if any). JD + application come from the job record
    // itself (see below).
    docs = docs.filter(d => d.id === activeJob.resumeDocId);
  }
  // Stable order so the cacheable doc block stays byte-identical across
  // requests even when Map insertion order changes (prompt caching).
  docs.sort((a, b) => a.id.localeCompare(b.id));

  // RAG mode: only inject top-K chunks (cheaper for huge KBs)
  let ragChunks = null;
  if (useRag && docs.length > 0) {
    ragChunks = retrieveTopChunks(question, docs, 6);
  }

  // Resolve mode prompt; persona overrides if provided
  let modePromptText = MODE_PROMPTS[mode] || MODE_PROMPTS.answer;
  if (persona) {
    const pList = userPersonas(req.authUser);
    const p = pList.find(x => x.id === persona);
    if (p) modePromptText = p.prompt + '\n\n' + (MODE_PROMPTS[p.defaultMode || mode] || MODE_PROMPTS.answer);
  }
  // When a job is active, its custom prompt + metadata gets prepended so
  // every answer is grounded in THIS interview's context without manual
  // per-question doc toggling.
  if (activeJob) {
    const jobHeader = [
      `ACTIVE INTERVIEW: ${activeJob.position || 'unspecified role'} at ${activeJob.organisation || 'unspecified org'}${activeJob.seniority ? ` (${activeJob.seniority})` : ''}.`,
      activeJob.competencies?.length ? `Role will probe: ${activeJob.competencies.join(', ')}.` : '',
      activeJob.customPrompt ? `\nEXTRA COACHING FOR THIS INTERVIEW:\n${activeJob.customPrompt}` : '',
    ].filter(Boolean).join('\n');
    modePromptText = jobHeader + '\n\n' + modePromptText;
  }
  const refinementInstr = refinement ? (REFINEMENT_INSTRUCTIONS[refinement] || refinement) : null;

  // Synthetic docs for the active job: JD + application are inlined on the
  // job record, so surface them as if they were uploaded docs so the
  // existing caching / formatting in buildSystemContent picks them up.
  if (activeJob) {
    if (activeJob.jdText) docs.unshift({
      id: '_job_jd_' + activeJob.id, name: 'Job description', type: 'job_description',
      text: activeJob.jdText, chunks: chunkText(activeJob.jdText),
    });
    if (activeJob.applicationText) docs.unshift({
      id: '_job_app_' + activeJob.id, name: 'Your application', type: 'application',
      text: activeJob.applicationText, chunks: chunkText(activeJob.applicationText),
    });
  }

  // Build system content. RAG path bypasses the cached doc block.
  let systemContent;
  if (ragChunks) {
    const ragText = ragChunks.map(c => `[${c.type}/${c.doc}] ${c.text}`).join('\n\n');
    systemContent = [
      { type: 'text', text: modePromptText + (refinementInstr ? `\n\nREFINEMENT: ${refinementInstr}` : '') },
      { type: 'text', text: `RETRIEVED CONTEXT (top ${ragChunks.length} chunks for this question):\n${ragText}` },
    ];
  } else {
    systemContent = buildSystemContent(modePromptText, docs, refinementInstr);
  }

  const messages = [];
  if (transcript) messages.push({ role: 'user', content: `Recent interview transcript:\n${transcript}` });
  if (refinement) {
    messages.push({ role: 'user', content: `The interviewer just asked: "${question}"\n\nRefine the answer per the REFINEMENT instructions above. Output the refined answer only:` });
  } else {
    messages.push({ role: 'user', content: `The interviewer just asked: "${question}"\n\nProvide a strong answer I can use:` });
  }

  const selectedModel = modelId(model);
  setSseHeaders(res);

  const abortController = new AbortController();
  let streaming = true;
  res.on('close', () => { if (streaming) abortController.abort(); });

  let firstTokenAt = 0;
  let fullAnswer = '';

  try {
    const { usage } = await callLLM({
      systemContent,
      messages,
      model: selectedModel,
      max_tokens: mode === 'code' ? 2500 : (mode === 'star' ? 1500 : 1024),
      temperature: mode === 'code' ? 0.2 : 0.3,
      signal: abortController.signal,
      onToken: (t) => {
        if (!firstTokenAt) firstTokenAt = Date.now();
        fullAnswer += t;
        res.write(`data: ${JSON.stringify({ text: t })}\n\n`);
      },
    });
    res.write('data: [DONE]\n\n');
    if (usage) {
      const cost = calcCost(selectedModel, usage);
      const ttftMs = firstTokenAt ? firstTokenAt - t0 : 0;
      const totalMs = Date.now() - t0;
      logUsage(req.authUser, {
        model: selectedModel,
        mode,
        in: usage.prompt_tokens || 0,
        cacheRead: usage.prompt_tokens_details?.cached_tokens || 0,
        cacheWrite: usage.prompt_tokens_details?.cache_creation_input_tokens || 0,
        out: usage.completion_tokens || 0,
        cost,
        ttftMs,
        latencyMs: totalMs,
        ragUsed: !!ragChunks,
      });
      res.write(`data: ${JSON.stringify({ usage: { cost, ttftMs, totalMs, ...usage } })}\n\n`);
    }
    if (fullAnswer && !refinement) logAnswer(req.authUser, question, fullAnswer, mode);
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('[answer] error:', e.message);
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    }
  }
  streaming = false;
  res.end();
});

// =============================================================================
// /api/classify — Question detection gating (Phase 2)
// =============================================================================
// Cheap LLM classifier (Haiku) used by the frontend to decide whether a
// transcript line is actually a question worth auto-answering.
app.post(`${BASE_PATH}/api/classify`, rateLimitMiddleware('classify'), async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.json({ isQuestion: false, score: 0 });
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'No API key' });

  // Heuristic short-circuit: clearly a question or clearly not.
  const t = text.trim();
  if (t.length < 6) return res.json({ isQuestion: false, score: 0, source: 'heuristic' });
  if (t.endsWith('?')) return res.json({ isQuestion: true, score: 0.95, source: 'heuristic' });

  try {
    const { full, usage } = await callLLM({
      systemContent: [{
        type: 'text',
        text: 'You classify a single transcript line. Return ONLY a JSON object: {"isQuestion": true|false, "type": "behavioral|technical|coding|smalltalk|other", "score": 0-1}. A line is a question only if it asks the candidate to answer something substantive (not small talk or meta).',
      }],
      messages: [{ role: 'user', content: `Line: "${t}"\n\nReturn JSON:` }],
      model: 'anthropic/claude-haiku-4.5',
      max_tokens: 80,
      temperature: 0,
    });
    if (usage) {
      logUsage(req.authUser, {
        model: 'anthropic/claude-haiku-4.5',
        mode: 'classify',
        in: usage.prompt_tokens || 0,
        cacheRead: usage.prompt_tokens_details?.cached_tokens || 0,
        cacheWrite: 0,
        out: usage.completion_tokens || 0,
        cost: calcCost('anthropic/claude-haiku-4.5', usage),
        ttftMs: 0,
        latencyMs: 0,
      });
    }
    const m = full.match(/\{[\s\S]*\}/);
    if (!m) return res.json({ isQuestion: false, score: 0, source: 'classifier_parse_fail', raw: full.slice(0, 200) });
    const parsed = JSON.parse(m[0]);
    res.json({ ...parsed, source: 'classifier' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// /api/prep — Pre-interview prep (Phase 4)
// =============================================================================
app.post(`${BASE_PATH}/api/prep`, rateLimitMiddleware('prep'), async (req, res) => {
  const { enabledDocIds, model, jobDescription } = req.body || {};
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'No API key' });

  let docs = userVisibleDocs(req.authUser);
  if (Array.isArray(enabledDocIds) && enabledDocIds.length > 0) {
    const allow = new Set(enabledDocIds);
    docs = docs.filter(d => allow.has(d.id));
  }
  docs.sort((a, b) => a.id.localeCompare(b.id));
  // If a JD was pasted in the request, treat it as an extra inline doc
  if (jobDescription && jobDescription.length > 50) {
    docs.push({ id: 'inline_jd', name: 'Pasted Job Description', type: 'job_description', text: jobDescription, chunks: chunkText(jobDescription) });
  }

  const systemContent = buildSystemContent(
    `You are an interview prep coach. Given the user's CV and the target job description, produce a pre-interview prep brief.

Output sections in this order:

## 1. Likely questions (8 items)
Numbered list. Pick the questions THIS specific role is most likely to ask, mixing behavioral, technical, and role-fit.

## 2. CV ↔ JD gap analysis
Bulleted: 3 strengths the user should lean on, 3 weaknesses to defend, 1 sentence each.

## 3. STAR stories
3 ready-to-use STAR stories drawn from the CV, mapped to the most likely competencies. Title each story; 4-5 lines each. Concrete, with numbers.

## 4. Smart questions to ask the interviewer (5)
Numbered. Show curiosity and seniority. Avoid obvious / Glassdoor questions.

Be specific to the actual CV content. No generic advice.`,
    docs,
    null
  );

  setSseHeaders(res);
  const abortController = new AbortController();
  res.on('close', () => abortController.abort());
  const t0 = Date.now();
  const selectedModel = modelId(model || 'sonnet');
  try {
    const { usage } = await callLLM({
      systemContent,
      messages: [{ role: 'user', content: 'Generate the prep brief now.' }],
      model: selectedModel,
      max_tokens: 2500,
      temperature: 0.4,
      signal: abortController.signal,
      onToken: (t) => res.write(`data: ${JSON.stringify({ text: t })}\n\n`),
    });
    res.write('data: [DONE]\n\n');
    if (usage) {
      logUsage(req.authUser, {
        model: selectedModel, mode: 'prep',
        in: usage.prompt_tokens || 0,
        cacheRead: usage.prompt_tokens_details?.cached_tokens || 0,
        cacheWrite: usage.prompt_tokens_details?.cache_creation_input_tokens || 0,
        out: usage.completion_tokens || 0,
        cost: calcCost(selectedModel, usage),
        ttftMs: 0, latencyMs: Date.now() - t0,
      });
    }
  } catch (e) {
    if (e.name !== 'AbortError') res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
});

// =============================================================================
// /api/recap — Post-interview recap (Phase 4)
// =============================================================================
app.post(`${BASE_PATH}/api/recap`, rateLimitMiddleware('recap'), async (req, res) => {
  const { sessionId, model } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'No API key' });

  const data = readSession(req.authUser, sessionId);
  if (!data) return res.status(404).json({ error: 'Session not found' });

  // Job binding wins over manual label; fall back to latest label.
  const jobEvents = data.filter(e => e.type === 'session_job');
  const jobEvt = jobEvents[jobEvents.length - 1] || null;
  const boundJob = jobEvt ? findUserJob(req.authUser, jobEvt.jobId) : null;
  const labels = data.filter(e => e.type === 'session_label');
  const lastLabel = labels[labels.length - 1] || {};
  const label = boundJob
    ? { position: boundJob.position, organisation: boundJob.organisation }
    : lastLabel;
  const hasUserSpeech = data.some(e => e.type === 'user_speech');

  // Build a transcript-like blob for the LLM. USER lines are what the
  // candidate actually said out loud (from their mic); A lines are what the
  // assistant *suggested*. Keep them distinct so the coach can grade delivery.
  const lines = data.map(e => {
    if (e.type === 'session_start') return `# Session ${e.sessionId} started ${e.startedAt}`;
    if (e.type === 'session_label') return `# Position: ${e.position || '—'} · Organisation: ${e.organisation || '—'}`;
    if (e.type === 'question') return `Q (interviewer): ${e.question}`;
    if (e.type === 'answer') return `SUGGESTED (${e.mode}): ${e.answer}`;
    if (e.type === 'user_speech') return `USER (said out loud): ${e.text}`;
    return '';
  }).filter(Boolean).join('\n\n');

  const deliverySection = hasUserSpeech
    ? `## How it went
Bulleted assessment of the candidate's *actual* delivery — based on the USER lines (what they said out loud), not the SUGGESTED answers. Call out:
- where delivery was clear, confident, on-point
- where it was vague, rambling, off-topic, or missed the question
- any filler / hedging patterns worth fixing
Be concrete and short. No sugar-coating.`
    : `## How it went
Brief bulleted assessment based on the SUGGESTED answers and the questions asked — what likely landed well, what was weak. (No live mic transcript was captured this session.)`;

  const header = label.position || label.organisation
    ? `Interview for **${label.position || 'unspecified role'}** at **${label.organisation || 'unspecified org'}**.`
    : '';

  const systemContent = [{
    type: 'text',
    text: `You are an interview coach reviewing a completed interview session. Be concise. Candidate reads this to learn, not to be complimented.

${header}

Output markdown, exactly these sections, in this order, nothing else:

## Summary
1-2 sentences: how it went overall.

## Questions asked
Numbered list, brief paraphrase of each interviewer question, chronological.

${deliverySection}

Hard rules:
- DO NOT write a thank-you note, closing email, or follow-up email.
- DO NOT add sections beyond the three above.
- No filler, no preamble, no "overall, this was a solid interview" padding.`,
  }];

  setSseHeaders(res);
  const abortController = new AbortController();
  res.on('close', () => abortController.abort());
  const t0 = Date.now();
  const selectedModel = modelId(model || 'sonnet');
  try {
    const { usage } = await callLLM({
      systemContent,
      messages: [{ role: 'user', content: `Session log:\n\n${lines}\n\nGenerate the recap.` }],
      model: selectedModel,
      max_tokens: 2500,
      temperature: 0.4,
      signal: abortController.signal,
      onToken: (t) => res.write(`data: ${JSON.stringify({ text: t })}\n\n`),
    });
    res.write('data: [DONE]\n\n');
    if (usage) {
      logUsage(req.authUser, {
        model: selectedModel, mode: 'recap',
        in: usage.prompt_tokens || 0,
        cacheRead: usage.prompt_tokens_details?.cached_tokens || 0,
        cacheWrite: usage.prompt_tokens_details?.cache_creation_input_tokens || 0,
        out: usage.completion_tokens || 0,
        cost: calcCost(selectedModel, usage),
        ttftMs: 0, latencyMs: Date.now() - t0,
      });
    }
  } catch (e) {
    if (e.name !== 'AbortError') res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
});

// =============================================================================
// Lightweight, dependency-free .ics parser. Extracts SUMMARY, DESCRIPTION,
// DTSTART of upcoming events from a public/secret ICS URL.
function parseICS(text, opts = {}) {
  const events = [];
  const blocks = text.split(/BEGIN:VEVENT/);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split(/END:VEVENT/)[0];
    // Unfold lines (RFC 5545: continuation lines start with whitespace)
    const unfolded = block.replace(/\r?\n[ \t]/g, '');
    const lines = unfolded.split(/\r?\n/);
    const ev = {};
    for (const raw of lines) {
      const m = raw.match(/^([A-Z-]+)(?:;[^:]*)?:(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (k === 'SUMMARY') ev.summary = v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';');
      else if (k === 'DESCRIPTION') ev.description = v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';');
      else if (k === 'LOCATION') ev.location = v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';');
      else if (k === 'DTSTART') ev.start = parseICalDate(v);
      else if (k === 'DTEND') ev.end = parseICalDate(v);
      else if (k === 'UID') ev.uid = v;
    }
    if (ev.summary && ev.start) events.push(ev);
  }
  return events;
}

function parseICalDate(s) {
  // Handles YYYYMMDD, YYYYMMDDTHHmmss, YYYYMMDDTHHmmssZ
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', se = '00', z] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}${z === 'Z' ? 'Z' : ''}`;
  const date = new Date(iso);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

// =============================================================================
// /api/search — Tavily web search grounding (Phase 5)
// =============================================================================
// Stubbed if TAVILY_API_KEY not set. Used by the answer endpoint when frontend
// requests grounding for a specific question.
app.post(`${BASE_PATH}/api/search`, rateLimitMiddleware('search'), async (req, res) => {
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query required' });
  if (!TAVILY_API_KEY) {
    return res.status(503).json({ error: 'Tavily not configured. Set TAVILY_API_KEY env var.' });
  }
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: String(query).slice(0, 400),
        max_results: 5,
        search_depth: 'basic',
        include_answer: true,
      }),
    });
    if (!r.ok) throw new Error(`Tavily ${r.status}`);
    const data = await r.json();
    res.json({
      answer: data.answer || '',
      results: (data.results || []).slice(0, 5).map(x => ({
        title: x.title, url: x.url, snippet: x.content || x.snippet || '',
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// WS upgrade with session auth (existing)
// =============================================================================
server.on('upgrade', (req, socket, head) => {
  // Accept both /Interview/ws and /Interview/ws?channel=user
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== `${BASE_PATH}/ws`) {
    socket.destroy();
    return;
  }
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies['app_otp_session'];
  const session = token ? verifySession(token, SESSION_SECRET) : null;
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  // Stash channel + authenticated user on the request for the connection handler.
  req._channel = url.searchParams.get('channel') === 'user' ? 'user' : 'interviewer';
  req._authUser = session.email || session.user || 'anonymous';
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// =============================================================================
// WS: Audio → Deepgram → Transcript (existing)
// =============================================================================
wss.on('connection', (clientWs, req) => {
  const channel = req?._channel || 'interviewer';
  const authUser = req?._authUser || 'anonymous';
  console.log(`Client connected (channel=${channel})`);
  let deepgramWs = null;
  let keepAliveInterval = null;

  // `isBinary` is the authoritative control/audio signal. The previous
  // `msg[0] === 0x7b` heuristic misclassified any audio sample that happened
  // to start with byte 0x7b ("{") as a control message and dropped the frame.
  clientWs.on('message', (msg, isBinary) => {
    if (!isBinary) {
      try {
        const ctrl = JSON.parse(msg.toString());
        if (ctrl.type === 'start') { startDeepgram(ctrl); return; }
        if (ctrl.type === 'stop') { stopDeepgram(); return; }
      } catch (e) {}
      return;
    }
    if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.send(msg);
    }
  });

  function startDeepgram(config) {
    if (deepgramWs) stopDeepgram();
    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'en',
      smart_format: 'true',
      punctuate: 'true',
      diarize: 'false',
      interim_results: 'true',
      utterance_end_ms: '1000',
      endpointing: '300',
      vad_events: 'true',
      encoding: 'linear16',
      sample_rate: config.sampleRate || '16000',
      channels: '1',
      filler_words: 'true',
      multichannel: 'false'
    });
    // Deepgram Nova-3 keyterm prompting: one term per repeated param, capped
    // at 50 × 100 chars (service limit). Boosts recognition of session-specific
    // proper nouns — company names, candidate names, tech stack, interviewer
    // jargon — that the base model would otherwise spell phonetically.
    const terms = Array.isArray(config.keyterms) ? config.keyterms : [];
    const seen = new Set();
    let kept = 0;
    for (const raw of terms) {
      if (kept >= 50) break;
      const t = String(raw || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
      if (!t || seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase());
      params.append('keyterm', t);
      kept++;
    }
    if (kept > 0) console.log(`[deepgram] keyterms=${kept}`);
    const url = `wss://api.deepgram.com/v1/listen?${params}`;
    deepgramWs = new WebSocket(url, {
      headers: { 'Authorization': `Token ${DEEPGRAM_API_KEY}` }
    });
    deepgramWs.on('open', () => {
      console.log('Deepgram connected');
      clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));
      keepAliveInterval = setInterval(() => {
        if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 10000);
    });
    deepgramWs.on('message', (data) => {
      try {
        const result = JSON.parse(data.toString());
        // On the user-mic channel, persist FINAL utterances into the session
        // file so the recap coach can grade actual delivery. We still forward
        // everything to the client for optional display.
        if (channel === 'user' && result.type === 'Results' && result.is_final) {
          const alt = result.channel?.alternatives?.[0];
          const text = (alt?.transcript || '').trim();
          if (text) logSessionEvent(authUser, { type: 'user_speech', text: text.slice(0, 4000) });
        }
        // Tag messages with channel so the client can route them.
        result._channel = channel;
        clientWs.send(JSON.stringify(result));
      } catch (e) {}
    });
    deepgramWs.on('close', () => {
      console.log('Deepgram disconnected');
      clearInterval(keepAliveInterval);
      clientWs.send(JSON.stringify({ type: 'status', status: 'disconnected' }));
    });
    deepgramWs.on('error', (err) => {
      console.error('Deepgram error:', err.message);
      try { clientWs.send(JSON.stringify({ type: 'error', error: err.message })); } catch {}
      // Clean up the keep-alive timer and socket ref so we don't leak either.
      stopDeepgram();
    });
  }

  function stopDeepgram() {
    clearInterval(keepAliveInterval);
    if (deepgramWs) {
      deepgramWs.close();
      deepgramWs = null;
    }
  }

  clientWs.on('close', () => {
    console.log('Client disconnected');
    stopDeepgram();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`InterviewAssist running on port ${PORT}`);
});
