# Website Health Report

A one-page "Website Health Report" — a free lead magnet for JT Builds Co. Sent
to local business owners (landscapers, detailers, plumbers, cleaners) with a
weak or missing website, showing what's wrong in plain English and pointing
to a free mockup as the next step.

Deployed on Vercel, each lead gets its own URL: `/reports/<slug>`.

## Structure

- `index.html` — the report markup (letter-sized page: header/grade, 6-item
  checklist, "what this is costing you", before/after mockup placeholder,
  footer CTA). Also serves as a live template you can preview at `/`.
- `css/style.css` — all styling.
- `js/report-data.js` — sample data for previewing `index.html` directly.
- `js/report.js` — renders report data into the page: computes the letter
  grade + color tier from the score, and the icon/pill/color for each status.
- `data/<slug>.json` — one file per lead (business name, town, overall
  score, and a `good` / `warning` / `bad` status for each of the 6
  checklist categories). This is the source of truth for real reports.
- `scripts/build-reports.js` — build step that takes `index.html` as a
  template and generates `reports/<slug>.html` for every `data/<slug>.json`,
  inlining that lead's data. No dependencies, plain Node.

The checklist category blurbs (the one-line explanations) and the "what this
is costing you" copy are shared static placeholder text for now across every
report. The scores and statuses are wired for real data (PageSpeed, SSL
check, Google Reviews, etc.) to be plugged in later — for now, set them by
hand per lead.

## Adding a new lead

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

## Local preview

`reports/` is generated (gitignored) — run the build once to produce it:

```sh
node scripts/build-reports.js
python3 -m http.server 8000   # or any static file server
```

Then open `http://localhost:8000/reports/<slug>.html`, or
`http://localhost:8000/` for the live-editable template.

## Deploying on Vercel

No manual configuration needed — `vercel.json` already sets the build
command (`npm run build`, which runs `scripts/build-reports.js`) and clean
URLs. Just import the repo in Vercel and deploy.
