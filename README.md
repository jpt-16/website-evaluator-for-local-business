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
| Social Media Presence | Does the page link to Facebook, Instagram, X/Twitter, LinkedIn, TikTok, YouTube, or Yelp? |

Google Reviews isn't in the checklist at all — there's no reliable free way
to verify that from a domain alone, and a wrong guess (or an always-neutral
"not checked" row) wasn't worth the space.

The overall score is the average of these 5 categories. The checklist
descriptions are generated per-domain based on what was actually found —
they're no longer static placeholder text on this page (the curated
`/reports/<slug>` pages still use static copy, since those are
hand-authored).

Optional: set a `PAGESPEED_API_KEY` environment variable in your Vercel
project (Settings → Environment Variables) for a higher-quota Google
PageSpeed Insights key. It works without one at low volume, just less
reliably under load.

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

## Structure

- `index.html` — the interactive checker page.
- `api/analyze.js` — the serverless function that runs the real checks.
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
(`npm run build`), clean URLs, and a longer timeout on `api/analyze.js` (30s,
to give the PageSpeed check room to run). Just import the repo in Vercel and
deploy.
