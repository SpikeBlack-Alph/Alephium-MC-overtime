# ALPH CMC Rank — live dashboard

Static single-page app + optional Cloudflare Worker backend.

## Files

| File | Role |
|---|---|
| `index.html` | The whole front end. No build step, no dependencies except Google Fonts. |
| `cmc-worker.js` | Cloudflare Worker: CMC proxy (`/live`) + daily rank snapshots in KV (`/history`). |

## Why a backend is required for real CMC data

CoinMarketCap's API cannot be called from a browser:

- no CORS headers on `pro-api.coinmarketcap.com`
- the API key would be readable in the page source

So the page talks to **your** origin, and the Worker holds the key. Without it,
`index.html` falls back to CoinPaprika's public endpoint, which needs no key and
does send CORS headers — but its rank is CoinPaprika's own, not CMC's
(they track different coin universes, so the numbers differ by a few hundred places).

## Wiring the front end to the backend

In `index.html`, top of the `<script>`:

```js
const CONFIG = {
  historyUrl : "https://alph-rank.<you>.workers.dev/history",
  liveUrl    : "https://alph-rank.<you>.workers.dev/live",
  fallback   : "https://api.coinpaprika.com/v1/tickers/alph-alephium",
  refreshMs  : 60000,
  staleMs    : 300000
};
```

Both are optional and independent:

- `liveUrl` empty → live tiles come from CoinPaprika.
- `historyUrl` empty → the chart uses the baked-in `SEED` series.
- `historyUrl` set and reachable → `SEED` is discarded, the curve is real daily CMC data.

Expected payloads:

```jsonc
// GET /live
{ "rank": 1250, "price": 0.0516, "marketCap": 6721852, "change24h": -4.4, "ts": "2026-08-24T09:00:00Z" }

// GET /history
[ { "d": "2026-08-23", "rank": 1248 }, { "d": "2026-08-24", "rank": 1250 } ]
```

## Deploying the Worker

```bash
npm i -g wrangler
wrangler kv namespace create RANK      # copy the id into wrangler.toml
wrangler secret put CMC_KEY
wrangler secret put CRON_TOKEN         # guards the manual /snapshot route
wrangler deploy
```

Cron is set to `7 0 * * *` (00:07 UTC), one CMC call per day for history plus
one cached call per minute for `/live` — well inside the free plan's 10k
monthly credits.

## Refresh behaviour in the page

- Polls `refreshMs` (60 s default), pauses on `visibilitychange` when the tab is
  hidden, refetches immediately on return.
- The status pill shows `Connecting… / Live · 12s ago / Stale · 6m ago / Stored data`.
- A failed fetch never blanks the UI: the last good values stay on screen and the
  pill goes stale, then falls back to the stored series.
- The live rank is merged onto the end of the curve as a "now" point, so the line
  always reaches the current value.

## Backfilling real history

The Worker only starts recording the day you deploy it. CMC's historical
endpoint (`/v2/cryptocurrency/quotes/historical`) is a paid add-on; if you have
it, a one-off script can prime KV with `{d, rank}` rows. Until then, `/history`
returns a short series and the page keeps the reconstruction for older months —
which is why the footnote about approximation stays in place.

## Market-cap all-time high

`MCATH_SEED` holds the known high (`$279M`, Feb 2024). On every poll,
`reconcileATH()` compares it with the live market cap and raises it if exceeded;
the new value is persisted under the `alph.mcath` localStorage key and the tile
flashes. It occupies the fourth stat tile. The **Best rank ever** tile shows the
market cap reached at that rank in parentheses — from `MC_AT_BEST` until
`/history` supplies `mcap` on each row, at which point the real figure is used.

The price all-time high is a normal milestone card and chart flag, like every
other milestone.

## Chart interaction

Period buttons set the base window: **All / 2Y / 1Y**. Zoom and pan work on top
of it and are clamped to the data range, minimum span 45 days.

| Input | Result |
|---|---|
| Wheel / trackpad scroll | Zoom around the cursor |
| Two-finger pinch | Zoom around the pinch midpoint |
| Drag (mouse or one finger) | Pan, past a 4px threshold; scrubs instead when there is nothing to pan into |
| Arrow keys (chart focused) | Pan 15% of the window; `+` / `-` zoom |
| Double-click / double-tap | Reset to the period window |
| `Esc` or **Reset zoom** | Same |

**Why gestures are bound to `#chartBox`, not the SVG.** The SVG is torn down and
rebuilt on every redraw. A pointer capture taken on an element inside it dies
mid-gesture the first time zooming triggers a redraw — which is exactly what
broke pinch on touch. All listeners therefore live on the container, which
survives redraws, and read the current geometry from the module-level `geo`
object that `draw()` publishes. Redraws during a gesture are coalesced to one per
animation frame via `queueView()`.

**`touch-action` is `none` on the chart, not `pan-y`.** With `pan-y` the browser
arbitrates every touch: a press-and-drag that is even slightly diagonal gets
claimed as a page scroll and we receive a `pointercancel` mid-gesture, which is
what made horizontal panning unreliable on phones. `none` hands every touch to
the chart. The mobile chart height was reduced (`min(430, w × 0.86)`) so there is
page left to scroll around it.

At full zoom-out the window already covers the whole dataset, so a horizontal
drag has nowhere to go. Rather than dead-ending, the same gesture falls back to
scrubbing the curve — the tooltip follows the finger.

Below ~13 months of span, the time axis switches from years to months and the
tooltip from month to day precision.

## Theming and i18n

- Theme: `data-theme="dark|light"` on `<html>`; all colours are CSS custom
  properties, and the SVG reads them via `getComputedStyle` at draw time, so a
  theme switch repaints the chart with no reload.
- Language: EN / FR / DE dictionaries in the `T` object. Both preferences persist
  in `localStorage` behind a try/catch (safe in sandboxed iframes).
