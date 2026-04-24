# interview-assist

> Live interview coaching for the chronically unprepared.

Share a browser tab (the one with your Zoom / Teams / Meet), this quietly listens, auto-detects questions, and streams a strong first-person answer onto your screen before you've finished saying *"that's a great question"*. If your mic is on, it also records your actual delivery and grades you on it after. Welcome to the **tremendous** future of interviewing.

---

## What it does

1. You share the tab where the interviewer lives. The tab audio streams to **Deepgram Nova-3** for real-time transcription.
2. Your own mic opens a second channel so the app captures what YOU say too. That stream isn't used live — it's saved for the recap.
3. A question is detected → the assistant streams an answer card, grounded in your CV, the JD, your cover letter, and any custom coaching prompt you set for *this* interview.
4. Re-run the same question in a different mode: `STAR`, `Code`, `Clarify`, `Bridge`, `Follow-ups`. Or apply a refinement: `Shorter`, `Longer`, `More confident`, `Simpler`, `+ Example`, `Redo`, `Rephrase`.
5. When it's over, open the **Recap**: every question the interviewer asked, how *you* actually answered (from your mic transcript — not the assistant's output), what landed, what flopped, what to practise next time.

## Why I built it

I kept getting asked *"what project most excited you in the last three years?"* and answering with whatever I happened to remember at 02:00 the night before. Not any more. Now a pattern-matching silicon ghost does the remembering; I do the charm.

Interviewing is performance, and performance without rehearsal is stand-up comedy without jokes. This gives you rehearsal *while* you perform. Ethically adjacent. Legally fine in the jurisdictions I've checked. Very **tremendous**.

And yes — the whole thing was built with an LLM riding shotgun, because I'm not writing WebSocket reconnect logic by hand when I could be reading. Being honest about AI-in-the-loop is more dignified than pretending it wrote itself.

## The "Job" concept

Every interview is a **Job** — a per-interview bundle of:

- **Job description** (paste it; Haiku-4.5 auto-extracts position / organisation / seniority / competencies)
- **Your actual application** (cover letter, answers you submitted on the form)
- **Your resume** (uploaded once, shared across all jobs)
- **A custom coaching prompt** ("lean into the CMRE HPC story", "avoid discussing comp", "this is a staff-level infra role, not an IC role")

When the Job is active, every answer request injects the whole bundle as a **stable, prompt-cache-friendly system prompt**. Anthropic prompt caching actually catches, so every follow-up question in a 45-minute interview comes back for pennies instead of dollars.

## Design

Transplanted wholesale from the sibling [matrix-client](https://github.com/zlnsk/matrix-client) — Google-Messages-flavoured:

- **Roboto** with the nice stylistic alternates (`cv02 cv03 cv04 cv11 ss01 ss03`)
- **18 px answer bubbles** with hairline `color-mix` borders, no shadows at rest
- **Glass topbar** with `saturate(180%) blur(14px)` and a thin hairline underborder
- **Elapsed-interview timer** that starts on *Share Tab Audio*, freezes on stop — so you know whether to wrap up or dig in
- **Every mode / refinement is a per-card chip**. The topbar stays quiet. The last thing you want during an interview is a busy UI.

Respects `prefers-reduced-motion: reduce` — during an actual interview, a bouncing bubble in peripheral vision is the last thing your nervous system needs.

## Security

- **Auth is OTP** via email + HMAC-signed session cookies. No stored passwords, no social login, no OAuth tokens hanging around.
- **Tab audio streams direct to Deepgram** over an authenticated WebSocket. Nothing is persisted server-side beyond the session-local JSONL transcript, which you can delete at will.
- **Your mic recording is opt-in**. If `getUserMedia` is denied, the app runs in single-channel mode — the app still works; the recap just won't grade your delivery.
- **Your CV, JDs, applications, and coaching prompts stay on your server.** No analytics, no upstream beacons, no "anonymous" telemetry.
- **Rate-limits on every LLM endpoint** (`answer` 30/min, `prep` 5/min, `recap` 5/min, `classify` 120/min, `search` 30/min). A runaway client doesn't drain your OpenRouter balance.
- **No `X-Forwarded-User` trust.** Auth is enforced by OTP cookie + a proxy-secret header check the reverse proxy injects. Fail-closed, not fail-open.
- **PDF uploads size-capped + path-sanitised.** Filename collisions can't escape the uploads directory.

## Run it

Needs Node 22+, a Deepgram API key, an OpenRouter API key, and a reverse proxy doing TLS + injecting an `X-Proxy-Secret` header.

```bash
cp ecosystem.config.example ecosystem.config.js
# fill in DEEPGRAM_API_KEY, OPENROUTER_API_KEY, OTP_SESSION_SECRET, OTP_ALLOWED_EMAILS
npm install
pm2 start ecosystem.config.js
```

The `shared-auth` OTP module is resolved via `SHARED_MODULES_DIR` symlink — vendor it locally or point the env var at your module dir.

## License

MIT. Use it, break it, fix it, PR it.
