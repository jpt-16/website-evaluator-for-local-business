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
| Google Reviews | **Not automatically checked.** There's no reliable free way to verify this from a domain alone, and a wrong guess is worse than an honest "not checked" — it's shown as a neutral gray "Not Checked" status instead of green/yellow/red. |

The overall score is the average of the 5 categories that are actually
measured (Reviews is excluded). The checklist descriptions are generated
per-domain based on what was actually found — they're no longer static
placeholder text on this page (the curated `/reports/<slug>` pages still use
static copy, since those are hand-authored).

Optional: set a `PAGESPEED_API_KEY` environment variable in your Vercel
project (Settings → Environment Variables) for a higher-quota Google
PageSpeed Insights key. It works without one at low volume, just less
reliably under load.

### "Here's What It Could Look Like"

The "before" box shows a live screenshot of the domain just checked, via
[thum.io](https://www.thum.io/) (`https://image.thum.io/get/width/500/https://<domain>`)
— a free screenshot-on-demand service, no API key or backend code needed.
If it fails to load (some sites block screenshot crawlers, or the first
capture of a domain can be slow), it falls back to the original striped
placeholder automatically.

The "after" box is a static example of actual JT Builds Co work
(`assets/mockup-after.png`), captioned as an example rather than implying
it's a custom mockup of their specific site — there's no automatic mockup
generation. On the curated `/reports/<slug>` pages, the "before" box also
stays static (`assets/mockup-before.png`), since there's no `domain` field
to key a live screenshot off of.

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
     "reviewsStatus": "good",
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
