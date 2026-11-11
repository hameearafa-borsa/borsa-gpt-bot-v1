"use strict";

// Anonymous, direct HTTP diagnostics for public retailer pages.
// No ScraperAPI credentials, database, Telegram, or publishing are used.
const targets = [
  { source: "noon", kind: "daily-deals", url: "https://www.noon.com/egypt-ar/daily-deals-eg/" },
  { source: "noon", kind: "arabic-search", url: "https://www.noon.com/egypt-ar/search/?q=" + encodeURIComponent("مسحوق غسيل") },
  { source: "metro", kind: "storefront", url: "https://shop.metro-markets.com/" },
  { source: "metro", kind: "promotions", url: "https://shop.metro-markets.com/promotions" },
  { source: "carrefour", kind: "official-offers", url: "https://www.carrefouregypt.com/mafegy/ar/c/promo-exclusive-online-offers" }
];

function summarizeHtml(html) {
  const title = (html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i)?.[1] || "")
    .replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ").trim().slice(0, 160);
  const jsonScripts = [...html.matchAll(/<script\\b([^>]*)>/gi)]
    .filter(match => /application\\/(?:ld\\+json|json)/i.test(match[1]) ||
      /(?:__NEXT_DATA__|__NUXT__|INITIAL_STATE|APOLLO_STATE)/i.test(match[1])).length;
  const productMarkers = (html.match(/product[-_ ]?(?:card|item|tile)|data-testid=["'][^"']*product|class=["'][^"']*\\bprd\\b/gi) || []).length;
  const priceSignals = (html.match(/(?:EGP|LE|ج\\.?م|جنيه)\\s*[0-9٠-٩]|[0-9٠-٩][0-9٠-٩,.]*\\s*(?:EGP|LE|ج\\.?م|جنيه)/gi) || []).length;
  const arabicCharacters = (html.match(/[\\u0600-\\u06FF]/g) || []).length;
  const offerSignals = (html.match(/offer|promotion|deal|discount|عروض|خصم|تخفيض/gi) || []).length;
  const productLinks = (html.match(/href=["'][^"']*(?:\\/product|\\/p\\/|\\/dp\\/)[^"']*["']/gi) || []).length;
  return { title, htmlBytes: Buffer.byteLength(html), arabicCharacters, jsonOrHydrationScripts: jsonScripts, productCardMarkers: productMarkers, priceSignals, offerSignals, productLinks };
}

(async () => {
  console.log("DIRECT RETAILER FETCH DIAGNOSTIC — no credentials, no publishing");
  const results = [];
  for (const target of targets) {
    const startedAt = Date.now();
    try {
      const response = await fetch(target.url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
        headers: {
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "ar-EG,ar;q=0.9,en;q=0.7",
          "user-agent": "BorsaPublicOffersDiagnostic/1.0"
        }
      });
      const html = await response.text();
      const finalHost = (() => { try { return new URL(response.url).hostname; } catch { return ""; } })();
      const row = {
        source: target.source,
        test: target.kind,
        requestedHost: new URL(target.url).hostname,
        finalHost,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type") || "",
        elapsedMs: Date.now() - startedAt,
        ...summarizeHtml(html)
      };
      results.push(row);
      console.log(JSON.stringify(row));
    } catch (error) {
      const row = {
        source: target.source,
        test: target.kind,
        requestedHost: new URL(target.url).hostname,
        networkError: String(error && error.name || "Error"),
        message: String(error && error.message || error).slice(0, 180),
        elapsedMs: Date.now() - startedAt
      };
      results.push(row);
      console.log(JSON.stringify(row));
    }
  }
  console.log("\\nDIRECT FETCH SUMMARY");
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    requests: results.length,
    completedHttpResponses: results.filter(row => Number.isInteger(row.status)).length,
    successfulHttpResponses: results.filter(row => row.ok === true).length,
    results
  }, null, 2));
  // This is a diagnostic, not a source-availability gate: HTTP blocks are results to inspect.
})().catch(error => {
  console.error("DIRECT_FETCH_DIAGNOSTIC_FAILED:", String(error && error.message || error).slice(0, 300));
  process.exitCode = 1;
});
