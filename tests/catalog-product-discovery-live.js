"use strict";

const {
  CATALOG_STORES, normalizeText, isRelevantOffer, extractCatalogs,
  selectOneCatalogPerStore
} = require("../modules/catalog-newsletter");
const { fetchStorePage } = require("../modules/catalog-newsletter-scheduler");
const { safeCatalogPageImageUrl, fetchCatalogImage } = require("../modules/catalog-page-ocr");
const { createImageOcr } = require("../modules/image-ocr");

const MAX_SNIPPETS_PER_CATALOG = 25;

function decodeHtml(value) {
  return String(value || "").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&nbsp;|&#160;/gi, " ");
}

function extractStoreProductLinks(html, storeKey, baseUrl) {
  const results = [];
  const pattern = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    let url;
    try { url = new URL(match[2], baseUrl); } catch { continue; }
    if (url.protocol !== "https:" || url.hostname !== "snapflyer.io" ||
        !/^\/eg\/[a-z0-9-]+\/products\/\d+$/i.test(url.pathname)) continue;
    const title = normalizeText(decodeHtml(match[4]));
    if (!title || title.length < 3) continue;
    const end = (match.index || 0) + match[0].length;
    const trailing = normalizeText(decodeHtml(html.slice(end, end + 700).replace(/<a\b[\s\S]*$/i, " ")));
    const priceMatch = trailing.match(/(?:—|-|–)\s*(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:EGP|ج\s*\.?\s*م\.?|جنيه)/i);
    const candidate = { store: storeKey, title, url: url.href, priceHint: priceMatch ? priceMatch[1].replace(/,/g, "") : null };
    if (isRelevantOffer(candidate)) results.push(candidate);
  }
  return [...new Map(results.map(item => [item.url, item])).values()];
}

// SnapFlyer exposes product-card snippet images as standalone linked image URLs.
// The product name and current price are printed inside each image, not reliably
// adjacent to its HTML anchor. Read the image itself instead of guessing a DOM window.
function extractCatalogSnippetImages(html, catalogUrl) {
  const urls = new Set();
  const attrs = /(?:src|data-src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrs)) {
    const safe = safeCatalogPageImageUrl(decodeHtml(match[1]), catalogUrl);
    if (safe && /\/snippets\/snippet_[a-z0-9]+\.(?:webp|png|jpe?g)$/i.test(new URL(safe).pathname)) {
      urls.add(safe);
    }
  }
  return [...urls].slice(0, MAX_SNIPPETS_PER_CATALOG);
}

function parseSnippetOcr(text, storeKey, catalogUrl, imageUrl) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const priceMatch = raw.match(/(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:EGP\b|جنيه|ج\s*\.?\s*م\.?)/i);
  if (!priceMatch) return null;
  const title = raw.replace(priceMatch[0], " ").replace(/\s+/g, " ").trim();
  const candidate = {
    store: storeKey,
    title,
    priceHint: priceMatch[1].replace(/,/g, ""),
    snippetUrl: imageUrl,
    catalogUrl,
    productUrl: null
  };
  return title && isRelevantOffer(candidate) ? candidate : null;
}

(async () => {
  console.log("Live SnapFlyer catalog-page product discovery diagnostic (image-backed)");
  let storePageLinks = 0;
  let catalogCandidates = 0;
  let snippetsScanned = 0;
  let linkedCatalogProducts = 0;
  const ocr = createImageOcr({ timeoutMs: 60000, pageSegmentationMode: "6" });

  for (const [storeKey, store] of Object.entries(CATALOG_STORES)) {
    const storeHtml = await fetchStorePage(store.url);
    const storeLinks = extractStoreProductLinks(storeHtml, storeKey, store.url);
    storePageLinks += storeLinks.length;

    const editions = selectOneCatalogPerStore(extractCatalogs(storeHtml, storeKey), new Date());
    console.log("\n=== " + store.name + " (" + storeKey + ") ===");
    console.log("Store-page direct product links: " + storeLinks.length);
    console.log("Current catalog editions discovered: " + editions.length);

    if (!editions.length) {
      console.log("No current catalog page could be selected; product discovery cannot continue for this store.");
      continue;
    }

    for (const edition of editions) {
      console.log("Catalog: " + edition.title + " | " + edition.url);
      const catalogHtml = await fetchStorePage(edition.url);
      const snippetImages = extractCatalogSnippetImages(catalogHtml, edition.url);
      console.log("Individual product snippet images discovered: " + snippetImages.length);
      const products = [];
      for (const imageUrl of snippetImages) {
        try {
          const image = await fetchCatalogImage(imageUrl, { timeoutMs: 30000 });
          const result = await ocr.extract(image, {
            storeKey,
            catalogUrl: edition.url,
            fingerprint: "live-discovery-" + storeKey + "-" + new URL(edition.url).pathname.split("/").pop(),
            pageNumber: 0,
            snippetUrl: imageUrl
          });
          snippetsScanned++;
          const candidate = parseSnippetOcr(result.text, storeKey, edition.url, imageUrl);
          if (candidate) products.push(candidate);
          else if (result.hasText) {
            console.log("Snippet OCR (not a relevant verified price candidate): " +
              JSON.stringify({ imageUrl, text: result.text.slice(0, 220) }));
          }
        } catch (error) {
          console.log("Snippet OCR failed: " + imageUrl + " | " + String(error?.message || error).slice(0, 180));
        }
      }
      const unique = [...new Map(products.map(item => [item.snippetUrl, item])).values()];
      catalogCandidates += unique.length;
      linkedCatalogProducts += unique.filter(product => product.productUrl).length;
      console.log("Relevant catalog snippet + OCR price candidates: " + unique.length);
      console.log("Candidates with individual product URLs: " + unique.filter(product => product.productUrl).length);
      for (const product of unique) console.log(JSON.stringify(product));
    }
  }

  console.log("\nLIVE CATALOG PRODUCT DISCOVERY SUMMARY");
  console.log("Store-page direct product links: " + storePageLinks);
  console.log("Catalog snippet images OCR-scanned: " + snippetsScanned);
  console.log("Relevant catalog snippet + OCR price candidates: " + catalogCandidates);
  console.log("Candidates with individual product URLs: " + linkedCatalogProducts);
  console.log("Candidates are discovery evidence only; NOT approved for publication.");
})().catch(error => {
  console.error("LIVE CATALOG PRODUCT DISCOVERY DIAGNOSTIC: FAILED");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
