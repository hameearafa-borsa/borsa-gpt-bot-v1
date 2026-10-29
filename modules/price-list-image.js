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
async function renderPriceListImages({ company, items, watermark = "بورصة المنظفات لأصحاب المحلات", month = null, priceType = null, pageSize = 16 }) {
  const rows = (Array.isArray(items) ? items : []).filter(x => x && String(x.product || x.product_label || "").trim() && Number.isFinite(Number(x.package_sale_price)) && Number(x.package_sale_price) > 0);
  if (rows.length < 3) throw new Error("price_list_image_requires_three_valid_products");
  if (rows.length > 100) throw new Error("price_list_image_exceeds_100_products_split_list_first");
  const safePageSize = Math.max(6, Math.min(16, Math.trunc(Number(pageSize) || 16)));
  // Load lazily so parser/static tests can run before native dependencies are installed.
  let sharp;
  try { sharp = require("sharp"); }
  catch (cause) { const error = new Error("sharp_dependency_missing_run_npm_install"); error.code = "SHARP_NOT_INSTALLED"; error.cause = cause; throw error; }
  const pages = splitPages(rows, safePageSize);
  const buffers = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const pageRows = pages[pageIndex];
    const width = 1200, rowHeight = 52, headerHeight = 240, columnHeaderHeight = 42, footerHeight = 85;
    const rowsTop = headerHeight + columnHeaderHeight;
    const height = rowsTop + pageRows.length * rowHeight + footerHeight;
    const rowSvg = pageRows.map((item, i) => {
      const y = rowsTop + i * rowHeight;
      const rawName = String(item.product || item.product_label || "منتج");
      const name = escapeXml(rawName.slice(0, 150));
      const rawCategory = String(item.category || item.section || "");
      const category = escapeXml(rawCategory);
      const variant = String(item.variant || "");
      const size = item.weight_g ? `${item.weight_g} جم` : item.volume_ml ? `${item.volume_ml} مل` : "";
      const productNote = variant && variant !== rawCategory ? escapeXml(variant) : "";
      const packageSize = size && !rawName.includes(size) ? escapeXml(size) : "";
      const unitLabel = item.unit_price_type === "بالقطعة" ? "بالقطعة" : item.unit_price_type === "بالكرتونة" ? "بالكرتونة" : "";
      const fill = i % 2 ? "#f3f7f5" : "#ffffff";
      return `<rect x="36" y="${y}" width="1128" height="${rowHeight-5}" rx="12" fill="${fill}"/><text x="850" y="${y+14}" text-anchor="end" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="12" font-weight="700" fill="#25805e">${category}</text><text x="850" y="${y+32}" text-anchor="end" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="18" font-weight="700" fill="#172b26">${name}</text>${productNote ? `<text x="850" y="${y+45}" text-anchor="end" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="10" fill="#61716b">${productNote}</text>` : ""}<text x="600" y="${y+31}" text-anchor="middle" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="17" font-weight="700" fill="#334e44">${packageSize || "—"}</text><text x="72" y="${y+27}" text-anchor="start" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="21" font-weight="700" fill="#176b50">${escapeXml(priceText(item.package_sale_price))}</text>${unitLabel ? `<text x="72" y="${y+43}" text-anchor="start" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="11" fill="#61716b">${escapeXml(unitLabel)}</text>` : ""}`;
    }).join("");
    const listTitle = `${escapeXml(company || "قائمة المنتجات").slice(0, 100)}`;
    const dateLine = [month ? `الفترة: ${month}` : null, priceType || "أسعار جملة", `صفحة ${pageIndex + 1} من ${pages.length}`].filter(Boolean).map(escapeXml).join(" • ");
    const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#e8efeb"/><rect x="24" y="24" width="1152" height="${height-48}" rx="26" fill="#fff"/><text x="600" y="${Math.round(height/2)}" text-anchor="middle" transform="rotate(-24 600 ${Math.round(height/2)})" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="64" font-weight="700" fill="#124d3b" opacity="0.018">${escapeXml(watermark)}</text><rect x="36" y="36" width="1128" height="${headerHeight-48}" rx="20" fill="#124d3b"/><text x="600" y="82" text-anchor="middle" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="23" fill="#d7eee4">قائمة أسعار • بورصة المنظفات</text><text x="600" y="137" text-anchor="middle" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="39" font-weight="700" fill="#fff">${listTitle}</text><text x="600" y="180" text-anchor="middle" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="21" fill="#d7eee4">${dateLine}</text><text x="600" y="211" text-anchor="middle" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="17" fill="#d7eee4">الأسعار كما وردت في القائمة المرسلة • راجع المصدر قبل إعادة البيع</text><rect x="36" y="${headerHeight}" width="1128" height="${columnHeaderHeight-4}" rx="10" fill="#dce9e2"/><text x="850" y="${headerHeight+26}" text-anchor="end" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="16" font-weight="700" fill="#124d3b">الصنف</text><text x="600" y="${headerHeight+26}" text-anchor="middle" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="16" font-weight="700" fill="#124d3b">العبوة / السعة</text><text x="72" y="${headerHeight+26}" text-anchor="start" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="16" font-weight="700" fill="#124d3b">السعر</text>${rowSvg}<text x="600" y="${height-48}" text-anchor="middle" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="25" font-weight="700" fill="#124d3b">${escapeXml(watermark)}</text><text x="600" y="${height-24}" text-anchor="middle" font-family="Noto Sans Arabic,Noto Naskh Arabic,sans-serif" font-size="14" fill="#61716b">صادرة من قائمة مرسلة للمراجعة — لا تمثل تأكيدًا مستقلًا للأسعار</text></svg>`;
    buffers.push(await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer());
  }
  return buffers;
}
async function renderPriceListImage(options) {
  const images = await renderPriceListImages({ ...options, pageSize: 15 });
  if (images.length > 1) throw new Error("price_list_requires_multiple_images_use_renderPriceListImages");
  return images[0];
}
module.exports = { renderPriceListImage, renderPriceListImages, escapeXml };
