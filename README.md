# Viora auth server
Google sign-in, the AI proxy, and account storage in Backblaze B2.

## Environment variables (Render)
Existing: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_SECRET`, `SITE_URL`, `BASE_URL`, `NVIDIA_API_KEY`.

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
- `GET /api/progress?id=<request-id>` → short-lived research status for the authenticated owner of a chat request (Bearer token); no token is placed in the URL

## Pro Search

The chat route accepts `researchMode: "quick" | "deep"` and an optional opaque `researchRequestId`.
Quick Search runs one bounded provider pass and reads up to four pages. Deep Research runs up to three
focused searches in parallel, deduplicates and ranks up to ten results, then attempts to read up to six
pages. Provider/page-fetch progress is stored in memory for at most two minutes and scoped to the
authenticated user. Disconnecting the chat aborts active search, page retrieval, and model requests.
The response includes short retrieved-page excerpts for expandable source previews; provider page
text remains bounded before it is sent to the model or returned to the browser.

Ranking combines topic overlap with modest government/academic/documentation domain hints. It is a
search heuristic, not a source-quality judgment. Citation numbers are tied to returned sources, but
the API does not independently verify each claim against the cited page. Do not report claim-level
fact verification as complete.
## Admin control center

The static website includes a protected `/admin/` control center. It does not trust browser-stored roles; every `/api/admin/*` request verifies the signed Viora session and then checks the server-side `ADMIN_EMAILS` bootstrap list or the account's stored admin role. Set `ADMIN_EMAILS` in Render to one or more comma-separated owner email addresses before using it. If unset, no first administrator is granted. The `/admin/` page also supports a server-verified password sign-in: set `ADMIN_ACCESS_PASSWORD` in Render to a unique secret (never put it in the website code). The password route is rate limited, compares the secret in constant time, issues a 12-hour signed token for the first `ADMIN_EMAILS` identity, and records successful/denied attempts when B2 is configured. The browser stores this token only for the current tab session. If either variable is missing, password sign-in fails closed.

Admin account search, role changes, suspension/reactivation, current-process request counts, model configuration, health checks, and audit events require Backblaze B2 to be configured. Role/status changes are confirmed in the UI and audit logged. Bootstrap emails cannot be changed in the UI. A suspended account is denied on subsequent authenticated requests; the server's short account-status cache may take up to 10 seconds to refresh.

The dashboard reports conversation totals, uploaded-file totals, provider connectivity, billing cost, historical request charts, and runtime feature toggles as unavailable because the current services do not provide those data or controls. Provider-key indicators show only whether a server key is configured and never return the secret.

