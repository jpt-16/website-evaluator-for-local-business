# Website Health Report

A one-page "Website Health Report" — a free lead magnet for JT Builds Co. Sent
to local business owners (landscapers, detailers, plumbers, cleaners) with a
weak or missing website, showing what's wrong in plain English and pointing
to a free mockup as the next step.

## Structure

- `index.html` — the report markup (letter-sized page: header/grade, 6-item
  checklist, "what this is costing you", before/after mockup placeholder,
  footer CTA).
- `css/style.css` — all styling.
- `js/report-data.js` — the per-lead data: business name, town, overall
  score, and a `good` / `warning` / `bad` status for each of the 6 checklist
  categories.
- `js/report.js` — renders `report-data.js` into the page: computes the
  letter grade + color tier from the score, and the icon/pill/color for each
  status.

## Generating a report for a new lead

Edit the values in `js/report-data.js` (or duplicate the whole project per
lead) — no build step required, just open `index.html` in a browser or print
it to PDF.

The checklist category blurbs (the one-line explanations) and the "what this
is costing you" copy are static placeholder text for now. The scores and
statuses are wired for real data (PageSpeed, SSL check, Google Reviews,
etc.) to be plugged in later.
