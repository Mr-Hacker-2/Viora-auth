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
