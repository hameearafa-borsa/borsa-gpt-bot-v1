"use strict";

const { normalizeArabic, toAsciiDigits } = require("../core/normalization");

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeUnit(value) {
  const unit = normalizeArabic(value || "");
  if (/^(?:بالقطعه|قطعه|piece|per piece)$/.test(unit)) return "بالقطعة";
  if (/^(?:بالكرتونه|كرتونه|carton|case|per carton)$/.test(unit)) return "بالكرتونة";
  return unit || null;
}

function comparableName(value) {
  return normalizeArabic(toAsciiDigits(String(value || "")))
    .replace(/\d+(?:[.,]\d+)?\s*(?:كيلو|كجم|ك|kg|جرام|جم|غرام|g|لتر|ل|liter|ml|مل)(?=\s|$)/giu, " ")
    .replace(/(?:^|\s)ق(?=\s|$)/giu, " ")
    .replace(/(?:^|\s)(?:بالقطعه|بالكرتونه|كرتونه|كرتون|قطعه)(?=\s|$)/giu, " ")
    .replace(/[+|:،,؛()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameNumber(a, b) {
  const left = numberOrNull(a);
  const right = numberOrNull(b);
  if (left == null || right == null) return left === right;
  return Math.abs(left - right) < 0.0005;
}

function getReferencePrice(reference) {
  if (reference.price_kind === "wholesale") {
    return numberOrNull(reference.wholesale_carton_price) ?? numberOrNull(reference.package_sale_price);
  }
  if (reference.price_kind === "retail") {
    return numberOrNull(reference.consumer_price) ?? numberOrNull(reference.package_sale_price);
  }
  return null;
}

function compareReferencePrice(reference, observation) {
  const result = (status, reason, extra = {}) => ({ comparable: status === "comparable", status, reason, ...extra });
  if (!reference || !observation) return result("not_comparable", "missing_record");
  const referenceKind = String(reference.price_kind || "unknown");
  const observationKind = String(observation.price_kind || "unknown");
  if (!["wholesale", "retail"].includes(referenceKind) || referenceKind !== observationKind) {
    return result("not_comparable", "price_kind_mismatch");
  }

  const referenceUnit = normalizeUnit(reference.unit_price_type);
  const observationUnit = normalizeUnit(observation.unit_price_type);
  if (!referenceUnit || !observationUnit || referenceUnit !== observationUnit) {
    return result("not_comparable", "unit_type_mismatch");
  }

  const referenceName = comparableName(reference.product_label || reference.product_text);
  const observationName = comparableName(observation.product_text || observation.product_label);
  if (!referenceName || !observationName || referenceName !== observationName) {
    return result("not_comparable", "product_identity_mismatch", { referenceName, observationName });
  }

  if (!sameNumber(reference.weight_g, observation.weight_g) ||
      !sameNumber(reference.volume_ml, observation.volume_ml)) {
    return result("not_comparable", "size_mismatch");
  }

  // A promotion's extra quantity changes the effective offer. The reference
  // schema does not yet store it as a dedicated column, so do not compare a
  // promotional reference row as if it were the base product.
  if (/[+]\s*\d+(?:[.,]\d+)?\s*(?:كيلو|كجم|ك|جرام|جم|g|kg)/iu.test(String(reference.raw_line || ""))) {
    return result("not_comparable", "reference_offer_needs_structured_metadata");
  }
  if (numberOrNull(observation.offer_extra_weight_g) != null) {
    return result("not_comparable", "observation_offer_mismatch");
  }

  // A carton total is not comparable when one side lacks the carton count.
  const referenceCount = numberOrNull(reference.pack_count);
  const observationCount = numberOrNull(observation.pack_count);
  if (referenceUnit === "بالكرتونة" &&
      (referenceCount == null || observationCount == null || !sameNumber(referenceCount, observationCount))) {
    return result("not_comparable", "carton_count_mismatch_or_unknown");
  }

  const referencePrice = getReferencePrice(reference);
  const observedPrice = numberOrNull(observation.package_sale_price);
  if (referencePrice == null || observedPrice == null || referencePrice <= 0 || observedPrice <= 0) {
    return result("not_comparable", "missing_or_invalid_price");
  }

  const difference = Number((observedPrice - referencePrice).toFixed(2));
  const differencePercent = Number(((difference / referencePrice) * 100).toFixed(2));
  return result("comparable", "matched_product_size_unit_and_price_kind", {
    referencePrice,
    observedPrice,
    difference,
    differencePercent,
    direction: difference > 0 ? "above_reference" : difference < 0 ? "below_reference" : "equal_to_reference"
  });
}

module.exports = { compareReferencePrice, comparableName, normalizeUnit };
