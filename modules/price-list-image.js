"use strict";

function escapeXml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}
function priceText(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} ج.م` : "—";
}
function splitPages(rows, pageSize) {
  const pages = [];
  for (let i = 0; i < rows.length; i += pageSize) pages.push(rows.slice(i, i + pageSize));
  return pages;
}
async function renderPriceListImages({ company, items, watermark = "بورصة المنظفات لأصحاب المحلات", month = null, priceType = null, pageSize = 14 }) {
  const rows = (Array.isArray(items) ? items : []).filter(x => x && String(x.product || x.product_label || "").trim() && Number.isFinite(Number(x.package_sale_price)) && Number(x.package_sale_price) > 0);
  if (rows.length < 3) throw new Error("price_list_image_requires_three_valid_products");
  if (rows.length > 80) throw new Error("price_list_image_exceeds_80_products_split_list_first");
  const safePageSize = Math.max(6, Math.min(16, Math.trunc(Number(pageSize) || 14)));
  // Load lazily so parser/static tests can run before native dependencies are installed.
  let sharp;
  try { sharp = require("sharp"); }
  catch (cause) { const error = new Error("sharp_dependency_missing_run_npm_install"); error.code = "SHARP_NOT_INSTALLED"; error.cause = cause; throw error; }
  const pages = splitPages(rows, safePageSize);
  const buffers = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const pageRows = pages[pageIndex];
    const width = 1200, rowHeight = 63, headerHeight = 210, footerHeight = 100;
    const height = headerHeight + pageRows.length * rowHeight + footerHeight;
    const rowSvg = pageRows.map((item, i) => {
      const y = headerHeight + i * rowHeight;
      const rawName = String(item.product || item.product_label || "منتج");
      const name = escapeXml(rawName).slice(0, 150);
      const rawCategory = String(item.category || item.section || "");
      const category = escapeXml(rawCategory);
      const variant = String(item.variant || "");
      const size = item.weight_g ? `${item.weight_g} جم` : item.volume_ml ? `${item.volume_ml} مل` : "";
      const details = [variant && variant !== rawCategory ? variant : "", size && !rawName.includes(size) ? size : ""].filter(Boolean).map(escapeXml).join(" • ");
      const unitLabel = item.unit_price_type === "بالقطعة" ? "بالقطعة" : "";
      const fill = i % 2 ? "#f3f7f5" : "#ffffff";
      return `<rect x="36" y="${y}" width="1128" height="${rowHeight-5}" rx="12" fill="${fill}"/><text x="1125" y="${y+23}" text-anchor="end" font-family="Tahoma,Arial,sans-serif" font-size="16" font-weight="700" fill="#25805e">${category}${unitLabel ? ` • ${escapeXml(unitLabel)}` : ""}</text><text x="1125" y="${y+43}" text-anchor="end" font-family="Tahoma,Arial,sans-serif" font-size="22" font-weight="700" fill="#172b26">${name}</text><text x="1125" y="${y+57}" text-anchor="end" font-family="Tahoma,Arial,sans-serif" font-size="13" fill="#61716b">${escapeXml([details].filter(Boolean).join(" "))}</text><text x="72" y="${y+43}" text-anchor="start" font-family="Tahoma,Arial,sans-serif" font-size="25" font-weight="700" fill="#176b50">${escapeXml(priceText(item.package_sale_price))}</text>`;
    }).join("");
    const listTitle = `${escapeXml(company || "قائمة المنتجات").slice(0, 100)}`;
    const dateLine = [month ? `الفترة: ${month}` : null, priceType || "أسعار جملة", `صفحة ${pageIndex + 1} من ${pages.length}`].filter(Boolean).map(escapeXml).join(" • ");
    const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#e8efeb"/><rect x="24" y="24" width="1152" height="${height-48}" rx="26" fill="#fff"/><text x="600" y="${Math.round(height/2)}" text-anchor="middle" transform="rotate(-24 600 ${Math.round(height/2)})" font-family="Tahoma,Arial,sans-serif" font-size="76" font-weight="700" fill="#124d3b" opacity="0.055">${escapeXml(watermark)}</text><rect x="36" y="36" width="1128" height="${headerHeight-48}" rx="20" fill="#124d3b"/><text x="600" y="82" text-anchor="middle" font-family="Tahoma,Arial,sans-serif" font-size="23" fill="#d7eee4">قائمة أسعار • بورصة المنظفات</text><text x="600" y="137" text-anchor="middle" font-family="Tahoma,Arial,sans-serif" font-size="39" font-weight="700" fill="#fff">${listTitle}</text><text x="600" y="180" text-anchor="middle" font-family="Tahoma,Arial,sans-serif" font-size="21" fill="#d7eee4">${dateLine}</text><text x="600" y="211" text-anchor="middle" font-family="Tahoma,Arial,sans-serif" font-size="17" fill="#d7eee4">الأسعار كما وردت في القائمة المرسلة • راجع المصدر قبل إعادة البيع</text>${rowSvg}<text x="600" y="${height-55}" text-anchor="middle" font-family="Tahoma,Arial,sans-serif" font-size="25" font-weight="700" fill="#124d3b">${escapeXml(watermark)}</text><text x="600" y="${height-28}" text-anchor="middle" font-family="Tahoma,Arial,sans-serif" font-size="14" fill="#61716b">صادرة من قائمة مرسلة للمراجعة — لا تمثل تأكيدًا مستقلًا للأسعار</text></svg>`;
    buffers.push(await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer());
  }
  return buffers;
}
async function renderPriceListImage(options) {
  const images = await renderPriceListImages({ ...options, pageSize: 16 });
  if (images.length > 1) throw new Error("price_list_requires_multiple_images_use_renderPriceListImages");
  return images[0];
}
module.exports = { renderPriceListImage, renderPriceListImages, escapeXml };
