# Launch TODO — Catch a Beast

Your action items only — things I can't do myself (need your Apple/Render/Resend/domain-registrar accounts, or a physical device/Xcode). Check these off as you go; ask me to update this file any time.

## Branding cleanup (from the rename)

- [x] **Register a new domain** matching "Catch a Beast" — bought catchabeast.com on Namecheap
- [ ] **Verify the new domain in Resend** — all 4 DNS records added (DKIM, SPF x2, DMARC), status currently **Pending** ("Checking DNS"), can take a few hours
- [x] **Update `RESEND_FROM` on Render** — set to `Catch a Beast <noreply@catchabeast.com>` (done ahead of verification finishing — will silently fall back to console-logging codes until Resend shows Verified)
- [x] **Rename the app in App Store Connect** — done

### New from the domain switch — point catchabeast.com at the actual app (optional but planned)
- [ ] Add catchabeast.com as a Custom Domain in Render (Settings → Custom Domains)
- [ ] Add the DNS record(s) Render gives you in Namecheap
- [ ] Confirm `https://catchabeast.com` loads the app before going further
- [ ] Tell me once it's live — I'll update `capacitor.config.json`'s `server.url` and you'll need a fresh Xcode archive after

## iOS build

- [x] **Re-archive and upload a new build in Xcode** — done today (ships the overscroll fix, the rename, and the new "Catch a Beast" app icon)
- [ ] **Check TestFlight processing finished** — App Store Connect → TestFlight tab, build should flip from "Processing" to available
- [ ] **Add yourself as an internal tester** and confirm it installs/opens correctly on your phone via the TestFlight app
- [ ] **Capture App Store screenshots** via the iOS Simulator (I offered to do this for you)

## App Store Connect submission

- [ ] Complete the **App Privacy** "nutrition label" questionnaire
- [ ] Answer the **Export Compliance** question (standard HTTPS, no custom encryption — should be a quick "No")
- [ ] Complete the **age rating** questionnaire
- [ ] Create a **demo account** for Apple's reviewer, with some sample posts so the app isn't empty when they open it
- [ ] Set **pricing** (Free) and the **copyright** line
- [ ] Add **TestFlight internal testers** (instant, no review) — external testers need Apple's beta review first

## Push notifications (new)

- [ ] **Add the "Push Notifications" capability in Xcode** — same place as Sign In with Apple (App target → Signing & Capabilities → + Capability). Also add **Background Modes → Remote notifications** while you're there.
- [ ] **Set APNs env vars on Render**: `APNS_KEY` (paste the full contents of your `AuthKey_WWA2NLBHL7.p8` file), `APNS_KEY_ID=WWA2NLBHL7`, `APNS_TEAM_ID=4WH4BQ6NMC`. Leave `APNS_PRODUCTION` unset/false until you're shipping a real TestFlight/App Store build (not a local Xcode debug run) — then set it to `true`.
- [ ] Re-archive and upload after adding the capability — this needs a fresh native build like Sign In with Apple did.
- [ ] Once on a real device with a TestFlight build, confirm you get an actual push (e.g. have a friend send you a DM or friend request).

## Infrastructure

- [ ] Consider **upgrading Render off the free tier** before real App Store review — the free tier's cold-start delay could make the app look broken to a reviewer testing it cold

## Already running in the background

- Removing the orphaned "The Beast Game" Xcode folder (unused Bluetooth scaffold) — you started this as a background task, no action needed from you
