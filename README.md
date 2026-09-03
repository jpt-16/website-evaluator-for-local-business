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
| Crawlability | Does `/robots.txt` and/or `/sitemap.xml` exist? Separate from PageSpeed's on-page SEO score, which checks neither. |
| Visual Design | Two layers — see below |
| Site Freshness | Is there a copyright year in the footer, and how stale is it? (2+ years old = failing) |
| Contact Info | Is there a `tel:` link (tap-to-call), a plain phone number in the text, or nothing at all? |
| Reviews & Testimonials | Review/AggregateRating structured data, or a testimonials section in the text |
| Privacy Policy | Is there a link to a privacy policy (or, as a fallback, terms of some kind)? |
| Social Media Presence | Does the page link to Facebook, Instagram, X/Twitter, LinkedIn, TikTok, YouTube, or Yelp? |

### Visual Design: heuristics + a bounded vision check

"Looks old and boring" is a taste judgment, and pattern-matching alone
can't make it — a site can use a custom font, real photos, and a modern
CSS layout and still look cluttered, cramped, or amateurish. This check
has two layers to deal with that honestly instead of pretending a
checklist can score taste:

**Layer 1 (always runs, free, deterministic)** — `heuristicDesignVerdict()`
in `api/analyze.js`. Checks the live rendered DOM for a loaded custom web
font, real photography (real `<img>`s with meaningful dimensions, not
tracking pixels/icons), and a modern flex/grid layout, plus a regex for
literal HTML4-era tags (`<font>`, `<center>`, `<marquee>`, `<blink>` —
deprecated 20+ years, so any hit forces `bad` outright regardless of the
other signals). Needs the live rendered DOM, so like Accessibility/SEO it
falls back to `unknown` rather than a guess if the headless browser
itself failed and the plain-fetch fallback kicked in.

**Layer 2 (only when Layer 1 says `good`)** — `evaluateVisualDesignWithVision()`.
That's specifically the case Layer 1 can get wrong: technically current,
still not actually good-looking. Only there, `renderWithBrowser()` takes a
low-quality JPEG screenshot at a fixed 1280×800 desktop viewport and sends
it to a vision-capable model on [NVIDIA's free build.nvidia.com API]
(https://build.nvidia.com) — `meta/llama-3.2-11b-vision-instruct` by
default, overridable via `DESIGN_VISION_MODEL` — via its OpenAI-compatible
`/v1/chat/completions` endpoint. The prompt asks it to weigh layout
consistency, whitespace, visual hierarchy, image quality, and color
cohesion into one verdict, returned as plain JSON in the response text
(not a forced tool call — reliability of tool-calling on this specific
model via NIM wasn't certain enough to depend on, so this parses `{...}`
out of the text defensively instead and returns `null`, keeping Layer 1's
verdict, on anything malformed). If it disagrees with Layer 1, it wins and
replaces both the status and the description. Bounding it to the `good`
subset keeps the added latency and per-request cost from hitting every
single check — most sites don't pass Layer 1 in the first place.

**Runs concurrently with the PageSpeed check**, not after it —
`evaluateVisualDesignWithVision()` and `runPageSpeedCheck()` are both
kicked off together and awaited with `Promise.all`, since they're
independent of each other and both can be slow. That overlap is what
makes PageSpeed's retry (above) affordable without risking Vercel's 60s
function timeout; running them sequentially could add up to ~35s+ in the
worst case, uncomfortably close to that limit on top of the headless
render itself.

**Requires `NVIDIA_API_KEY`** (Vercel → Settings → Environment Variables)
to do anything — get one free at [build.nvidia.com](https://build.nvidia.com)
(no card, ~1000-5000 one-time credits, never expires). Without it,
`evaluateVisualDesignWithVision()` returns `null` immediately and the
check silently stays at whatever Layer 1 decided — nothing breaks either
way. Same fail-open pattern for a malformed response, an HTTP error, an
oversized screenshot, or a timeout (`VISION_TIMEOUT_MS`, 20s). One thing
worth knowing: NVIDIA's free hosted endpoints reportedly use request data
to help train their models (unlike, say, Anthropic's API, which doesn't
train on API traffic by default) — for screenshots of public business
homepages that's a reasonable tradeoff for "free," but it's worth knowing
going in.

Free NVIDIA credits are a fixed one-time allotment, not a renewing quota
— `checkVisionBudget()` caps Layer 2 to `DESIGN_VISION_MAX_PER_HOUR`
(default 100) calls per rolling hour, counted globally across every IP,
specifically to make that allotment last. `checkVisionRpm()` separately
caps it to 30 calls/minute globally, to stay safely under NVIDIA's own
hard 40/min account-wide limit even under concurrent load. Both fail open
to Layer 1's verdict once exhausted, same as everything else here.

### Reviews & Testimonials, and why this isn't "Google Reviews"

This checks whether the *site itself* shows any review/testimonial
content — `Review`/`AggregateRating` schema (the same markup Google reads
for star ratings in search results), or a plain-text testimonials
section as a fallback. It's deliberately not the same thing as an actual
Google Business Profile rating: there's no reliable free way to verify a
business's real Google star rating from just a domain, and a wrong guess
there would be worse than not showing it. "Best Practices" (Lighthouse's
4th default category) is similarly left out — mostly overlaps with the
SSL check anyway.

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

The overall score is the average of these 13 categories. The checklist
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
run out — `[analyze] PageSpeed Insights attempt 1 of 2 failed for ... —
pagespeed http 429 — "Quota exceeded for quota metric 'Queries' and limit
'Queries per day'"` in the logs. When both attempts fail, **all three**
(Page Speed, Accessibility, SEO) show the same "Not Verified" gray pill —
Page Speed included. It used to quietly substitute a rough local timing
estimate under the same "Failing"/"Good" labels as a real Lighthouse
score, which looked like the tool contradicting itself on an unchanged
site whenever the two disagreed. Being honestly unverified beats a
confident-looking guess that might not match the next run.

`runPageSpeedCheck()` retries once (`PAGESPEED_MAX_ATTEMPTS`) on any
failure — timeout, network error, non-2xx — before giving up to
`unknown`, since PSI has real transient failures under load and a retry
meaningfully cuts how often a site that's actually fine ends up
unverified. This only fits inside Vercel's 60s function timeout because
it now runs concurrently with the Visual Design vision check (see below)
rather than after it — see the "runs concurrently" note there.

### Headless rendering (not just a plain fetch)

`api/analyze.js` renders the target page in a real headless Chromium
(`puppeteer-core` + `@sparticuz/chromium`) instead of just fetching the raw
HTML. This matters because a plain fetch only ever sees what the server
sends on the initial response — any content injected by client-side
JavaScript (very common for footer social icons on Wix/Squarespace/etc.
site builders) would otherwise be invisible to every check that scans the
HTML, most notably Social Media Presence. Visual Design depends on it even
more directly — it reads loaded web fonts, decoded image dimensions, and
computed layout straight off the live DOM (and its vision-check layer
needs an actual screenshot), none of which exist from a plain fetch of
the raw HTML.

If the browser itself fails to launch for any reason (a bundle or runtime
issue on a given deployment), it falls back to a plain fetch automatically
— logged as `[analyze] headless render failed for ... — falling back to
plain fetch`. The tool still works in that degraded mode rather than
breaking outright, just blind to JS-injected content (and Visual Design)
again.

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
  gets a 429 with a friendly message instead of hitting PageSpeed (or the
  vision model) at all.
- **Cache**: a successful result is reused for 10 minutes if the same
  domain is checked again, so refreshing or re-checking the same site
  doesn't burn another PageSpeed call — or another vision call.

Both exist specifically to protect the PageSpeed quota discussed above
from being burned through faster than necessary. The Visual Design vision
check (see above) has its own additional global budget and per-minute cap
on top of these, since unlike PageSpeed it draws down a finite, one-time
free credit allotment rather than a renewing daily quota.

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

### Analytics

Both `index.html` and `report-template.html` load [Vercel Web
Analytics](https://vercel.com/docs/analytics) via the plain-script snippet
(no npm package, since this isn't a bundled app) — a stub `window.va`
queues calls until the real script loads, then `js/report.js` fires
custom events at the three funnel points that actually matter for a lead
magnet:

- `check_started` / `check_completed` / `check_failed` — when a visitor
  runs the live checker, and whether it succeeded.
- `contact_submitted` — when the "Get a Free Mockup" form is actually
  sent, tagged with the business/domain it came from.

**To turn this on**, enable "Web Analytics" for this project in the
Vercel dashboard (Project → Analytics tab) — it's off by default. Once
enabled, both pageviews and these custom events show up in the same
dashboard, no extra deploy needed since the script snippet is already in
the HTML. Nothing is tracked, and no cookies are set, until that toggle
is on.

### Privacy policy

The footer links to `https://jtbuildsco.com/privacy-policy` on both the checker
and curated report pages — there's no separate policy for this tool, it's
expected to live under the main site's policy. That policy should mention
what this tool specifically does that the rest of jtbuildsco.com doesn't:
contact form submissions are processed by FormSubmit.co (a third-party
form-to-email service, see above), the domain someone types in gets
fetched/analyzed server-side and cached briefly (~10 min) rather than
stored permanently, and IP addresses are used briefly for rate-limiting
before being discarded.

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
