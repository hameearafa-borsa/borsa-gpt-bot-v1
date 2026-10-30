"use strict";
const fs = require("node:fs");
const path = require("node:path");

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
function packageStatus(item) {
  const unit = item.unit_price_type === "بالقطعة" ? "بالقطعة" :
    item.unit_price_type === "بالكرتونة" ? "بالكرتونة" : "غير محدد";
  const size = item.weight_g ? `${item.weight_g} جم` :
    item.volume_ml ? `${item.volume_ml} مل` : "";
  const count = Number(item.pack_count) > 0 ? `${item.pack_count} قطعة` : "";
  return [size, count, unit].filter(Boolean).join(" • ");
}
async function renderPriceListImages({ company, items, watermark = "بورصة المنظفات لأصحاب المحلات", month = null, priceType = null, pageSize = 18, logoPath = null }) {
  const rows = (Array.isArray(items) ? items : []).filter(x => x && String(x.product || x.product_label || "").trim() && Number.isFinite(Number(x.package_sale_price)) && Number(x.package_sale_price) > 0);
  if (rows.length < 3) throw new Error("price_list_image_requires_three_valid_products");
  if (rows.length > 100) throw new Error("price_list_image_exceeds_100_products_split_list_first");
  const safePageSize = Math.max(6, Math.min(22, Math.trunc(Number(pageSize) || 22)));
  let sharp;
  try { sharp = require("sharp"); }
  catch (cause) { const error = new Error("sharp_dependency_missing_run_npm_install"); error.code = "SHARP_NOT_INSTALLED"; error.cause = cause; throw error; }
  const pages = splitPages(rows, safePageSize);
  const brandPath = logoPath || path.join(__dirname, "..", "1793378540373.jpg");
  const brandData = fs.existsSync(brandPath) ? fs.readFileSync(brandPath).toString("base64") : "";
  const brandMime = /\.jpe?g$/i.test(brandPath) ? "image/jpeg" : "image/png";
  const brandUri = brandData ? `data:${brandMime};base64,${brandData}` : "";
  const headerLogo = brandUri ? `<rect x="54" y="55" width="112" height="112" rx="12" fill="#fff"/><image href="${brandUri}" x="58" y="59" width="104" height="104" preserveAspectRatio="xMidYMid meet"/>` : "";
  const buffers = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const pageRows = pages[pageIndex];
    const width = 1200, rowHeight = 48, headerHeight = 246, footerHeight = 85;
    const height = headerHeight + pageRows.length * rowHeight + footerHeight;
    const rowBackgrounds = pageRows.map((item, i) => {
      const y = headerHeight + i * rowHeight;
      const fill = i % 2 ? "#f3f7f5" : "#ffffff";
      return `<rect x="36" y="${y}" width="1128" height="${rowHeight-5}" rx="12" fill="${fill}" fill-opacity="0.88"/>`;
    }).join("");
    const watermarkY = Math.max(headerHeight + 8, Math.round(headerHeight + (pageRows.length * rowHeight - 430) / 2));
    const watermarkLogo = brandUri ? `<image href="${brandUri}" x="375" y="${watermarkY}" width="450" height="430" preserveAspectRatio="xMidYMid meet" opacity="0.10"/>` : "";
    const rowText = pageRows.map((item, i) => {
      const y = headerHeight + i * rowHeight;
      const rawName = String(item.product || item.product_label || "منتج");
      const name = escapeXml(rawName.slice(0, 150));
      const rawCategory = String(item.category || item.section || "");
      const category = escapeXml(rawCategory);
      const variant = String(item.variant || "");
      const size = item.weight_g ? `${item.weight_g} جم` : item.volume_ml ? `${item.volume_ml} مل` : "";
      const details = [variant && variant !== rawCategory ? variant : "", size && !rawName.includes(size) ? size : ""].filter(Boolean).map(escapeXml).join(" — ");
      const status = escapeXml(packageStatus(item));
      return `<text x="1125" y="${y+12}" text-anchor="end" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="12" font-weight="700" fill="#25805e">${category}</text><text x="1125" y="${y+30}" text-anchor="end" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="17" font-weight="700" fill="#172b26">${name}</text><text x="1125" y="${y+43}" text-anchor="end" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="9" fill="#61716b">${escapeXml(details)}</text><text x="390" y="${y+29}" text-anchor="middle" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="15" font-weight="700" fill="#42685a">${status}</text><text x="72" y="${y+29}" text-anchor="start" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="20" font-weight="700" fill="#176b50">${escapeXml(priceText(item.package_sale_price))}</text>`;
    }).join("");
    const listTitle = `${escapeXml(company || "قائمة المنتجات").slice(0, 100)}`;
    const dateLine = [month ? `الفترة: ${month}` : null, priceType || "أسعار جملة", `صفحة ${pageIndex + 1} من ${pages.length}`].filter(Boolean).map(escapeXml).join(" • ");
    const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#e8efeb"/><rect x="24" y="24" width="1152" height="${height-48}" rx="26" fill="#fff"/><rect x="36" y="36" width="1128" height="${headerHeight-48}" rx="20" fill="#124d3b"/>${headerLogo}<text x="600" y="82" text-anchor="middle" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="23" fill="#d7eee4">قائمة أسعار • بورصة المنظفات</text><text x="600" y="137" text-anchor="middle" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="39" font-weight="700" fill="#fff">${listTitle}</text><text x="600" y="180" text-anchor="middle" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="21" fill="#d7eee4">${dateLine}</text><text x="600" y="211" text-anchor="middle" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="17" fill="#d7eee4">الأسعار كما وردت في القائمة المرسلة • راجع المصدر قبل إعادة البيع</text><text x="1125" y="234" text-anchor="end" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="15" font-weight="700" fill="#124d3b">الصنف</text><text x="390" y="234" text-anchor="middle" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="15" font-weight="700" fill="#124d3b">العبوة / السعر</text><text x="72" y="234" text-anchor="start" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="15" font-weight="700" fill="#124d3b">السعر</text>${rowBackgrounds}${watermarkLogo}<text x="600" y="${Math.round(height/2)}" text-anchor="middle" transform="rotate(-24 600 ${Math.round(height/2)})" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="76" font-weight="700" fill="#124d3b" opacity="0.055">${escapeXml(watermark)}</text>${rowText}<text x="600" y="${height-48}" text-anchor="middle" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="25" font-weight="700" fill="#124d3b">${escapeXml(watermark)}</text><text x="600" y="${height-24}" text-anchor="middle" font-family="Noto Sans Arabic UI,Noto Naskh Arabic,sans-serif" font-size="14" fill="#61716b">صادرة من قائمة مرسلة للمراجعة — لا تمثل تأكيدًا مستقلًا للأسعار</text></svg>`;
    buffers.push(await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer());
  }
  return buffers;
}
async function renderPriceListImage(options) {
  const images = await renderPriceListImages({ ...options, pageSize: 16 });
  if (images.length > 1) throw new Error("price_list_requires_multiple_images_use_renderPriceListImages");
  return images[0];
}
module.exports = { renderPriceListImage, renderPriceListImages, escapeXml, packageStatus };
