# InterviewAssist

AI-powered live interview assistant. Streams shared tab audio to
[Deepgram](https://deepgram.com) for real-time transcription, then feeds the
interviewer's question plus your uploaded CV / job description to an LLM
(via [OpenRouter](https://openrouter.ai)) to generate a concise, first-person
answer you can read while the interview is happening.

## Features

### Core
- Live speech-to-text via Deepgram Nova-3 (diarization, interim results, VAD)
- Streaming LLM answers via OpenRouter
- Contextual answers grounded in your own CV + job description
- PDF / TXT / Markdown document upload, persisted server-side
- Per-user session question logging
- Auth via shared OTP module (`the shared-auth module (see setup)`)

### Modes (v1.1)
Six interview-assistant modes you can switch between with the chip row or `1`–`6`:

- **Answer** — concise first-person answer (≤90 / 130 words)
- **Clarify** — generates a clarifying question to buy time
- **Follow-ups** — 2–3 smart questions you can ask the interviewer back
- **STAR** — Situation / Task / Action / Result for behavioural questions
- **Code** — coding-interview script: `[SAY THIS FIRST]` + `[THE CODE]` + `[SAY THIS AFTER]` + `[COMPLEXITY]`
- **Bridge** — short stalling sentence when you've gone silent

### Refinements
Each answer card has chips and hotkeys for re-runs in a different style:
shorter, longer, add example, more confident, simpler, rephrase. Refinement
intent is also auto-detected from the user's own utterances ("make it shorter",
"give me an example", etc.).

### Prompt caching
The CV + JD block is sent as a `cache_control: { type: "ephemeral" }` content
block, so subsequent calls re-use the cached prefix at ~10× cheaper input cost
and lower TTFT.

### Picture-in-Picture answers
A standalone always-on-top window (Document Picture-in-Picture API in
Chrome / Edge) mirrors the latest answer so you can keep reading it while the
main browser tab is hidden behind your video call.

### Light RAG
For huge CVs, optional RAG mode chunks docs and only injects the top
keyword-scored chunks per question (no embeddings, no DB — single-file in-memory).

### Personas
Saved system-prompt presets you can apply per question (e.g. "Senior backend,
fintech, Polish-speaking interviewer", "EM behavioural round").

### Pre-interview prep mode
Given your CV + JD, generates a prep brief: 8 likely questions, gap analysis,
3 ready-to-use STAR stories drawn from the CV, and 5 smart questions to ask
the interviewer.

### Post-interview recap
Per-session report: questions asked, strongest answers, answers to revise,
likely follow-ups for the next round, and a thank-you-note draft.

### Calendar integration (ICS)
Paste a Google Calendar `.ics` secret address. The app fetches upcoming
events whose title or description matches `interview / screen / round /
coding / technical / behavioural / hiring`, lets you import an event's
description as a JD document with one click.

### Web search grounding (optional)
Set `TAVILY_API_KEY` to enable on-demand Tavily search before answering
"what's new in X" type questions.

### Token / cost dashboard
Per-user usage log: total cost, requests, cache-hit rate, average TTFT, daily
breakdown, by-model and by-mode breakdowns. Top-right pill shows today's spend.

### Hotkeys
| Key | Action |
|-----|--------|
| `Space` | Re-answer the last detected question |
| `1`–`6` | Switch mode |
| `R` / `Shift+R` | Refine: shorter / longer |
| `E` | Refine: add example |
| `S` | Refine: simpler / less jargon |
| `C` | Clear answers |
| `Y` | Copy last answer to clipboard |
| `M` | Toggle menu drawer |
| `P` | Pop out answers (Picture-in-Picture) |
| `?` | Show shortcuts help |
| `Esc` | Close drawer / modal |

## Environment variables

Copy `.env.example` to `.env` (or use `ecosystem.config.example` with PM2)
and fill in:

- `PORT` — HTTP port (default `3014`)
- `APP_URL` — public URL of the app, sent as `HTTP-Referer` to OpenRouter
- `DEEPGRAM_API_KEY` — required for transcription
- `OPENROUTER_API_KEY` — required for answer generation
- `TAVILY_API_KEY` — *optional*, enables `/api/search` web grounding

## Upload your own CV

1. Start the app and open it in your browser.
2. Open the menu drawer (`M`) → **Docs** tab → upload your resume PDF and the
   job description.
3. The server extracts text with `pdf-parse`, chunks it, and stores metadata
   in `uploads/meta.json`. The `uploads/` directory is git-ignored — your CV
   never leaves the machine.

## Install & run

```bash
npm install
cp .env.example .env   # fill in keys
node server.js
```

Or with PM2: `cp ecosystem.config.example ecosystem.config.js && pm2 start ecosystem.config.js`.
