"use strict";

const {
  CATALOG_STORES, normalizeText, isRelevantOffer, extractCatalogs,
  selectOneCatalogPerStore
} = require("../modules/catalog-newsletter");
const { fetchStorePage } = require("../modules/catalog-newsletter-scheduler");

function decodeHtml(value) {
  return String(value || "").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&nbsp;|&#160;/gi, " ");
}

function extractStoreProductLinks(html, storeKey, baseUrl) {
  const results = [];
  const pattern = /<a\\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\\s\\S]*?)<\\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    let url;
    try { url = new URL(match[2], baseUrl); } catch { continue; }
    if (url.protocol !== "https:" || url.hostname !== "snapflyer.io" ||
        !/^\\/eg\\/[a-z0-9-]+\\/products\\/\\d+$/i.test(url.pathname)) continue;
    const title = normalizeText(decodeHtml(match[4]));
    if (!title || title.length < 3) continue;
    const end = (match.index || 0) + match[0].length;
    const trailing = normalizeText(decodeHtml(html.slice(end, end + 700).replace(/<a\\b[\\s\\S]*$/i, " ")));
    const priceMatch = trailing.match(/(?:—|-|–)\\s*(\\d{1,5}(?:,\\d{3})*(?:\\.\\d{1,2})?)\\s*(?:EGP|ج\\s*\\.?\\s*م\\.?|جنيه)/i);
    const candidate = { store: storeKey, title, url: url.href, priceHint: priceMatch ? priceMatch[1].replace(/,/g, "") : null };
    if (isRelevantOffer(candidate)) results.push(candidate);
  }
  return [...new Map(results.map(item => [item.url, item])).values()];
}

function extractCatalogSnippetCandidates(html, storeKey, catalogUrl) {
  const results = [];
  const anchors = [...html.matchAll(/<a\\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\\s\\S]*?)<\\/a>/gi)];
  for (let i = 0; i < anchors.length; i++) {
    const match = anchors[i];
    let imageUrl;
    try { imageUrl = new URL(match[2], catalogUrl); } catch { continue; }
    if (imageUrl.protocol !== "https:" || imageUrl.hostname !== "snapflyer.io" ||
        !/^\\/storage\\/flyers\\/eg\\/(?:bim|kazyon|metro-market)\\/[^?#]*\\/snippets\\/snippet_[a-z0-9]+\\.(?:webp|png|jpe?g)$/i.test(imageUrl.pathname)) continue;

    const nextSnippetIndex = anchors.findIndex((candidate, index) => index > i &&
      /\\/snippets\\/snippet_/i.test(candidate[2]));
    const end = nextSnippetIndex >= 0 ? anchors[nextSnippetIndex].index : Math.min(html.length, match.index + 5000);
    const region = html.slice(match.index + match[0].length, end);
    const text = normalizeText(decodeHtml(region));
    const priceMatch = text.match(/(\\d{1,5}(?:,\\d{3})*(?:\\.\\d{1,2})?)\\s*EGP/i);
    const title = text.split(/\\d{1,5}(?:,\\d{3})*(?:\\.\\d{1,2})?\\s*EGP/i)[0]
      .replace(/^(?:Image|صفحة\\s*\\d+)\\s*/i, "").trim();
    const candidate = {
      store: storeKey,
      title: title.slice(0, 180),
      priceHint: priceMatch ? priceMatch[1].replace(/,/g, "") : null,
      snippetUrl: imageUrl.href,
      productUrl: null
    };
    const productLink = region.match(/href=["'](https:\\/\\/snapflyer\\.io\\/eg\\/[a-z0-9-]+\\/products\\/\\d+)["']/i);
    if (productLink) candidate.productUrl = productLink[1];
    if (candidate.title && candidate.priceHint && isRelevantOffer(candidate)) results.push(candidate);
  }
  return [...new Map(results.map(item => [item.snippetUrl, item])).values()];
}

(async () => {
  console.log("Live SnapFlyer catalog-page product discovery diagnostic");
  let storePageLinks = 0;
  let catalogCandidates = 0;
  let linkedCatalogProducts = 0;

  for (const [storeKey, store] of Object.entries(CATALOG_STORES)) {
    const storeHtml = await fetchStorePage(store.url);
    const storeLinks = extractStoreProductLinks(storeHtml, storeKey, store.url);
    storePageLinks += storeLinks.length;

    const editions = selectOneCatalogPerStore(extractCatalogs(storeHtml, storeKey), new Date());
    console.log("\\n=== " + store.name + " (" + storeKey + ") ===");
    console.log("Store-page direct product links: " + storeLinks.length);
    console.log("Current catalog editions discovered: " + editions.length);

    if (!editions.length) {
      console.log("No current catalog page could be selected; product discovery cannot continue for this store.");
      continue;
    }

    for (const edition of editions) {
      console.log("Catalog: " + edition.title + " | " + edition.url);
      const catalogHtml = await fetchStorePage(edition.url);
      const products = extractCatalogSnippetCandidates(catalogHtml, storeKey, edition.url);
      catalogCandidates += products.length;
      linkedCatalogProducts += products.filter(product => product.productUrl).length;
      console.log("Relevant catalog snippet + price candidates: " + products.length);
      console.log("Candidates with individual product URLs: " + products.filter(product => product.productUrl).length);
      for (const product of products.slice(0, 30)) console.log(JSON.stringify(product));
    }
  }

  console.log("\\nLIVE CATALOG PRODUCT DISCOVERY SUMMARY");
  console.log("Store-page direct product links: " + storePageLinks);
  console.log("Catalog snippet + price candidates: " + catalogCandidates);
  console.log("Candidates with individual product URLs: " + linkedCatalogProducts);
  console.log("This is discovery evidence only; candidates are NOT approved for publication.");
})().catch(error => {
  console.error("LIVE CATALOG PRODUCT DISCOVERY DIAGNOSTIC: FAILED");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
