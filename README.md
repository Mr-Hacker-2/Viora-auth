# Viora auth server
Google sign-in, the AI proxy, and account storage in Backblaze B2.

## Environment variables (Render)
Existing: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_SECRET`, `SITE_URL`, `BASE_URL`, `NVIDIA_API_KEY`, `HUMANIZER_MODELS`.

Set `HUMANIZER_MODELS` to a comma-separated list of NVIDIA NIM model IDs to choose the Humanizer fallback priority, for example `moonshotai/kimi-k3,deepseek-ai/deepseek-v4.1-flash,z-ai/glm-5.3`. Leave it unset to use that default order.

Voice (speech-to-text for the web app's microphone and Voice Mode):
- `GROQ_API_KEY`: Groq key. Primary provider, model `whisper-large-v3`. Set it as a Render environment variable only; never put it in the website or in Git
- `NVIDIA_API_KEY`: already used for chat. If **ffmpeg is installed on the server** it is also used as the fallback transcription provider (see below)
- `VOICE_STT_PROVIDER`: optional, `auto` (default: Groq, then NVIDIA), `groq` or `nvidia` (try that one first)
- `VOICE_MAX_BYTES`: optional upload limit, default 10 MB, never above 25 MB (Groq's free-tier file limit)
- Spoken replies (text-to-speech) use the **same** `GROQ_API_KEY`; there is nothing new to set. Model `canopylabs/orpheus-v1-english` (override with `GROQ_TTS_MODEL`). Groq may require the model's terms to be accepted once in the Groq console; until then `/api/speak` answers `terms_required` and the website shows that message. `SPEECH_DISABLED=1` switches spoken replies off.
- `VOICE_DISABLED`: set to `1` to start with voice input switched off. Admins can also flip it live from the Voice page of the admin dashboard (`/api/admin/voice`, `/api/admin/voice/enabled`; resets on restart). The page shows in-memory counts only, never audio or transcript text.
- `NVIDIA_WHISPER_FUNCTION_ID`: optional override; default is the id listed on build.nvidia.com/openai/whisper-large-v3

Backblaze B2 (S3-compatible API, no extra packages):
- `B2_KEY_ID`: application key ID (Backblaze → App Keys)
- `B2_APP_KEY`: the key secret. Limit the key to the one bucket, with read and write access
- `B2_BUCKET`: bucket name. Keep the bucket **private**
- `B2_ENDPOINT`: e.g. `https://s3.us-west-004.backblazeb2.com` (shown on the bucket page as "Endpoint")
- `B2_REGION`: optional, read from the endpoint when left out

Without these the site still signs people in, but nothing is saved and the sign-up questions are skipped.

## What is stored
One JSON object per account at `users/<sha256 of email>.json`: name, email, picture, first and latest sign-in, sign-in count,
and the answers to the 5 sign-up questions (`profile.js`). Only the fixed option ids are accepted.

## Routes
- `GET /auth/google?site=1&mode=signin|signup` → Google, then back to the site; the account is created or updated in B2
- `GET /api/profile` → `{ questions, onboarded, answers }` (Bearer token)
- `POST /api/profile` with `{ answers }` → validates and saves the answers (Bearer token)
- `/api/chat` adds the saved answers to the AI's system prompt as background about the user
- `POST /api/transcribe` with the raw recording as the body (`Content-Type: audio/webm`, `audio/mp4`, `audio/ogg`, `audio/wav`, `audio/flac`, `audio/mpeg`) and an optional `?language=en` → `{ text, empty, language, duration, provider }` (Bearer token). `GET /api/transcribe` → `{ available, providers: {groq, nvidia}, maxBytes }` (booleans only, never keys)
- `POST /api/speak` with `{ "text": "up to 200 characters", "voice": "hannah" }` → `audio/wav` (Bearer token). Voices: `hannah` (default), `autumn`, `diana`, `austin`, `daniel`, `troy`. Square brackets are stripped (Orpheus reads `[word]` as a vocal direction). Limits: 120 requests per minute per account, 5 in flight per account. If the browser hangs up, the request to Groq is cancelled. `GET /api/speak` → `{ available, model, voices, defaultVoice, maxChars }` (never a key). Errors are JSON `{ code, error }`.
- `GET /api/progress?id=<request-id>` → short-lived research status for the authenticated owner of a chat request (Bearer token); no token is placed in the URL

## Pro Search

The chat route accepts `researchMode: "quick" | "deep"` and an optional opaque `researchRequestId`.
Quick Search runs one bounded provider pass and reads up to four pages. Deep Research runs up to three
focused searches in parallel, deduplicates and ranks up to ten results, then attempts to read up to six
pages. Provider/page-fetch progress is stored in memory for at most two minutes and scoped to the
authenticated user. Disconnecting the chat aborts active search, page retrieval, and model requests.
The response includes short retrieved-page excerpts for expandable source previews; provider page
text remains bounded before it is sent to the model or returned to the browser.

Book-content searches also query Google Books and accept only records whose title matches the requested
work. General search providers use stricter topic matching so a single generic word does not admit an
unrelated result. The response distinguishes provider failure from a completed search with no relevant
sources, reports page-read failures, and says how many retrieved records were supplied to the model.
Search errors are included in the streamed research metadata and answer context.

Ranking combines topic overlap with modest government/academic/documentation domain hints. It is a
search heuristic, not a source-quality judgment. Citation numbers point to returned source URLs, but
the API does not independently verify each claim against the cited page. Do not report claim-level fact
verification as complete.
## Admin control center

The static website includes a protected `/admin/` control center. It does not trust browser-stored roles; every `/api/admin/*` request verifies the signed Viora session and then checks the server-side `ADMIN_EMAILS` bootstrap list or the account's stored admin role. Set `ADMIN_EMAILS` in Render to one or more comma-separated owner email addresses before using it. If unset, no first administrator is granted. The `/admin/` page also supports a server-verified password sign-in: set `ADMIN_ACCESS_PASSWORD` in Render to a unique secret (never put it in the website code). The password route is rate limited, compares the secret in constant time, issues a 12-hour signed token for the first `ADMIN_EMAILS` identity, and records successful/denied attempts when B2 is configured. The browser stores this token only for the current tab session. If either variable is missing, password sign-in fails closed.

Admin account search, role changes, suspension/reactivation, current-process request counts, model configuration, health checks, and audit events require Backblaze B2 to be configured. Role/status changes are confirmed in the UI and audit logged. Bootstrap emails cannot be changed in the UI. A suspended account is denied on subsequent authenticated requests; the server's short account-status cache may take up to 10 seconds to refresh.

The dashboard reports conversation totals, uploaded-file totals, provider connectivity, billing cost, historical request charts, and runtime feature toggles as unavailable because the current services do not provide those data or controls. Provider-key indicators show only whether a server key is configured and never return the secret.

## Voice transcription (`transcribe.js`)

Audio is handled in memory for one request: it is never written to disk, never logged and never stored. Before any audio goes to a provider the server checks the size (413), that it is long enough to hold speech (400), the declared content type (415) and the real container from the file's magic bytes (415), then applies a per-account limit of 20 recordings a minute (429) and at most 2 transcriptions at once per account (503). A recording the model itself marks as non-speech comes back as `empty: true` instead of an invented sentence.

**Groq** (primary): `POST https://api.groq.com/openai/v1/audio/transcriptions`, multipart form, `model=whisper-large-v3`, `Authorization: Bearer $GROQ_API_KEY`. Accepts webm, mp4/m4a, ogg, wav, flac and mp3 directly.

**NVIDIA** (fallback) is *not* the same request format. The hosted `whisper-large-v3` is a Riva **gRPC** service: `grpc.nvcf.nvidia.com:443`, method `/nvidia.riva.asr.RivaSpeechRecognition/Recognize`, metadata `function-id` and `authorization: Bearer $NVIDIA_API_KEY`, a protobuf `RecognizeRequest`, and audio that must be mono 16-bit WAV, OPUS or FLAC. Browser recordings are webm or mp4, so the server converts them to mono 16 kHz FLAC with `ffmpeg` (stdin to stdout, nothing on disk). The protobuf and gRPC framing are written against `node:http2`, so the server still has no dependencies. Render's Node runtime does not include ffmpeg by default: without it the NVIDIA fallback reports itself unavailable and Groq alone is used.


## Personal Intelligence (opt-in public footprint discovery)

Routes (all require the signed-in session; every route only reads or writes the caller's own data, stored privately at `intel/<sha256(email)>.json` in B2):
`GET /api/intel`, `POST /api/intel/consent` `{enable, acknowledge}`, `POST /api/intel/discover`, `POST|DELETE /api/intel/findings/:id`, `PUT /api/intel/profile`, `DELETE /api/intel`.

- Discovery requires `emailVerified: true` on the account (Google sign-in), so nobody can register another person's address and look them up. Password-only accounts are refused until a verification flow exists.
- Sources: GitHub REST user search (`in:email`, only matches emails users made public), Gravatar REST v3 profile for the email hash, Brave Search API exact-email search. No scraping, no logins.
- Env vars: `BRAVE_SEARCH_API_KEY` (required for web results; without it that source reports "not configured"), `GITHUB_TOKEN` and `GRAVATAR_API_KEY` (optional, higher rate limits).
- One discovery run per account every 10 minutes (in-memory). Findings stay `pending` until the user approves; only approved, request-relevant profile items (max 8) are added to the chat system prompt for Flash, Pro Search and Math & Code. The Humanizer gets none, so rewrites never gain facts.
- Account deletion also deletes the Personal Intelligence object.
