"use strict";
const assert = require("node:assert/strict");
const { inspectMessage } = require("../modules/protection");
const { deterministicList, isListLike } = require("../modules/price-list");
const { distributeDeals, buildNewsletter } = require("../modules/deal-publication");
const { buildWeatherSearch } = require("../modules/weather");

const pearl = `أسعار بيرل – أكتوبر
..... أوتوماتيك
• 9 ك: 505.31 | جملة 487.40 | مستهلك 525
• 5 ك: 308.43 | جملة 915.87 | مستهلك 325
• 2.5 ك: 179.15 | جملة 716.63 | مستهلك 200
..... أوزان وشكاير
• شكارة 10 ك: 618.35 | مستهلك 630
• شكارة 7 ك: 432.84 | مستهلك 450
• 2 ك: 129.22 | جملة 516.90 | مستهلك 145
• 1.5 ك: 98.96 | جملة 395.85 | مستهلك 110
• 1 ك: 66.28 | جملة 265.15 | مستهلك 75
.. العبوات الصغيرة
• 290 جم: 22.03 | جملة 176.29 | مستهلك 25
• 160 جم: 12 | جملة 144.06 | مستهلك 15
• 120 جم: 8.46 | جملة 135.49 | مستهلك 10
• 50 جم: 3.96 | جملة 47.52 | مستهلك 5
• 30 جم: 3.79 | جملة 75.95 | مستهلك 5`;
assert.equal(isListLike(pearl), true);
const rows = deterministicList(pearl);
assert.equal(rows.length, 13, "Pearl parser must keep all 13 priced lines");
assert.ok(rows.every(r => r.product && !/^\d+(?:\.\d+)?$/.test(r.product)), "numeric-only product identity is forbidden");
assert.equal(rows[0].package_sale_price, 505.31);
assert.equal(rows[0].wholesale_carton_price, 487.4);
assert.equal(rows[0].consumer_price, 525);
assert.match(rows[0].product, /بيرل/);
assert.ok(rows.some(r => /شكارة/.test(r.raw_line)), "package type stays in raw source");
const ariel = deterministicList(`أريال ٢ك يدوي ٤٩٠ج ٤ق\nأريال ١ك يدوي ٣٩٦ج ٦ق\nأريال ١.٥ك يدوي ٣٨٠ج ٤ق\nأريال ٢.٥ك اتوماتيك ٨٢٨ج ٤ق\nأريال ٤ك اتوماتيك ٧٨٦ج ٣ق\nأريال ٩ك ١٠١٠ج ٢ق\nبونكس ٩ك ٨٠٠ج ٢ق\nتايد ٢،٥ك ٦٧٢ج ٤ق\nتايد ٩ك ٤٩٠ج ٢ق\nفي برضو ب٥ج ب١٠ج ب٢٥ج`);
assert.ok(ariel.length >= 9, "Ariel/Bonux/Tide lines should be retained for review or acceptance");
assert.equal(ariel[0].pack_count, 4);
assert.equal(ariel[0].package_sale_price, 490);
const protection = inspectMessage({text:"اربح مجانا اضغط هنا الآن"});
assert.equal(protection.allowed, false);
assert.equal(inspectMessage({text:"سعر مسحوق بيرل 25 جنيه"}).allowed, true);
const deals = distributeDeals([
 {merchant:"Amazon",title:"مسحوق منظف 1",url:"https://www.amazon.eg/dp/example1",price:100,old_price:150,discount_pct:33,category:"detergent",verified_url:true},
 {merchant:"Shop",title:"مناديل ورقية",url:"https://example.com/paper",price:20,old_price:30,discount_pct:33,category:"paper",verified_url:true},
 {merchant:"Shop",title:"شامبو عناية",url:"https://example.com/care",price:50,old_price:70,discount_pct:28,category:"personal_care",verified_url:true},
 {merchant:"Shop",title:"هاتف",url:"https://example.com/phone",price:50,discount_pct:10,category:"electronics"}
]);
assert.equal(deals.total,3);
assert.equal(buildNewsletter([deals.detergent[0]],"عروض أمازون").includes("https://www.amazon.eg/dp/example1"),true);
assert.match(buildWeatherSearch("الجيزة"), /^https:\/\/www\.google\.com\/search\?/);
console.log("legacy services + Pearl/Ariel regression tests: OK");
