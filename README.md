# Meridian — protocol treasury & TVL intelligence

Live demo: **https://meridian-dashboard-hjbfip1q9kd.qoder.zone**

A single-page analytics dashboard for DeFi protocols: total value locked over time,
chain allocation, pool-level yield with a quality signal, fee and yield generation,
asset composition and deployment footprint.

No build step and no framework. Plain HTML, CSS and ES modules — open `index.html`
or serve the folder statically and it runs.

```bash
npx http-server . -p 8899
```

## Data

Everything is fetched live in the browser from public, CORS-enabled, key-free endpoints.
There are no hardcoded numbers anywhere in this repository: if a request fails, the
panel renders an explicit gap with the endpoint and the reason, rather than a
placeholder value.

| Source | Used for |
| --- | --- |
| `api.llama.fi/protocol/<slug>` | TVL history, chain allocation, stablecoin/borrow composition |
| `api.llama.fi/protocols` | ranking and category peers |
| `api.llama.fi/tvl/<slug>` | fast headline TVL |
| `yields.llama.fi/pools` | pool-level APY, TVL and 30-day means |

Every figure is labelled with its source and a timestamp, and the header carries a
live/partial/error status derived from the actual request outcomes.

## Notes on the engineering

- **First paint does not block on the heavy read.** `/protocol/<slug>` is roughly
  370 KB; the yields table is about 11.6 MB. The dashboard renders from the former and
  fills the pools panel when the latter arrives, with a visible loading state.
- **Stale or missing data never degrades into a guess.** Each request records its own
  fault, and faults surface in the UI instead of being swallowed.
- **A quality signal is computed, not asserted** — it is derived from the spread
  between current and 30-day mean APY in the returned rows, and the derivation is in
  `app.js` where you can read it.

## What this is not

It is not audited, not a security product, and not investment advice. It reads public
aggregate data from DefiLlama; it does not index chains itself, so figures can lag or
differ from a protocol's own dashboard. No endpoint here is guaranteed stable, and
DefiLlama's terms govern reuse of their data.

## Commercial work

This is a self-initiated build, not client deliverable — I have no client history to
link, so the honest proof is that the code is here and the demo is live.

I build two things for a fixed price, paid only after the work is live on your domain:
a rebuilt marketing site, or a live on-chain analytics dashboard wired to your own
contracts and data sources.

Details and scope: **https://built-in-the-open-hjbfip1q9kd.qoder.zone**
