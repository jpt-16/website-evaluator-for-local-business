# Website Health Report

A "Website Health Report" — a free lead magnet for JT Builds Co. Shows local
business owners (landscapers, detailers, plumbers, cleaners) what's wrong
with their website in plain English, and points to a free mockup as the
next step.

Two ways to get a report, both live on the same Vercel deploy:

1. **Interactive checker** at `/` — type in a domain, get a real report back
   in seconds. This is the self-serve lead magnet: put it on your own site,
   in your email signature, wherever, and let prospects check themselves.
2. **Curated per-lead pages** at `/reports/<slug>` — hand-authored reports
   you build and send directly, e.g. after a manual review, or when you want
   to control exactly what a specific report says.

## How the interactive checker works

`index.html` posts to `api/analyze.js`, a Vercel serverless function that
actually inspects the domain server-side (a browser can't fetch an arbitrary
third-party site directly — CORS blocks it — so this has to happen server-side):

| Category | How it's checked |
|---|---|
| Has a Website | Is the domain reachable and returning a normal HTTP status? |
| Mobile-Friendly | Does the page have a `<meta name="viewport" content="width=device-width">` tag? |
| Page Speed | Google PageSpeed Insights (mobile performance score); falls back to a simple response-time check if PageSpeed is unavailable |
| SSL / Security | Does HTTPS load without error? |
| Accessibility | PageSpeed Insights' accessibility score — same API call as Page Speed, just reading another field from the same response |
| SEO Basics | PageSpeed Insights' SEO score (meta tags, crawlability, etc.) — likewise free from the same call |
| Site Freshness | Is there a copyright year in the footer, and how stale is it? (2+ years old = failing) |
| Contact Info | Is there a `tel:` link (tap-to-call), a plain phone number in the text, or nothing at all? |
| Social Media Presence | Does the page link to Facebook, Instagram, X/Twitter, LinkedIn, TikTok, YouTube, or Yelp? |

Accessibility and SEO piggyback on the same PageSpeed Insights call as Page
Speed — Lighthouse computes all of them together, so there's no extra
network cost. If that call fails entirely, Page Speed falls back to a
timing heuristic, but Accessibility/SEO have no local equivalent, so they
fall back to a distinct `unknown` status ("Not Verified" — a neutral gray
pill, not amber) instead of a guess. This is deliberately different from
a real `warning` verdict: `warning` means we checked and it was mediocre,
`unknown` means we don't know. Conflating the two either overstates
confidence in a guess or makes a real mediocre score look like a fluke.
`unknown` is excluded from the overall score average entirely rather than
being counted as a strike against the site, and won't show up in "What
This Is Costing You" / "What To Fix First" — nothing to rank if we don't
actually know.

Google Reviews isn't in the checklist at all — there's no reliable free way
to verify that from a domain alone, and a wrong guess (or an always-neutral
"not checked" row) wasn't worth the space. "Best Practices" (Lighthouse's
4th default category) is deliberately not surfaced either, to keep the
checklist from growing past 9 rows — mostly overlaps with the SSL check
anyway.

The overall score is the average of these 9 categories. The checklist
descriptions are generated per-domain based on what was actually found —
they're no longer static placeholder text on this page (the curated
`/reports/<slug>` pages still use static copy, since those are
hand-authored).

**Set a `PAGESPEED_API_KEY`** environment variable in your Vercel project
(Settings → Environment Variables) — this isn't optional in practice. Get a
free one at [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
by enabling the "PageSpeed Insights API" on any project. Without a key,
requests use a shared anonymous quota (a global daily cap split across
every unrelated project calling the API without a key) that's confirmed to
run out — `[analyze] PageSpeed Insights failed for ... — pagespeed http
429 — "Quota exceeded for quota metric 'Queries' and limit 'Queries per
day'"` in the logs. When that call fails, Page Speed quietly falls back to
a rough timing estimate (which still looks plausible, so it's easy not to
notice), but Accessibility and SEO have no such fallback, so they show the
same "Not Verified" gray pill for every single site until the key is set.

### Headless rendering (not just a plain fetch)

`api/analyze.js` renders the target page in a real headless Chromium
(`puppeteer-core` + `@sparticuz/chromium`) instead of just fetching the raw
HTML. This matters because a plain fetch only ever sees what the server
sends on the initial response — any content injected by client-side
JavaScript (very common for footer social icons on Wix/Squarespace/etc.
site builders) would otherwise be invisible to every check that scans the
HTML, most notably Social Media Presence.

If the browser itself fails to launch for any reason (a bundle or runtime
issue on a given deployment), it falls back to a plain fetch automatically
— logged as `[analyze] headless render failed for ... — falling back to
plain fetch`. The tool still works in that degraded mode rather than
breaking outright, just blind to JS-injected content again.

This adds real latency (launching a browser + navigating vs. one fetch),
which is why `vercel.json` gives `api/analyze.js` a 60s timeout and 1536MB
of memory — headless Chromium needs meaningfully more of both than a plain
fetch did. If your Vercel plan doesn't support those values, Vercel's
deploy will fail with a clear error naming the limit; lower them to fit.

### Rate limiting + per-domain caching

Both are intentionally simple, in-memory, best-effort — they live in the
function instance's memory, so they reset on cold start and aren't shared
across concurrent instances. That's a real limitation, not a bug: a
determined abuser spread across many cold starts could still get through.
For a lead-magnet tool at normal scale, it meaningfully reduces the common
cases without needing an external store (Redis/Vercel KV) that would add
setup you'd have to configure and pay for.

- **Rate limit**: max 5 requests per IP per 60 seconds; anything past that
  gets a 429 with a friendly message instead of hitting PageSpeed at all.
- **Cache**: a successful result is reused for 10 minutes if the same
  domain is checked again, so refreshing or re-checking the same site
  doesn't burn another PageSpeed call.

Both exist specifically to protect the PageSpeed quota discussed above
from being burned through faster than necessary.

### Business name + location from structured data

`extractStructuredBusiness()` looks for `Organization`/`LocalBusiness`
(and subtypes like `LandscapingBusiness`, `Plumber`, etc. — matched via a
loose "contains 'business'/'organization'/etc." check against `@type`)
JSON-LD structured data before falling back to the `<title>` tag. Title
tags are often noisy ("Home | Best Landscaper in Millbrook | Free
Quotes"), while a site's own structured data (when present) gives a clean
business name and, if an address is included, an actual town/state — shown
in the header as "domain.com · Millbrook, NY" instead of just the domain
alone.

### Shareable report links

After a live check completes, `index.html` gets a "Copy Link" button next
to the grade circle. It base64url-encodes the entire result into the URL
fragment (`#r=...`) — no backend or database — so the link can be pasted
into a text or email and reopening it re-renders that exact snapshot
instead of re-running a fresh check (which could come back differently if
the site changed in between). Fragments never get sent to the server, so
this costs nothing server-side and doesn't touch the rate limit or cache.

### PDF export

The "Download PDF" button (next to "Copy Link" on the checker, or on its
own on curated `/reports/<slug>` pages) just calls `window.print()` —
there's no PDF-generation library, it rides on the print stylesheet that
already existed for physically printing a report. That stylesheet also now
hides the checker's search bar, status messages, and the share/PDF buttons
themselves when printing, so only the report card exports, matching what a
curated page already looked like on paper.

### "What To Fix First"

Below the checklist, `js/report.js` ranks whatever came back `bad` or
`warning` (bad first) into up to 3 short, actionable lines — e.g. "Turn on
HTTPS — browsers flag your site as 'Not Secure' without it." Ranking order
and copy live in `FIX_ORDER`/`FIX_META` in `js/report.js`. If everything's
`good`, it shows a single "nothing urgent" line instead of an empty list.
This runs identically for the interactive checker and the curated pages,
since both feed off the same `*Status` fields.

### 3-step strip

A static "Free report → Free mockup → No pressure" row above the footer,
to lower the friction on clicking the CTA (it's step 2 of 3, not a
commitment). Same markup on both `index.html` and `report-template.html`,
no JS involved.

### Contact form

The "Ready For The Fix?" section (name, email, phone, message) submits to
two places at once, from the browser, in `js/report.js`'s
`initContactForm()`:

1. **[FormSubmit](https://formsubmit.co)** — the actual email delivery, no
   account or API key required. The browser itself POSTs directly to
   `https://formsubmit.co/ajax/jptwohig16@gmail.com`. This has to happen
   client-side rather than from our own server: FormSubmit ties a
   submission to a destination inbox using the request's Origin/Referer
   header, which only exists on a real browser request. A server-to-server
   call (which is what the first version of this did) has no Origin header
   at all, so FormSubmit silently drops it — no error, no activation
   email, nothing.
2. **`api/contact.js`** — fired at the same time, fire-and-forget, purely
   to log the submission server-side (visible in Vercel's function logs)
   as a safety net in case FormSubmit itself is briefly slow or
   unreachable from a visitor's browser. It does not send any email
   itself anymore.

A hidden honeypot field (`company`) catches obvious bots — real visitors
never fill it in; if it's non-empty, the form just shows the "thanks"
message and skips both submissions.

**One-time activation step:** FormSubmit requires the destination inbox to
confirm it wants mail from a given site. The very first real submission
triggers a confirmation email to `jptwohig16@gmail.com` from FormSubmit —
open it and click the activation link once. Every submission after that
goes straight through with no further setup. (Test it once yourself after
deploying so that first "activation" submission doesn't come from an
actual lead.)

The form passes along which business/domain/score prompted the inquiry
(pulled from whatever was last rendered on the page), so a submission
tells you exactly which report it came from without the visitor typing
anything extra. It resets to a fresh, empty form each time a new report
renders, so someone can check multiple sites and submit for each.

### Installable (PWA)

`index.html` links a `manifest.json` plus icons in `icons/` (all generated
from the same navy + lavender checkmark badge used in the checklist itself).
On mobile, "Add to Home Screen" gives it a real icon and opens full-screen,
no browser chrome. This is polish, not a load-bearing feature — it's a
one-or-twice-use tool, not something people install to use daily. The
curated `/reports/<slug>` pages get the matching favicon + theme color for a
consistent tab, but skip the manifest/apple-touch-icon since they aren't the
installable surface.

## Structure

- `index.html` — the interactive checker page.
- `api/analyze.js` — the serverless function that runs the real checks.
- `api/contact.js` — the serverless function behind the contact form.
- `manifest.json` / `icons/` — PWA manifest and icon set for `index.html`.
- `css/style.css` — all styling (shared by the checker and the report card).
- `js/report.js` — shared rendering logic: computes the letter grade + color
  tier from a score, sets each checklist row's icon/pill/description, and
  wires up the checker's search form.
- `report-template.html` — the report-card template used by the *curated*
  pipeline below (not the interactive checker). Includes `js/report-data.js`
  (sample data) so it can also be opened directly in a browser for a quick
  visual preview.
- `data/<slug>.json` / `scripts/build-reports.js` / `reports/<slug>.html` —
  the curated per-lead pipeline (see below), unchanged from before.

## Curated per-lead pages

For a hand-authored report instead of a live check:

1. Add `data/<slug>.json`, e.g. `data/dans-detailing.json`:
   ```json
   {
     "businessName": "Dan's Detailing",
     "town": "Poughkeepsie, NY",
     "preparedDate": "August 6, 2026",
     "overallScore": 78,
     "hasWebsiteStatus": "good",
     "mobileStatus": "warning",
     "speedStatus": "warning",
     "sslStatus": "good",
     "socialStatus": "bad"
   }
   ```
2. Commit and push. Vercel runs the build automatically and the report goes
   live at `https://<your-vercel-domain>/reports/dans-detailing`.

`scripts/build-reports.js` generates `reports/<slug>.html` from
`report-template.html` for every `data/<slug>.json` file.

## Local preview

```sh
npm run build                 # generates reports/ from data/*.json
vercel dev                    # runs both the static files and api/analyze.js locally
```

`vercel dev` (from the [Vercel CLI](https://vercel.com/docs/cli)) is the
easiest way to test the interactive checker locally, since it also serves
`/api/analyze`. A plain static file server (e.g. `python3 -m http.server`)
works fine for previewing `/reports/<slug>.html`, but the interactive
checker at `/` needs the API function running to do anything.

## Deploying on Vercel

No manual configuration needed — `vercel.json` sets the build command
(`npm run build`), clean URLs, and `api/analyze.js`'s timeout (60s) and
memory (1536MB), both bumped up from earlier defaults to give headless
Chromium room to launch and render on top of the PageSpeed call. Just
import the repo in Vercel and deploy — `puppeteer-core` and
`@sparticuz/chromium` are regular `dependencies` in `package.json`, so
Vercel installs them automatically during the build.
