"use strict";

/**
 * Persist a parsed company price list and its accepted official reference rows.
 * The caller must execute this function inside the existing DB transaction.
 */
async function persistPriceList(client, { message, sourceText, parsedList, rows }) {
  if (!client || typeof client.query !== "function") throw new TypeError("persistPriceList requires a transaction client");
  const accepted = rows.filter(row => row.decision === "accepted");
  const run = await client.query(`INSERT INTO price_list_runs(source_chat_id,source_message_id,raw_text,status,extracted_count,accepted_count,skipped_count)
    VALUES($1,$2,$3,'processed',$4,$5,$6) RETURNING id`,
  [message.chatId, message.messageId, sourceText, rows.length, accepted.length, rows.length - accepted.length]);
  const runId = run.rows[0].id;
  const declaredPriceType = String(parsedList.priceType || "").trim();
  const referencePriceKind = /جملة|جمله/iu.test(declaredPriceType)
    ? "wholesale"
    : /قطاعي|مستهلك|تجزئة/iu.test(declaredPriceType)
      ? "retail"
      : "unknown";
  for (const row of rows) {
    const productLabel = row.product || row.product_text || null;
    const companyLabel = row.company || parsedList.company || null;
    const rawLine = row.raw_line || row.rawLine || null;
    const decision = row.decision || "review";
    await client.query(`INSERT INTO price_list_items(run_id,product_label,variant_label,company_label,weight_g,volume_ml,package_sale_price,wholesale_carton_price,consumer_price,pack_count,confidence,raw_line,decision,unit_price_type,list_price)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [runId, productLabel, row.variant || null, companyLabel, row.weight_g ?? null, row.volume_ml ?? null, row.package_sale_price ?? null, row.wholesale_carton_price ?? null, row.consumer_price ?? null, row.pack_count ?? null, row.confidence ?? null, rawLine, decision, row.unit_price_type || null, row.list_price ?? null]);
    // Keep official company catalog references separate from live group observations.
    if (decision === "accepted") {
      await client.query(`INSERT INTO price_reference_observations
        (run_id,source_kind,company_label,source_period,declared_price_type,price_kind,product_label,variant_label,weight_g,volume_ml,
         package_sale_price,wholesale_carton_price,consumer_price,pack_count,unit_price_type,list_price,confidence,raw_line,decision)
        VALUES($1,'company_catalog',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'accepted')`,
      [runId, companyLabel, parsedList.month || null, declaredPriceType || null, referencePriceKind, productLabel,
       row.variant || null, row.weight_g ?? null, row.volume_ml ?? null, row.package_sale_price ?? null,
       row.wholesale_carton_price ?? null, row.consumer_price ?? null, row.pack_count ?? null,
       row.unit_price_type || null, row.list_price ?? null, row.confidence ?? null, rawLine]);
    }
  }
  return { runId, extracted: rows.length, accepted: accepted.length, referenceKind: referencePriceKind };
}

module.exports = { persistPriceList };
