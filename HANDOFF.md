# HANDOFF — Catch a Beast

Written 2026-08-03 for a fresh Claude session with zero memory of prior conversations. Read this whole file before touching code.

## What this app is

"Catch a Beast" (formerly "The Beast Game") — a social gamification app for college students. Users photo-credit each other doing dumb/fun "beast" activities, post publicly (Discover feed) or to Groups (2-30 members), earn "Beast Points" from crowd-sourced credit, level up (Squid → Normie → Ferda Beast), and see a leaderboard. Photos auto-expire after 24h unless saved.

**Stack**: Node/Express + better-sqlite3, single process serves both the API and the built React (Vite) frontend. Deployed on Render free tier. GitHub: `github.com/aidancryan55/Beast-App`. Live: `https://beast-app-0y3m.onrender.com`.

**User's real deadline**: wants this on the App Store by **Aug 16, 2026** — that's when they go back to college, which is the target market. This is a real, tight deadline, not a soft one.

## What's done (this session)

The user pasted an Apple App Store compliance analysis and asked to bring the app up to par, specifically:

1. **Guideline 1.2 (UGC moderation) — DONE.**
   - Report button on every post (`server/index.js`: `POST /api/posts/:postId/report`, frontend `ReportButton` in `App.jsx`). Reason required, 500 char max.
   - Block button on every post, blocks the poster (`POST/GET /api/users/:username/block|unblock|blocked`). Blocking is bidirectional-hiding: once blocked, neither party sees the other's content in Discover or group feeds (`getHiddenUserIds` helper in `index.js`).
   - Admin moderation queue: `GET /api/admin/reports` (pending reports), `POST /api/admin/reports/:reportId/resolve` with `action: 'dismiss' | 'remove' | 'ban'`. `ban` deletes the post, bans the **poster** (`credited_by_user_id`, i.e. whoever uploaded it — my judgment call, not the subject), and kills their sessions immediately.
   - Admin access is gated by `is_admin` flag on the user row, auto-set via `ADMIN_EMAIL` env var (checked at signup AND at boot).
   - Basic text filter on captions (`CAPTION_BLOCKLIST` regex array + `containsBlockedContent()`) — a first pass only, does NOT cover image content (no automated image moderation; that needs a paid third-party API and was explicitly scoped out).
   - Frontend: `⚙️ Settings` tab has a blocked-users list with unblock; admin users additionally see a `🛡️ Admin` tab with the moderation queue and resolve buttons. All tested end-to-end in-browser (see Testing section below).

2. **Guideline 5.1.1(v) (in-app account deletion) — DONE.**
   - `DELETE /api/account` in `server/index.js`, requires the current password (bcrypt-verified) as re-confirmation.
   - Before deleting the user row: nulls `groups.created_by_user_id` for any groups they created (so deleting your account doesn't destroy a group other people are still in — see Gotchas below for why this is done explicitly rather than relying on `ON DELETE SET NULL`), then deletes the user row (cascades sessions, posts as subject/poster, post_credits, reactions, reports, blocks, group_members via existing `ON DELETE CASCADE` FKs), then deletes their uploaded photo files from disk.
   - Frontend: Settings tab has a "Delete my account" flow with password re-entry confirmation, wired to `api.deleteAccount(password)`.
   - Fully tested via curl and in-browser: wrong password → 401 with friendly error; correct password → account, sessions, posts, and photo files all gone, group survives with null owner, redirects to login screen.

3. **Privacy policy — DONE (as much as code can do).**
   - `GET /privacy` in `server/index.js`, plain server-rendered HTML (works with no JS, survives independent of the SPA bundle) — required because Apple needs a real working URL for both in-app linking and App Store Connect metadata.
   - Covers: what's collected, how it's used, photo retention, moderation policy (report → 24h review → remove/ban), account deletion, no third-party data sharing except Resend for transactional email, and a contact email.
   - Contact email defaults to `aidancryan55@gmail.com` via `CONTACT_EMAIL` env var (unset in Render currently — uses the default). **The user should confirm this is the email they want listed publicly**, or set `CONTACT_EMAIL` in Render.
   - Linked from the login screen footer and from the Settings tab ("Legal" section).

4. **`server/.env.example`** updated to document `ADMIN_EMAIL`.

## What's explicitly NOT done (out of scope for this pass, by the user's own framing)

- **Guideline 4.2 (thin web-wrapper rejection risk)**: the iOS app is a Capacitor wrapper around the live web app (`client/ios/`, points at the Render URL via `capacitor.config.json`'s `server.url`). Apple can reject wrapped web views with "no native value." The user acknowledged this as a separate, harder problem and did not ask for it to be fixed in this pass. If Apple rejects on 4.2, the fix is adding real native functionality (push notifications, native camera/share integration, offline support, etc.) — not something to attempt casually with the Aug 16 deadline looming.
- **Privacy "nutrition label"**: this is App Store Connect metadata (a form you fill out when submitting), not code. Whoever submits the app needs to fill out "App Privacy" in App Store Connect based on what's actually collected: email (linked to identity, used for account functionality), photos (linked to identity), and that's about it — no analytics/ads SDKs are in this app as far as I know.
- **Sign in with Apple**: not needed — the app is email/password only, no third-party social login exists, so this Apple requirement doesn't apply. No action needed unless someone later adds Google/Facebook login.

## Files touched this session

- **`server/index.js`** (~800 lines now) — added: `CONTACT_EMAIL` const, `GET /privacy` route, `DELETE /api/account` route (inserted right after `POST /api/logout`), block/unblock/blocked-list routes (inserted after `/api/users/:username/search`), report + admin moderation routes (inserted after `POST /api/posts/:postId/save`), `isBlocked()`/`getHiddenUserIds()` helpers, `requireAdmin` middleware, `CAPTION_BLOCKLIST`/`containsBlockedContent()`, `deletePostAndFile()` helper (also used by `cleanupExpiredPosts()`). Discover and group-feed endpoints now filter out blocked users' content.
- **`server/db.js`** — added `reports` and `blocks` tables, `is_admin`/`banned` columns on `users` (with idempotent migrations for existing DBs), admin auto-promotion via `ADMIN_EMAIL` at boot. Has a load-bearing comment explaining the `groups.created_by_user_id` FK gotcha (see below) — don't remove that comment, it documents a real bug that was found and worked around.
- **`server/.env.example`** — documents `ADMIN_EMAIL` now, in addition to the pre-existing `RESEND_API_KEY`/`RESEND_FROM`/`APP_URL`. Should probably also gain `CONTACT_EMAIL` — I didn't add it, but it'd be a one-line addition if you want it self-documenting.
- **`client/src/api.js`** — added `reportPost`, `getBlockedUsers`, `blockUser`, `unblockUser`, `deleteAccount`, `getAdminReports`, `resolveReport`.
- **`client/src/App.jsx`** — added `ReportButton`, `SettingsView`, `AdminView` components; `PostCard` now shows Report/Block controls; `App` captures `isAdmin` from the login response (was previously dropped — the login response always had `isAdmin` in the payload since the earlier auth-overhaul phase, but the frontend wasn't reading it); new `⚙️` Settings tab and conditional `🛡️ Admin` tab in nav; login screen footer links to `/privacy`.
- **`client/src/App.css`** — added styles for `.flag-btn`, `.report-form`, `.settings-view`, `.danger-zone`, `.admin-view`, `.admin-report-card`.

**None of this is committed yet.** `git status` shows all six files above as modified, uncommitted. There's also one prior commit (`968f0ef`, "Add real authentication...") that's local-only, one commit ahead of `origin/main` — not pushed. The user needs to supply a real `RESEND_API_KEY` in Render before pushing that auth commit live (communicated to them previously, still outstanding — verification emails silently no-op to console.log without it, which would strand real signups).

## Key decisions and why

- **Ban targets the poster, not the subject**, on the theory that the poster is who uploaded the objectionable content. If report volume in practice suggests subjects need protection too (e.g. someone keeps getting photographed without consent), that's a product decision for later — the current mechanism (block) already covers "stop this person from posting about me."
- **Moderation is manual (report → human review → resolve), not automated.** No image-moderation API is wired in. This satisfies Apple's requirement for *a mechanism* to moderate UGC; it does not mean content is screened before it's visible. If report volume becomes real, an automated first-pass (AWS Rekognition, Hive, etc.) would reduce reviewer burden, but that's real infra work and cost, intentionally deferred.
- **Privacy policy is server-rendered HTML, not a React route.** Chose this so the URL works even if the SPA JS bundle fails to load or Apple's reviewer/crawler doesn't execute JS — a static, dependency-free page is the safer bet for a URL that has to satisfy an external reviewer.
- **Account deletion explicitly nulls `groups.created_by_user_id` before deleting the user**, rather than relying purely on the FK's `ON DELETE SET NULL`. This is a deliberate belt-and-suspenders move — see the Gotcha below for why the DB-level FK behavior can't be fully trusted across all deployed databases.

## Gotchas / things that will bite you if you don't know them

1. **SQLite rename-based migrations silently corrupt other tables' foreign keys.** Earlier this session I tried to fix `groups.created_by_user_id`'s FK behavior (it was `ON DELETE CASCADE`, which would destroy an entire group if the creator deleted their account) via the classic SQLite pattern: `RENAME TO x_old`, `CREATE TABLE x (...)`, `INSERT INTO x SELECT * FROM x_old`, `DROP TABLE x_old`. **This is dangerous**: SQLite rewrites other tables' FK references to point at `x_old` during the rename, and when `x_old` is dropped those FKs go dangling — I verified this directly, a `posts` row was silently deleted as collateral damage. **Do not do this again.** The fix in place: new databases get the correct `ON DELETE SET NULL` directly in the `CREATE TABLE IF NOT EXISTS` statement (safe, no rename involved since it only fires on a fresh DB); existing/already-deployed databases still have the old CASCADE behavior at the schema level, but the account-deletion endpoint explicitly nulls `created_by_user_id` before deleting the user row, which sidesteps the CASCADE regardless of which schema variant a given database has. If you ever need another FK behavior change on an existing table, do it at the application level (like this), not via rename-based migration.
2. **The `:username` URL param on the block/unblock/blocked-list routes is intentionally unused.** Those handlers operate entirely on `req.authUser.id` from the session token (secure by construction — you can only block/unblock/list *your own* blocks), so the client passes a throwaway `_` placeholder in that URL segment (`/users/_/block` etc. in `api.js`). This is not a bug; it mirrors how those routes were already shaped before this session (`/api/users/:username/search` etc. also don't really need the `:username` for anything but readability/REST-shape consistency).
3. **`completions` and `friendships` tables still exist in the schema and still get migrated, but nothing in the app uses them anymore.** The self-report/streaks system and the 1:1 friends system were both fully ripped out in an earlier session (replaced by the public Discover feed + Groups model). The tables and their migration code are just inert leftovers — safe to ignore, would be safe to drop entirely if you want to clean up, but not urgent.
4. **The uploaded "photos" in all my testing this session were fake 8-byte PNG stubs** (`printf '\x89PNG\r\n\x1a\n' > fake.png`), just enough to pass the multer `image/*` MIME filter. They don't render as real images (you'll see a broken image icon in screenshots) — that's expected and not a bug. I didn't test with a real photo; if you want to sanity-check actual image rendering, upload a real JPEG through the UI once.
5. **Local test data was wiped after every test round** (`rm -f data.sqlite*; rm -rf uploads`) to keep runs clean — the committed repo has no local DB file, a fresh `node server/index.js` will create one from scratch via `db.js`'s `CREATE TABLE IF NOT EXISTS` + seed logic.
6. **Render's disk is ephemeral.** Photos and the SQLite file can be lost on redeploy. This was already flagged to the user in an earlier session as an accepted risk for the free tier — not something this session touched, just repeating it here so it isn't rediscovered as a "new" problem.

## Next concrete steps, in order

1. **Review the contact email.** `CONTACT_EMAIL` defaults to `aidancryan55@gmail.com` (the user's own email, inferred from their account context) in both the privacy policy and... actually it's only used in the privacy policy right now. Confirm that's the address they want published, or set `CONTACT_EMAIL` as a Render env var to something else (e.g. a dedicated support address).
2. **Commit this session's work.** Nothing above is committed. Suggested split: one commit for the moderation/report/block backend+frontend, one for account deletion, one for the privacy policy page — or bundle as one "Apple App Store compliance: reporting, blocking, account deletion, privacy policy" commit if the user prefers fewer commits (check their preference; this project's git log shows a mix of both granularities).
3. **Push to `origin/main`** — but only after confirming with the user, and only after they've set the real `RESEND_API_KEY` in Render's dashboard (still outstanding from the prior auth-overhaul session; without it, verification emails only log to console and no real user can complete signup on the deployed app).
4. **Set `ADMIN_EMAIL` in Render** to whichever email should be the moderator/admin account, so the moderation queue is actually reachable on the live deployed app.
5. **Fill out the App Store Connect "App Privacy" nutrition label** — this is a form in App Store Connect (not code), see the "explicitly NOT done" section above for what to declare.
6. **Decide on the Guideline 4.2 native-wrapper risk.** Given the Aug 16 deadline, the pragmatic move is probably: submit as-is and see if Apple actually rejects on 4.2 (many Capacitor-wrapped apps get through, especially ones with real backend functionality like this one has — accounts, moderation, real-time-ish social features), rather than trying to bolt on native features under time pressure. If it does get rejected on 4.2, that's a distinct, larger follow-up task — not something to preemptively solve now.
7. **Test with a real photo upload** through the actual UI (not curl with a fake PNG stub) to be sure the full photo pipeline renders correctly, since this session only verified it functionally via fake image files.

## How to run and test locally

```bash
cd server
npm install   # if not already done
ADMIN_EMAIL=you@example.com node index.js   # runs on :4001, serves API + built client/dist
```

Frontend dev/rebuild:
```bash
cd client
npm install
npm run build   # writes client/dist, which server/index.js serves statically
```

Without `RESEND_API_KEY` set, verification emails print the verify link to the server console instead of sending — grep the log for `verify?token=` to get it during local testing.

To reset local test state: `rm -f server/data.sqlite*; rm -rf server/uploads`.
