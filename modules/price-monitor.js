"use strict";

const { extractPriceCandidates, commercialMetrics, fingerprint, productIdentityKey, classifyObservationChange, parsePackageType, parseExtraWeight } = require("./price-intelligence");
const { resolve } = require("../core/product-registry");
const { identityKey } = require("./price-review");
const { buildPriceMemory, resolveFromMemory } = require("./price-memory");
const { deterministicList, parseListMetadata } = require("./price-list");

function isOwnMessage({ botUserId, fromId }) { return botUserId != null && String(botUserId) === String(fromId); }
function isBulkPriceList(text) {
  const source = String(text || "").trim();
  if (!source) return false;
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // Small one-line posts stay on the ordinary message path. Very long posts
  // with many explicit prices are still recognized as catalogs below so they
  // cannot be mistaken for one product observation.
  // Count prices anywhere in a row: common Telegram formats put pack counts
  // after the price (e.g. "٤٩٠ج ٤ق"), so an end-anchored match misses them.
  const pricedRows = lines.filter(line => {
    const asciiLine = line.replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
      .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
    return /\d+(?:[.,]\d+)?\s*(?:جنيه|ج|EGP)(?=\s|$)/iu.test(asciiLine) ||
      /(?:جمله|جملة|مستهلك|قطاعي)\s*[:：]?\s*\d+[.,]?\d*/iu.test(asciiLine);
  }).length;
  if (lines.length >= 8 && pricedRows >= 5) return true;

  // Telegram messages may contain a whole catalog pasted as one long paragraph.
  // Detect repeated explicit currency amounts before the single-product monitor sees it.
  const currencyPrices = [...source.matchAll(/(?:^|[\s:|])\d+(?:[.,]\d+)?\s*(?:جنيه|ج|EGP)(?=$|[\s|])/giu)].length;
  const hasCatalogContext = /(?:أسعار|اسعار)\s*(?:شركة|شركه)|(?:قائمة|قائمه)\s*أسعار|(?:جملة|جمله)\s+.{0,40}(?:منتجات|أصناف|اصناف)/iu.test(source) ||
    lines.some(line => /^(?:أسعار|اسعار)\s+[\p{L}][^\n]{1,80}$/iu.test(line));
  // Company price lists often omit the currency marker after every amount (e.g.
  // "صنسيلك 350 مل عرض 76.25"). A clear catalog heading plus many numbered rows
  // is enough to classify the whole message as a catalog, without requiring "جنيه"
  // on every line. Keep the threshold high so ordinary single-product messages pass.
  const numericRows = lines.filter(line => {
    const asciiLine = line.replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
      .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
    return /\d/.test(asciiLine);
  }).length;
  if (hasCatalogContext && lines.length >= 12 && numericRows >= 8) return true;
  return source.length >= 500 && currencyPrices >= 8 && (hasCatalogContext || currencyPrices >= 12);
}

function isEligibleMessage({ chatType, text, isLogChannel, isCommand, ownMessage }) {
  const source = String(text || "").trim();
  if (!["group", "supergroup"].includes(chatType) || isLogChannel || isCommand || ownMessage || !source) return false;
  // Catalogs have their own deterministic parser. Ordinary chat must contain
  // an actual product-price signal; a random number, date, quantity or phone
  // number is never enough to start price observation.
  if (isBulkPriceList(source)) return true;
  const rows = extractPriceCandidates(source);
  if (!rows.length) return false;
  return rows.some(row => {
    const line = String(row.raw_line || "");
    const product = String(row.product_text || "").trim();
    const hasCurrency = /(?:جنيه|ج|ح|EGP)\s*(?:$|[|،,؛;\s])/iu.test(line) ||
      /(?:^|\s)(?:جنيه|ج|ح|EGP)(?=\s|$)/iu.test(line);
    const hasPriceLabel = /(?:سعر|السعر|جمله|جملة|قطاعي|مستهلك|للبيع)/iu.test(line);
    const hasProductSize = /\d+(?:[.,]\d+)?\s*(?:كجم|كيلو|ك|جم|جرام|مل|ملى|لتر|ل|kg|g|ml|l)(?=$|[^\p{L}\p{N}])/iu.test(line);
    const hasProductName = /[\p{L}]{2,}/u.test(product) &&
      !/^(?:سعر|السعر|رقم|فاتوره|فاتورة|الفاتوره|الفاتورة|هاتف|تليفون|موبايل|اتصل|موعد|تاريخ|اليوم|غدا|غداً|وصل|مبروك)(?:\s+(?:سعر|السعر|رقم|فاتوره|فاتورة|الفاتوره|الفاتورة|هاتف|تليفون|موبايل|اتصل|موعد|تاريخ|اليوم|غدا|غداً|وصل|مبروك))*$/iu.test(product);
    const administrativeContext = /(?:رقم\s*(?:الفاتوره|الفاتورة|الهاتف|الموبايل)|فاتوره|فاتورة|رقم\s*الطلب|رقم\s*التحويل|موعد\s*التسليم|الساعه|الساعة|اتصل|تليفون|موبايل)/iu.test(line);
    const numericCount = (line.match(/\d+(?:[.,]\d+)?/gu) || []).length;
    // Currency and price words are not sufficient on their own: require an identifiable
    // product, or an explicit product size plus a separate amount. Administrative numbers
    // are excluded unless the same row contains a product size.
    if (administrativeContext && !hasProductSize) return false;
    return (hasProductSize && numericCount >= 2) || (hasProductName && hasCurrency);
  });
}
async function observe({ pool, message, merchantId = null, registry }) {
  const text = message.text || message.caption || "";
  const bulkCatalog = isBulkPriceList(text);
  let candidates;
  if (bulkCatalog) {
    const metadata = parseListMetadata(text);
    const catalogRows = deterministicList(text);
    candidates = catalogRows.filter(item => item.decision !== "skipped").map(item => {
      const wholesalePrice = item.wholesale_carton_price == null ? null : Number(item.wholesale_carton_price);
      const basePrice = item.package_sale_price == null ? null : Number(item.package_sale_price);
      const hasSeparateWholesale = wholesalePrice != null && Number.isFinite(wholesalePrice) && wholesalePrice > 0;
      const selectedPrice = hasSeparateWholesale ? wholesalePrice : basePrice;
      const declaredWholesale = /جملة|جمله/iu.test(metadata.priceType || "");
      const unitPriceType = item.unit_price_type || null;
      const ambiguous = item.decision !== "accepted" ||
        (hasSeparateWholesale && basePrice != null && Math.abs(basePrice - wholesalePrice) > 0.0001);
      return {
        raw_line: item.raw_line,
        company: item.company || metadata.company || null,
        section: item.category || item.variant || null,
        product_text: item.product || [item.company || metadata.company, item.category, item.weight_g ? String(item.weight_g) + " جم" : null].filter(Boolean).join(" "),
        package_sale_price: selectedPrice,
        listed_base_price: hasSeparateWholesale && basePrice !== wholesalePrice ? basePrice : null,
        explicit_wholesale_label_price: hasSeparateWholesale ? wholesalePrice : null,
        consumer_price: item.consumer_price ?? null,
        price_kind: declaredWholesale || hasSeparateWholesale ? "wholesale" : "wholesale_candidate",
        unit_price_type: unitPriceType,
        weight_g: item.weight_g ?? null,
        volume_ml: item.volume_ml ?? null,
        pack_count: item.pack_count ?? null,
        package_type: item.package_type || parsePackageType(item.raw_line) || null,
        offer_extra_weight_g: parseExtraWeight(item.raw_line),
        confidence: Number(item.confidence) || 0.5,
        needs_review: ambiguous || !unitPriceType,
        trusted_catalog_row: item.decision === "accepted" && !ambiguous && Boolean(unitPriceType),
        price_selection_reason: hasSeparateWholesale ? "deterministic_catalog_explicit_wholesale_column" :
          declaredWholesale ? "deterministic_catalog_declared_wholesale" : "deterministic_catalog_price_unit_requires_review"
      };
    }).filter(row => Number.isFinite(Number(row.package_sale_price)) && Number(row.package_sale_price) > 0 &&
      String(row.product_text || "").trim().length >= 2);
  } else {
    candidates = extractPriceCandidates(text);
  }
  const accepted = [];
  const seen = new Set();
  // Load only accepted, high-confidence history once per source message.
  // Pending observations never teach the resolver.
  let priceMemory = new Map();
  if (pool && candidates.length) {
    const names = [...new Set(candidates.map(row => String(row.product_text || "").trim()).filter(Boolean))];
    if (names.length) {
      const learned = await pool.query(
        `SELECT product_text, price_kind, package_sale_price, confidence, decision,
                weight_g, volume_ml, offer_extra_weight_g, package_type, pack_count,
                unit_price_type, observed_at
         FROM price_observations
         WHERE decision = 'accepted' AND price_kind = 'wholesale' AND confidence >= 0.8
           AND package_sale_price IS NOT NULL
         ORDER BY observed_at DESC, id DESC LIMIT 2000`,
      );
      priceMemory = buildPriceMemory(learned.rows || []);
    }
  }
  // Infer the commercial context from the whole post, not only from the line
  // containing the amount. Sellers often put "جملة" in a heading or on just
  // one line while listing several products. Explicit consumer wording wins.
  const hasExplicitWholesaleContext = /(?:جمله|جملة|كرتونه|كرتونة|فاتوره|فاتورة|تاجر|السعر الصافي بعد الخصم|صافي سعر القطعه|عدد القطع)/iu.test(text);
  const hasExplicitRetailContext = /(?:مستهلك|قطاعي|تجزئه|تجزئة|للمستهلك)/iu.test(text);
  const hasMultiProductContext = candidates.length >= 2 && !hasExplicitRetailContext;
  for (const candidate of candidates) {
    if (candidate.price_kind === "retail") continue;
    const learned = resolveFromMemory(candidate, priceMemory);
    if (learned.matched && learned.resolved) {
      if (candidate.price_kind === "wholesale_candidate" && learned.price_kind === "wholesale") {
        candidate.price_kind = "wholesale";
        candidate.context_inferred_wholesale = true;
      }
      if (!candidate.unit_price_type && learned.unit_price_type) candidate.unit_price_type = learned.unit_price_type;
      if ((candidate.pack_count == null || candidate.pack_count === "") && learned.pack_count != null) {
        candidate.pack_count = learned.pack_count;
        candidate.pack_count_inferred = true;
      }
      candidate.confidence = Math.max(Number(candidate.confidence) || 0, learned.confidence);
      candidate.price_selection_reason = [candidate.price_selection_reason, "resolved_from_accepted_price_memory"].filter(Boolean).join(";");
    }
    if (candidate.price_kind === "wholesale_candidate" &&
        !/(?:مستهلك|قطاعي|تجزئه|تجزئة|للمستهلك)/iu.test(candidate.raw_line || "") &&
        (hasExplicitWholesaleContext || hasMultiProductContext)) {
      candidate.price_kind = "wholesale";
      candidate.context_inferred_wholesale = true;
      candidate.price_selection_reason = [candidate.price_selection_reason, "message_level_wholesale_context"].filter(Boolean).join(";");
      // Context raises the classification quality, but does not by itself
      // approve a never-seen product identity.
      candidate.confidence = Math.max(candidate.confidence || 0, 0.68);
    }
    const match = resolve(candidate.product_text, registry);
    const row = {
      ...candidate,
      ...commercialMetrics(candidate),
      merchant_id: merchantId,
      registry_match: match.matched,
      registry_confidence: match.confidence,
      brand_key: match.brand?.key || null,
    };
    row.product_identity_key = productIdentityKey(row);
    row.memory_evidence_count = learned.evidence_count || 0;
    // An explicitly approved product identity prevents repeat review based on the name alone.
    // Other ambiguities (multiple prices, unknown price kind) still remain pending.
    let previouslyReviewed = false;
    // Reviewer-approved identity memory must apply to registry-matched and
    // unregistered products alike. Otherwise known brands can be sent for review
    // repeatedly even after a reviewer corrected and approved the exact identity.
    if (pool) {
      const known = await pool.query(
        "SELECT 1 FROM reviewed_price_products WHERE identity_key=$1 LIMIT 1",
        [identityKey(row)]
      );
      previouslyReviewed = known.rowCount > 0;
    }
    if (previouslyReviewed && candidate.price_kind === "wholesale_candidate") {
      row.price_kind = "wholesale";
      // product_identity_key includes price_kind; rebuild it after the memory-based
      // promotion or history lookup will keep using the pre-approval candidate key.
      row.product_identity_key = productIdentityKey(row);
      row.context_inferred_wholesale = true;
      row.price_selection_reason = [row.price_selection_reason, "previously_approved_product_identity"].filter(Boolean).join(";");
    }
    // Rows parsed from the two explicitly recognized, pre-interpreted catalog formats
    // have deterministic column semantics and are trusted as complete wholesale observations.
    // Ordinary chat messages still require registry/reviewer evidence as before.
    row.confidence = candidate.trusted_catalog_row
      ? candidate.confidence
      : previouslyReviewed
        ? Math.max(candidate.confidence, 0.9)
        : learned.resolved
          ? Math.max(candidate.confidence, learned.confidence)
          : Math.min(candidate.confidence, match.matched ? 0.98 : 0.45);
    row.decision = !row.needs_review && row.confidence >= 0.8 && row.price_kind === "wholesale" ? "accepted" : "pending";
    const fp = fingerprint(row);
    if (seen.has(fp)) continue;
    seen.add(fp);
    accepted.push(row);
  }

  const savedRows = [];
  if (!pool) return { accepted, saved: 0, savedRows, silent: true };
  for (const row of accepted) {
    const duplicate = await pool.query(
      `SELECT 1 FROM price_observations WHERE source_chat_id=$1 AND source_message_id=$2 AND raw_text=$3 LIMIT 1`,
      [message.chatId || null, message.messageId || null, row.raw_line]
    );
    if (duplicate.rowCount) continue;
    if (row.decision === "accepted") {
      const history = await pool.query(
        `SELECT product_identity_key, brand_key, price_kind, package_sale_price, weight_g, volume_ml,
                pack_count, offer_extra_weight_g, package_type, unit_price_type
         FROM price_observations
         WHERE price_kind=$2 AND decision='accepted'
           AND (product_identity_key=$1 OR (product_identity_key IS NULL AND product_text=$3))
           AND weight_g IS NOT DISTINCT FROM $4
           AND volume_ml IS NOT DISTINCT FROM $5
           AND offer_extra_weight_g IS NOT DISTINCT FROM $6
           AND package_type IS NOT DISTINCT FROM $7
           AND ($8::text IS NULL OR unit_price_type=$8)
         ORDER BY observed_at DESC, id DESC LIMIT 1`,
        [row.product_identity_key, row.price_kind, row.product_text,
          row.weight_g ?? null, row.volume_ml ?? null, row.offer_extra_weight_g ?? null,
          row.package_type ?? null, row.unit_price_type ?? null]
      );
      const previous = history.rows?.[0] || null;
      // If today's post omits carton count, reuse a known count from the same product/size history.
      // Keep the source wording intact and mark the count as inherited; never override an explicit count.
      if ((row.pack_count == null || row.pack_count === "") &&
          row.unit_price_type !== "بالقطعة" &&
          previous?.unit_price_type === "بالكرتونة" &&
          previous?.pack_count != null && Number(previous.pack_count) > 0) {
        row.pack_count = Number(previous.pack_count);
        row.pack_count_inferred = true;
        row.price_selection_reason = [row.price_selection_reason, "pack_count_inherited_from_prior_observation"].filter(Boolean).join(";");
        row.piece_sale_price = row.package_sale_price / row.pack_count;
      }
      row.change_type = classifyObservationChange(previous, row);
    } else {
      row.change_type = null;
    }

    const inserted = await pool.query(
      `INSERT INTO price_observations
       (merchant_id,price_kind,package_sale_price,source_chat_id,source_message_id,source_user_id,raw_text,confidence,
        product_text,weight_g,volume_ml,pack_count,offer_extra_weight_g,decision,brand_key,package_type,product_identity_key,change_type,
        listed_base_price,explicit_wholesale_label_price,price_selection_reason,needs_review,consumer_price,unit_price_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       ON CONFLICT DO NOTHING RETURNING id`,
      [merchantId, row.price_kind, row.package_sale_price, message.chatId || null, message.messageId || null,
       message.userId || null, row.raw_line, row.confidence, row.product_text, row.weight_g, row.volume_ml,
       row.pack_count, row.offer_extra_weight_g, row.decision, row.brand_key, row.package_type,
       row.product_identity_key, row.change_type, row.listed_base_price ?? null,
       row.explicit_wholesale_label_price ?? null, row.price_selection_reason ?? null, Boolean(row.needs_review), row.consumer_price ?? null, row.unit_price_type ?? null]
    );
    // ON CONFLICT DO NOTHING returns no row when another worker already saved this source row.
    if (!inserted.rows?.[0]) continue;
    savedRows.push({ id: inserted.rows[0].id, row });
  }
  return { accepted, saved: savedRows.length, savedRows, silent: true };
}

module.exports = { isOwnMessage, isBulkPriceList, isEligibleMessage, observe };
