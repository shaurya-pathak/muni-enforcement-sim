# Muni Enforcement Lab

An interactive 90-day sandbox for comparing mobile fare inspection strategies against route ridership and street geometry. The stop-by-time passenger distribution, repeat rider histories, inspection capacity, and behavior response are modeled assumptions; this project has no event-level Muni payment or inspection data.

## Run locally

```sh
npm install
npm run dev
```

`npm run build` creates a static production build in `dist/`.

## Live demo

The public demo is deployed to GitHub Pages at
https://shaurya-pathak.github.io/muni-enforcement-sim/. Pushes to `main`
rebuild and publish the app through `.github/workflows/deploy-pages.yml`.

## What the model does

- Uses August 2026 average daily route boardings to anchor route demand. It distributes those boardings across GTFS stops and time bins using an illustrative two-peak weekday curve.
- Builds inspector journeys from scheduled GTFS stop times, not a straight-line route interpolation. Each inspector rides two approximately 15-minute intervals through the middle of a busy line, checks riders during two 5-minute windows, alights, and transfers before the next sweep. Transfer time is estimated from stop-to-stop distance at a walking pace plus two minutes. The map markers interpolate between each selected trip's scheduled stop times, and teams are prevented from boarding the same trip at once.
- Generates 50 synthetic frequent riders for each stop, route, and 15-minute cohort. Their initial payment propensities vary around a 50% average.
- Spreads inspection exposure across nearby usual travel times using a configurable normal-shaped time variation; the default standard deviation is 45 minutes.
- Treats each inspection as visible to 25, 40, or 50 riders, according to route volume. The default is one inspector on an eight-hour shift, checking for five minutes every 15 minutes. Each stop visit can check at most `checks per inspector per minute × 5 minutes` riders.
- Raises payment probability by an editable +40 percentage points for riders who witness an inspection and another +8 points for a rider who is personally checked. From the 50% baseline, this means 90% after seeing and 98% after being checked. Each exposure decays exponentially, returning toward the rider's starting propensity; the shared default half-life is 30 days, adjustable to 7 or 90 days.
- Compares four inspection strategies at a staffing level selected by paired 90-day scenarios: distributed exposure, random ride-alongs, best modeled marginal revenue, and pulse-and-rotate. Staffing compares the same coordinated itinerary and rider assumptions with N teams versus N−1, annualizes the incremental fares plus collected fines, and finds the first team whose marginal gross is no greater than its annual cost. The route score remains a heuristic for choosing trips, and results depend on the synthetic behavior and cost assumptions. No-enforcement is the baseline and has no staffing cost.
- Estimates new fare revenue from modeled payment-probability changes times predicted stop/time boardings and the editable per-payment fare assumption. It also estimates citations among checked riders and collected fine revenue, then subtracts the inspector's editable annual cost, prorated across 90 days.
- Separates trips with no new fare due from fare-due trips. The default 20% no-new-fare share and 10% discounted share are editable placeholders because public SFMTA sources report fare-program dollars, not each program's share of trips. No-new-fare trips (for example, eligible free rides, valid passes, or transfers) add no simulated fare revenue and are excluded from citation estimates. Reduced-fare trips remain fare-eligible; their incremental fare revenue is modeled at half fare.

Default inspection inputs are sandbox assumptions: 4 checks per active minute, two 5-minute check windows during an approximately 25-minute ride, a +40 percentage-point visibility response and another +8 points for a personally checked rider, a 30-day effect half-life (adjustable to 7 or 90 days), $60,000 annual cost per inspector, and $2.85 per newly paid ride. The route-variation control samples mostly high-scoring options at its default 15%; 0% always chooses the current highest-scoring option. All teams share a recent-route penalty that decays over time, discouraging teams from converging on the same line while preserving the return score as the main signal. Cross-route memory applies a selected share of an inspection's visibility response (25% by default) to cohorts on other Muni lines serving the same stop. It is localized to shared stops rather than spread citywide, and fades at the selected half-life. Since synthetic riders are not linked across routes, this is an aggregate proxy for route switching, not individual rider tracking. Word-of-mouth is not modeled. Synthetic riders now start around the selected baseline payment chance; their distribution varies symmetrically around that slider value. Rider load per bus is estimated from average route boardings divided by scheduled weekday trips, then adjusted by a synthetic midline load factor and capped at 20–70; there are no per-trip load data in this lab. Scheduled movements use a representative Wednesday (2026-08-26) from the SFMTA GTFS static feed. The retrieved snapshot advertises service from 2026-07-23 through 2026-08-28; this timetable repeats across the 90-day sandbox, so it is neither dated future service nor real-time vehicle tracking. Transfers require enough scheduled time to walk between stops using straight-line distance at 70 meters/minute plus a two-minute buffer. The best modeled return strategy uses an approximate score to rank trips, accounting for estimated exposure at the same stop and nearby time bins. Staffing estimates pair runs with shared itinerary prefixes, so added teams follow the coordinated plan and each marginal value is calculated against the same assumptions. The stronger behavioral settings encode the user's stated intuition that seeing an inspector should make a rider very likely to pay next time, especially after being checked; they are scenario knobs, not Muni measurements. Repeated exposures can raise modeled payment chance to 100%. Citation revenue is estimated from checks where modeled payment chance implies no valid fare, capped by a 5% citation-to-check rate; the fine is $134 and expected collections start at an editable 50%. Repeated checks in the same cohort now use the updated modeled payment chance for each subsequent check that day. The SFMTA fine schedule supports the $134 amount. Recent reporting put citations at about 5% of inspections, while a collection rate for current Muni citations is not available in the model, so 50% is only a scenario input. SFMTA says eligible riders may have citations dismissed by enrolling in free or reduced fare programs. The 90-day comparison subtracts `annual cost × 90 / 365`; its annual run rate scales modeled fares and fine collections to a year and subtracts the full annual cost. These values are assumptions, not Muni cost or behavioral estimates. A Melbourne case-study model provides precedent for examining inspection deterrence and decay; it does not establish these Muni effect sizes or half-life values. SFMTA's 2009 Proof of Payment study describes different inspection modes and verification delays, but does not establish a universal per-minute rate.

FY2025 reported fare revenue ($111.419M) is shown as a separate historical benchmark. It is not inferred from the 50% simulation baseline. The strategy table labels each figure as a 90-day total; the annual run rate beside it scales both modeled fare gains and collected fine revenue, then subtracts the full-year inspector cost. It is an illustrative comparison, not a forecast. Payment probability is used as a proxy for having valid proof of payment at a check; cash, passes, warnings, and fine dismissals are not individually simulated. SFMTA's free-fare programs include youth 18 and under, eligible low-income seniors and people with disabilities, and Access Pass riders. Eligible low-income adults may use Clipper START for a 50% fare discount; low income alone does not mean a rider is exempt. Some senior and disability fares are also discounted. The app links to SFMTA's current program overview. Its no-new-fare and reduced-fare trip-share controls are scenarios, not observed rider shares.

## Data and attribution

- `data/source/muni_ridership_route_month.csv`: SFMTA average daily boardings by route, month, and day of week.
- `data/source/muni_tap_opportunity_data_pass.xlsx`: source notes and illustrative operational assumptions, including visible-audience tiers of 25/40/50 riders per inspection.
- `public/data/muni-map.json`: simplified SFMTA GTFS route/stop geometries joined to the ridership series, plus San Francisco DataSF arterial street centerlines.
- `scripts/build-map-data.py`: rebuilds the compact map JSON from the current GTFS zip, the DataSF arterial GeoJSON, and the ridership CSV.

Current geometry inputs are available from [SFMTA's GTFS feed](https://muni-gtfs.apps.sfmta.com/data/muni_gtfs-current.zip) and [DataSF arterial streets](https://data.sf.gov/-/Arterial-Streets-of-San-Francisco/gnsq-9x5h). The original GTFS archive is not redistributed in this repository. To rebuild, download those two files, then run:

```sh
python3 scripts/build-map-data.py /path/to/muni_gtfs-current.zip /path/to/arterial-streets.geojson
```

Transit geometry is reproduced under SFMTA's limited, revocable data license. The app includes the required attribution and accuracy disclaimer and does not use SFMTA/Muni logos or imply agency endorsement.
