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


### Admin Backblaze storage management

The protected admin API exposes bucket metadata, paginated object inventory, and version-aware deletion previews. The dashboard uses the existing private bucket and never receives B2 credentials. The storage inventory recognizes these Viora namespaces:

- `planner/`: per-account Planner state.
- `planner-files/`: Planner task attachments.
- `intel/`: opt-in Personal Intelligence data.
- `labs/`: Labs CMS tool/article JSON and uploaded media.
- `users/`: account identity, profile, plan, and credit records (**protected**).
- `deleted/`: account-deletion tombstones (**protected**).
- `admin/audit/`: administrator audit events (**protected**).

Unknown bucket objects are visible as unclassified/read-only and are never eligible for deletion. “Delete All Info from Blackblaze” is intentionally scoped to the four deletable application-data namespaces above; it preserves account/authentication records, tombstones, audit history, and unrelated objects. Selected-object and bulk deletion first create an exact version manifest, then require the exact typed phrase and a separate second confirmation. All object versions and delete markers are removed and the remaining versions are checked before a successful result is returned.

The B2 application key needs permission to list files and object versions, read object metadata, and permanently delete specific versions. In Backblaze B2, configure a bucket-restricted key with the relevant `listFiles`, `readFiles`, `writeFiles`, and `deleteFiles` capabilities. The dashboard reports bucket reachability and endpoint metadata; bucket privacy itself must still be verified in the Backblaze console.

The destructive-operation preview is held in server memory for five minutes and expires on a server restart. Large deletion manifests are capped for safety; oversized operations must be divided into smaller category or selected-object batches. No bulk deletion is run by tests or deployment.

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

Routes (all require the signed-in session; every route reads or writes only the caller's own profile, stored privately at `intel/<sha256(email)>.json` in B2):
`GET /api/intel`, `POST /api/intel/consent` `{enable, acknowledge, adultConfirmed}`, `POST /api/intel/discover`, `POST|DELETE /api/intel/findings/:id`, `PUT /api/intel/profile`, `DELETE /api/intel`.

- Discovery is optional, off by default, and restricted to people who explicitly confirm they are 18 or older. A verified email is also required before any search runs.
- Website sign-up offers a separate opt-in. Google sign-up can queue the first run immediately after verified account creation. Email/password sign-up can save the opt-in, but discovery remains disabled until the same email is later verified with Google.
- Sources: GitHub REST user search (`in:email`, limited to emails users made public), Gravatar REST v3 profile for the email hash, and Brave Search API exact-email search. These are the only enabled integrations; no private-account access, login walls, scraping, or leaked data.
- Env vars: `BRAVE_SEARCH_API_KEY` (required for public web results; without it that source reports "not configured"), `GITHUB_TOKEN` and `GRAVATAR_API_KEY` (optional, higher rate limits). Credentials stay on the server.
- One discovery run per account every 10 minutes (in-memory). Findings remain pending until the user approves them. Approval adds editable profile facts. Only approved, request-relevant profile items (max 8) are added to the chat system prompt; Humanizer receives none.
- The About you & Memory dialog shows the approved profile summary. The full dashboard lets users review, reject, correct, disable, or delete discoveries. Disabling removes AI access and stops future discovery.
- Profile deletion permanently removes all B2 versions and delete markers for that account's Personal Intelligence object and clears the account's saved opt-in. Account deletion also removes the Personal Intelligence object.

## Personal Intelligence background discovery

Discovery is a persistent server-side job (`intel-jobs.js`), not a browser action. The browser requests a run and watches progress; the server does the work.

- **Storage:** one private document per account, `intel/<sha256(email)>.jobs.json`, in the existing B2 bucket (so account deletion, "delete my profile" and the admin storage tools cover it). It holds job state, per-source results and retry schedule. Nothing runs from an in-memory Map, a timer in the browser, or an open page.
- **Queue rules:** at most one active job per account. Asking while one is active joins it (`200`, `request: "already_running"`); asking after it finished starts a fresh one immediately (`202`, `request: "started"`). There is no user-facing cooldown.
- **Automatic first run:** when a verified account with an explicit, adult-confirmed opt-in is created or verified (Google sign-up, Google verification of a password account, or turning discovery on), the server queues the first job itself. `GET /api/intel` also queues it if it was somehow never queued.
- **Worker:** an in-process loop (`INTEL_WORKER_TICK_MS`) claims due jobs with a lease. After a restart, `recover()` re-reads the job documents; a job whose lease expired is resumed, and sources that already finished are not asked again. SIGTERM hands running jobs back to the queue.
- **Retries:** per source. Temporary errors (network, timeouts, 429, 5xx, GitHub rate limits) use exponential backoff with jitter; `Retry-After` / `x-ratelimit-reset` is honoured exactly; permanent errors (other 4xx, missing key) are never retried. A failed first run is retried automatically later (up to 3 times, doubling delay).
- **Commit:** only the final step touches the profile, under the account's lock, after re-checking consent, verification, pause state and deletion. Failed, cancelled or partial runs never overwrite existing data. Findings are merged by canonical URL; user decisions and edits are kept; uncertain findings are never auto-approved.
- **Abuse protection:** a per-account start budget (`INTEL_MAX_RUNS_PER_HOUR`, default 10) *delays* excess jobs instead of refusing them, a global concurrency cap (`INTEL_MAX_CONCURRENT_JOBS`), and the existing request limiter.
- **Stopping:** turning discovery off, pausing, deleting the profile or deleting the account cancels queued/running jobs (aborting provider calls) and discards partial results.

Routes (all Bearer-authenticated, always scoped to the caller's own account):
`GET /api/intel` (state + `discovery`), `GET /api/intel/discovery` (live progress), `POST /api/intel/discover`, `POST /api/intel/discovery/cancel`, `POST /api/intel/discovery/ack`, `POST /api/intel/pause {paused}`, `POST /api/intel/consent`, `POST /api/intel/settings`, `POST|PUT|DELETE /api/intel/findings/:id` (approve/reject/pending, edit `facts`, delete), `PUT /api/intel/profile`, `DELETE /api/intel`.

Optional environment variables (defaults in brackets): `GITHUB_TOKEN`, `GRAVATAR_API_KEY`, `BRAVE_SEARCH_API_KEY` (provider keys, backend only), `INTEL_WORKER_DISABLED=1` (turn the worker off), `INTEL_WORKER_TICK_MS` [3000], `INTEL_LEASE_MS` [90000], `INTEL_MAX_ATTEMPTS` [4], `INTEL_BACKOFF_BASE_MS` [5000], `INTEL_MAX_CONCURRENT_JOBS` [2], `INTEL_MAX_RUNS_PER_HOUR` [10], `INTEL_SOURCE_TIMEOUT_MS` [15000], `INTEL_AUTO_RETRY_DELAY_MS` [1800000].

Limitations: the job lease is read-modify-write on object storage (no compare-and-swap), so it is designed for one server process (the current Render deployment); a second process could duplicate provider calls but cannot duplicate findings. The service must stay running for the worker to run; on hosts that sleep idle instances, jobs resume on the next wake-up.
