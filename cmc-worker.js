/**
 * ALPH rank backend — Cloudflare Worker
 * ------------------------------------------------------------------
 * Two endpoints consumed by index.html:
 *
 *   GET /live      -> {rank, price, marketCap, change24h, ts}
 *   GET /history   -> [{"d":"2026-08-24","rank":1250}, ...]
 *
 * A cron trigger appends one row per day to KV, so the historical rank
 * series becomes real CMC data instead of a reconstruction. The CMC key
 * never leaves the Worker — the browser cannot call CMC directly
 * (no CORS, and the key would be public).
 *
 * wrangler.toml
 * ------------------------------------------------------------------
 * name = "alph-rank"
 * main = "cmc-worker.js"
 * compatibility_date = "2026-01-01"
 *
 * [[kv_namespaces]]
 * binding = "RANK"
 * id = "<your kv id>"
 *
 * [triggers]
 * crons = ["7 0 * * *"]        # 00:07 UTC daily
 *
 * Secret:  wrangler secret put CMC_KEY
 * Deploy:  wrangler deploy
 * ------------------------------------------------------------------
 */

const CMC = "https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=ALPH&convert=USD";
const KEY_SERIES = "series";
const KEY_CACHE = "live";
const CACHE_TTL = 55; // seconds — CMC basic plans have tight credit limits

const cors = (origin) => ({
  "access-control-allow-origin": origin || "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "accept,content-type",
  "content-type": "application/json; charset=utf-8"
});

async function fetchCMC(env) {
  const res = await fetch(CMC, {
    headers: { "X-CMC_PRO_API_KEY": env.CMC_KEY, accept: "application/json" },
    cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
  });
  if (!res.ok) throw new Error(`CMC ${res.status}`);
  const json = await res.json();
  const d = json?.data?.ALPH;
  const row = Array.isArray(d) ? d[0] : d;
  if (!row) throw new Error("ALPH missing from CMC payload");
  const q = row.quote.USD;
  return {
    rank: row.cmc_rank,
    price: q.price,
    marketCap: q.market_cap,
    change24h: q.percent_change_24h,
    ts: q.last_updated || new Date().toISOString()
  };
}

async function live(env, ctx) {
  const cached = await env.RANK.get(KEY_CACHE, "json");
  if (cached && Date.now() - Date.parse(cached.ts) < CACHE_TTL * 1000) return cached;
  const fresh = await fetchCMC(env);
  ctx.waitUntil(env.RANK.put(KEY_CACHE, JSON.stringify(fresh), { expirationTtl: 300 }));
  return fresh;
}

async function snapshot(env) {
  const now = await fetchCMC(env);
  const series = (await env.RANK.get(KEY_SERIES, "json")) || [];
  const day = now.ts.slice(0, 10);
  const i = series.findIndex((r) => r.d === day);
  const row = { d: day, rank: now.rank, mcap: Math.round(now.marketCap) };
  if (i >= 0) series[i] = row;
  else series.push(row);
  series.sort((a, b) => (a.d < b.d ? -1 : 1));
  await env.RANK.put(KEY_SERIES, JSON.stringify(series));
  return series.length;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");
    const h = cors(origin);

    if (req.method === "OPTIONS") return new Response(null, { headers: h });

    try {
      if (url.pathname === "/live") {
        const data = await live(env, ctx);
        return new Response(JSON.stringify(data), {
          headers: { ...h, "cache-control": "public, max-age=30" }
        });
      }

      if (url.pathname === "/history") {
        const series = (await env.RANK.get(KEY_SERIES, "json")) || [];
        return new Response(JSON.stringify(series), {
          headers: { ...h, "cache-control": "public, max-age=600" }
        });
      }

      // Manual backfill / smoke test:  GET /snapshot?token=<CRON_TOKEN>
      if (url.pathname === "/snapshot" && url.searchParams.get("token") === env.CRON_TOKEN) {
        const n = await snapshot(env);
        return new Response(JSON.stringify({ ok: true, points: n }), { headers: h });
      }

      return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: h });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err.message || err) }), {
        status: 502,
        headers: h
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(snapshot(env));
  }
};
