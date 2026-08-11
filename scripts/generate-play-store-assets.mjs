import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "store-assets");
mkdirSync(output, { recursive: true });

const sharpDirectory = readdirSync(join(root, "node_modules/.pnpm"))
  .find((name) => name.startsWith("sharp@0.35.3"))
  ?? readdirSync(join(root, "node_modules/.pnpm")).find((name) => name.startsWith("sharp@"));
if (!sharpDirectory) throw new Error("The installed Sharp runtime was not found.");
const require = createRequire(import.meta.url);
const sharp = require(join(root, "node_modules/.pnpm", sharpDirectory, "node_modules/sharp"));

const ink = "#17233B";
const field = "#243D74";
const gold = "#D8A629";
const paper = "#F7F8F4";
const line = "#DCE0D8";
const muted = "#697184";
const success = "#267057";
const danger = "#A53B2E";

function logo(x, y, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <path d="M40 2C18 20 8 45 8 69c0 23 13 43 32 57 19-14 32-34 32-57C72 45 62 20 40 2Z" fill="${gold}"/>
    <path d="M40 14c-11 18-16 35-16 53 0 13 5 27 16 41 11-14 16-28 16-41 0-18-5-35-16-53Z" fill="${ink}"/>
    <circle cx="40" cy="88" r="18" fill="${gold}" stroke="${ink}" stroke-width="8"/>
    <circle cx="40" cy="88" r="5" fill="${paper}"/>
  </g>`;
}

function text(x, y, value, size, weight = 600, fill = ink, anchor = "start", family = "Arial, sans-serif") {
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${value}</text>`;
}

function rounded(x, y, width, height, radius, fill, stroke = "none", strokeWidth = 0) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function commonPhone(title, subtitle, body) {
  const titleLines = title.split("|");
  const titleMarkup = titleLines.length === 1
    ? text(540, 216, titleLines[0], 62, 800, "#FFFFFF", "middle", "Georgia, serif")
    : `${text(540, 190, titleLines[0], 57, 800, "#FFFFFF", "middle", "Georgia, serif")}${text(540, 250, titleLines[1], 57, 800, "#FFFFFF", "middle", "Georgia, serif")}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
    <rect width="1080" height="1920" fill="${ink}"/>
    <circle cx="930" cy="155" r="220" fill="#24324E"/>
    <circle cx="102" cy="500" r="150" fill="#24324E"/>
    ${logo(72, 74, 0.62)}
    ${text(144, 119, "FIELDOPS", 31, 900, gold)}
    ${titleMarkup}
    ${text(540, 290, subtitle, 26, 500, "#BAC4D8", "middle")}
    ${rounded(55, 330, 970, 1515, 45, paper)}
    <rect x="475" y="351" width="130" height="8" rx="4" fill="#C8CDC5"/>
    ${body}
  </svg>`;
}

function appHeader(section, pending = "SYNCED") {
  return `${text(105, 425, "FIELDOPS", 22, 900, field)}
    ${text(105, 461, section, 36, 900, ink)}
    ${rounded(825, 405, 145, 48, 24, "#E9F5EF")}
    ${text(897, 436, pending, 17, 900, success, "middle")}`;
}

const screenOne = commonPhone(
  "The field day, clearly managed.",
  "Assignments, access and progress in one calm view.",
  `${appHeader("Today")}
   ${rounded(105, 500, 870, 160, 22, ink)}
   <rect x="105" y="500" width="8" height="160" rx="4" fill="#52B889"/>
   ${text(140, 540, "TODAY · WORK STATUS", 17, 900, "#AAB3C5")}
   ${text(140, 587, "Work in progress", 34, 900, "#FFFFFF")}
   ${text(140, 625, "Route recording every minute", 20, 500, "#BAC4D8")}
   ${rounded(760, 548, 175, 58, 12, gold)}
   ${text(847, 585, "Finish today", 19, 900, ink, "middle")}
   ${text(105, 723, "ASSIGNED COMMITMENTS", 19, 900, muted)}
   <line x1="105" y1="748" x2="975" y2="748" stroke="${line}" stroke-width="2"/>
   ${text(200, 813, "3/6", 43, 900, ink, "middle")}
   ${text(200, 846, "Completed", 18, 700, muted, "middle")}
   ${text(540, 813, "3", 43, 900, ink, "middle")}
   ${text(540, 846, "Still assigned", 18, 700, muted, "middle")}
   ${text(870, 813, "Live", 43, 900, success, "middle")}
   ${text(870, 846, "Route tracking", 18, 700, muted, "middle")}
   <line x1="105" y1="878" x2="975" y2="878" stroke="${line}" stroke-width="2"/>
   ${rounded(105, 930, 870, 300, 24, field)}
   ${text(145, 981, "NEXT ASSIGNED VISIT · 70 M CHECK-IN", 18, 900, "#B6C2DF")}
   ${text(145, 1040, "Al Madina Super Store", 38, 900, "#FFFFFF")}
   ${text(145, 1082, "Bahadurabad, Karachi", 22, 500, "#C2CBE0")}
   ${rounded(145, 1130, 265, 61, 12, gold)}
   ${text(278, 1169, "Start assigned visit", 19, 900, ink, "middle")}
   ${rounded(430, 1130, 235, 61, 12, "none", "#7081A8", 2)}
   ${text(548, 1169, "All assigned visits", 19, 900, "#FFFFFF", "middle")}
   ${rounded(105, 1280, 870, 165, 22, "#E4F2EA", success, 2)}
   ${text(145, 1325, "SALESPERSON-ADDED · 1 TODAY", 17, 900, success)}
   ${text(145, 1375, "Visit another customer", 32, 900, ink)}
   ${text(145, 1413, "GPS, photo and audio are required", 19, 500, "#4F655C")}
   ${text(905, 1375, "Add visit", 19, 900, success, "end")}
   ${rounded(105, 1495, 870, 120, 22, gold)}
   ${text(145, 1542, "QUICK ORDER", 17, 900, "#5F4600")}
   ${text(145, 1582, "Take an order", 29, 900, ink)}
   ${text(915, 1566, "Open", 19, 900, ink, "end")}
   ${rounded(105, 1678, 870, 96, 22, ink)}
   ${text(192, 1737, "Today", 18, 900, gold, "middle")}
   ${text(364, 1737, "Visits", 18, 800, "#AAB3C5", "middle")}
   ${text(538, 1737, "Order", 18, 800, "#AAB3C5", "middle")}
   ${text(712, 1737, "Activity", 18, 800, "#AAB3C5", "middle")}
   ${text(885, 1737, "Profile", 18, 800, "#AAB3C5", "middle")}`,
);

const mapPin = (x, y, label) => `<g><path d="M${x} ${y}c-24 0-43 19-43 43 0 34 43 79 43 79s43-45 43-79c0-24-19-43-43-43Z" fill="${gold}" stroke="${ink}" stroke-width="5"/><circle cx="${x}" cy="${y + 42}" r="13" fill="${ink}"/>${text(x, y + 48, label, 15, 900, "#FFFFFF", "middle")}</g>`;
const screenTwo = commonPhone(
  "Every outlet belongs on the map.",
  "See assigned stops and the territory that controls access.",
  `${appHeader("Today’s visits")}
   ${text(105, 502, "Management assignments stay separate from visits you add.", 20, 500, muted)}
   ${rounded(105, 545, 870, 65, 13, gold)}
   ${text(540, 586, "Add unplanned customer visit", 21, 900, ink, "middle")}
   ${text(105, 667, "ASSIGNED BY MANAGEMENT", 19, 900, muted)}
   ${rounded(105, 700, 870, 610, 22, "#E6ECF8", line, 2)}
   <path d="M150 1180 C280 1040 220 880 380 790 C520 710 680 760 920 840 L920 1175 C720 1240 540 1160 390 1230Z" fill="#C9D6F0"/>
   <path d="M150 1180 C280 1040 220 880 380 790 C520 710 680 760 920 840 L920 1175 C720 1240 540 1160 390 1230Z" fill="none" stroke="${field}" stroke-width="8" stroke-linejoin="round"/>
   <path d="M130 900 C300 930 380 1010 520 990 C690 965 780 860 950 930" fill="none" stroke="#FFFFFF" stroke-width="18"/>
   <path d="M320 710 C360 850 490 910 510 1300" fill="none" stroke="#FFFFFF" stroke-width="13"/>
   ${rounded(140, 735, 280, 76, 16, "#FFFFFF")}
   ${text(166, 770, "TERRITORY", 15, 900, muted)}
   ${text(166, 797, "Karachi Central", 21, 900, ink)}
   ${mapPin(350, 910, "1")}${mapPin(600, 1000, "2")}${mapPin(800, 880, "3")}
   ${rounded(105, 1350, 870, 260, 22, "#FFFFFF", line, 2)}
   ${text(145, 1400, "01", 22, 900, "#9A7A23")}
   ${text(205, 1400, "Al Madina Super Store", 25, 900, ink)}
   ${text(205, 1434, "Bahadurabad · planned", 18, 500, muted)}
   <line x1="145" y1="1472" x2="935" y2="1472" stroke="${line}" stroke-width="2"/>
   ${text(145, 1520, "02", 22, 900, "#9A7A23")}
   ${text(205, 1520, "Hassan General Store", 25, 900, ink)}
   ${text(205, 1554, "PECHS · completed", 18, 500, success)}
   ${rounded(105, 1678, 870, 96, 22, ink)}
   ${text(192, 1737, "Today", 18, 800, "#AAB3C5", "middle")}
   ${text(364, 1737, "Visits", 18, 900, gold, "middle")}
   ${text(538, 1737, "Order", 18, 800, "#AAB3C5", "middle")}
   ${text(712, 1737, "Activity", 18, 800, "#AAB3C5", "middle")}
   ${text(885, 1737, "Profile", 18, 800, "#AAB3C5", "middle")}`,
);

const check = (x, y) => `<circle cx="${x}" cy="${y}" r="22" fill="${success}"/><path d="M${x - 10} ${y}l7 8 15-18" fill="none" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`;
const screenThree = commonPhone(
  "Verified visits, where they happen.",
  "Territory, GPS and evidence rules are visible before action.",
  `${appHeader("Visit evidence")}
   ${text(105, 512, "MANAGEMENT-ASSIGNED VISIT", 18, 900, muted)}
   ${text(105, 560, "Al Madina Super Store", 38, 900, ink)}
   ${text(105, 598, "Bahadurabad, Karachi", 21, 500, muted)}
   ${rounded(105, 648, 870, 126, 22, "#E9F5EF", success, 2)}
   ${check(160, 710)}
   ${text(205, 696, "Inside Karachi Central", 25, 900, success)}
   ${text(205, 731, "Visits and orders are available here.", 19, 500, "#4F655C")}
   ${rounded(105, 820, 870, 210, 22, "#FFFFFF", line, 2)}
   ${text(145, 867, "VISIT STATUS", 17, 900, muted)}
   ${text(145, 920, "Visit in progress", 34, 900, ink)}
   ${text(145, 967, "Checked in within 70 m", 20, 700, success)}
   ${rounded(105, 1070, 870, 129, 22, "#FFF1D0")}
   ${text(145, 1117, "REQUIRED BEFORE FINISHING", 17, 900, "#6C570F")}
   ${text(145, 1157, "Stay nearby and complete both evidence steps.", 21, 600, "#6C570F")}
   ${text(105, 1262, "VISIT OUTCOME", 19, 900, muted)}
   ${rounded(105, 1290, 225, 56, 28, field)}${text(218, 1326, "Order placed", 18, 800, "#FFFFFF", "middle")}
   ${rounded(345, 1290, 250, 56, 28, "#FFFFFF", line, 2)}${text(470, 1326, "Order discussed", 18, 800, ink, "middle")}
   ${rounded(610, 1290, 170, 56, 28, "#FFFFFF", line, 2)}${text(695, 1326, "No order", 18, 800, ink, "middle")}
   ${rounded(105, 1390, 420, 102, 18, "#E9F5EF", success, 2)}${check(158, 1441)}${text(200, 1435, "Photo saved", 22, 900, ink)}${text(200, 1465, "Timestamped evidence", 17, 500, muted)}
   ${rounded(555, 1390, 420, 102, 18, "#E9F5EF", success, 2)}${check(608, 1441)}${text(650, 1435, "Audio saved", 22, 900, ink)}${text(650, 1465, "Visit note attached", 17, 500, muted)}
   ${rounded(105, 1535, 870, 68, 13, gold)}${text(540, 1579, "Finish visit", 21, 900, ink, "middle")}
   ${rounded(105, 1678, 870, 96, 22, ink)}
   ${text(192, 1737, "Today", 18, 800, "#AAB3C5", "middle")}${text(364, 1737, "Visits", 18, 900, gold, "middle")}${text(538, 1737, "Order", 18, 800, "#AAB3C5", "middle")}${text(712, 1737, "Activity", 18, 800, "#AAB3C5", "middle")}${text(885, 1737, "Profile", 18, 800, "#AAB3C5", "middle")}`,
);

const screenFour = commonPhone(
  "Assignments and sales|stay accountable.",
  "Manager-planned work is measured without hiding extra field wins.",
  `${appHeader("Sales activity", "LIVE")}
   ${rounded(105, 510, 870, 250, 22, "#FFFFFF", line, 2)}
   ${text(145, 558, "TODAY’S COMPLETION", 18, 900, muted)}
   ${text(145, 630, "6", 62, 900, ink)}${text(195, 630, "assigned", 22, 700, muted)}
   ${text(508, 630, "2", 62, 900, success)}${text(558, 630, "self-added", 22, 700, muted)}
   <rect x="145" y="687" width="790" height="18" rx="9" fill="#E5E8E2"/><rect x="145" y="687" width="525" height="18" rx="9" fill="${gold}"/>
   ${text(145, 735, "4 of 6 management assignments complete", 18, 700, muted)}
   ${text(105, 825, "TAKE AN ORDER", 19, 900, muted)}
   ${rounded(105, 855, 870, 570, 22, "#FFFFFF", line, 2)}
   ${text(145, 905, "ASSIGNED VISIT · OPTIONAL", 17, 900, muted)}
   ${rounded(145, 935, 238, 52, 26, field)}${text(264, 968, "Al Madina Store", 17, 800, "#FFFFFF", "middle")}
   ${rounded(402, 935, 175, 52, 26, "#FFFFFF", line, 2)}${text(490, 968, "Any customer", 17, 800, ink, "middle")}
   ${text(145, 1040, "CUSTOMER", 17, 900, muted)}
   ${rounded(145, 1062, 790, 60, 12, paper, line, 2)}${text(170, 1100, "Al Madina Super Store", 20, 700, ink)}
   ${text(145, 1170, "PRODUCT", 17, 900, muted)}
   ${rounded(145, 1192, 790, 60, 12, paper, line, 2)}${text(170, 1230, "Yousuf Super Kernel Basmati", 20, 700, ink)}
   ${text(145, 1305, "Order total", 20, 700, muted)}${text(935, 1305, "PKR 22,500", 27, 900, ink, "end")}
   ${rounded(145, 1335, 790, 62, 12, gold)}${text(540, 1375, "Save order", 21, 900, ink, "middle")}
   ${rounded(105, 1475, 870, 145, 22, "#E9F5EF")}
   ${check(160, 1548)}${text(205, 1538, "Saved by the server", 24, 900, success)}
   ${text(205, 1574, "Order, outlet and GPS point are linked.", 19, 500, "#4F655C")}
   ${rounded(105, 1678, 870, 96, 22, ink)}
   ${text(192, 1737, "Today", 18, 800, "#AAB3C5", "middle")}${text(364, 1737, "Visits", 18, 800, "#AAB3C5", "middle")}${text(538, 1737, "Order", 18, 900, gold, "middle")}${text(712, 1737, "Activity", 18, 800, "#AAB3C5", "middle")}${text(885, 1737, "Profile", 18, 800, "#AAB3C5", "middle")}`,
);

const iconData = readFileSync(join(root, "apps/mobile/assets/icon.png")).toString("base64");
const feature = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500" viewBox="0 0 1024 500">
  <rect width="1024" height="500" fill="${ink}"/>
  <circle cx="930" cy="70" r="190" fill="#24324E"/>
  <circle cx="30" cy="480" r="170" fill="#24324E"/>
  <image href="data:image/png;base64,${iconData}" x="76" y="96" width="308" height="308"/>
  ${text(450, 190, "FIELDOPS", 68, 900, gold)}
  ${text(450, 255, "Field sales,", 47, 800, "#FFFFFF", "start", "Georgia, serif")}
  ${text(450, 312, "grounded in place.", 47, 800, "#FFFFFF", "start", "Georgia, serif")}
  ${text(450, 372, "Territories · outlets · verified visits · orders", 23, 600, "#BAC4D8")}
</svg>`;

const assets = {
  "feature-graphic": feature,
  "phone-01-today": screenOne,
  "phone-02-territories": screenTwo,
  "phone-03-verified-visit": screenThree,
  "phone-04-sales": screenFour,
};

for (const [name, svg] of Object.entries(assets)) {
  const svgPath = join(output, `${name}.svg`);
  const pngPath = join(output, `${name}.png`);
  writeFileSync(svgPath, svg);
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(pngPath);
}

await sharp(join(root, "apps/mobile/assets/icon.png"))
  .resize(512, 512, { fit: "cover" })
  .png({ compressionLevel: 9 })
  .toFile(join(output, "app-icon-512.png"));

console.log(`Generated ${Object.keys(assets).length + 1} Play Store assets in ${output}`);
