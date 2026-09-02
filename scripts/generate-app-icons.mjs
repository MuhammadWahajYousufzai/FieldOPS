import { createRequire } from "node:module";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const mobile = join(root, "apps/mobile");
const packages = join(root, "node_modules/.pnpm");
const sharpDirectory = readdirSync(packages).find((name) => name.startsWith("sharp@"));
if (!sharpDirectory) throw new Error("The installed Sharp runtime was not found.");
const require = createRequire(import.meta.url);
const sharp = require(join(packages, sharpDirectory, "node_modules/sharp"));

const background = "#F7F7F7";
const master = join(mobile, "assets/brand/ribbon-heart-master.png");
const icon = await sharp(master)
  .resize(1024, 1024)
  .flatten({ background })
  .removeAlpha()
  .png({ compressionLevel: 9 })
  .toBuffer();
writeFileSync(join(mobile, "assets/icon.png"), icon);

// Android masks and moves a 108 dp foreground. Inset the complete artwork
// so its colored edges fit inside the central 66 dp safe circle.
const foreground = await sharp(icon).resize(736, 736).png().toBuffer();
const adaptive = await sharp({
  create: { width: 1024, height: 1024, channels: 3, background },
})
  .composite([{ input: foreground, left: 144, top: 144 }])
  .png({ compressionLevel: 9 })
  .toBuffer();
writeFileSync(join(mobile, "assets/adaptive-icon.png"), adaptive);

const ios = join(mobile, "ios/YousufRiceFieldOps/Images.xcassets/AppIcon.appiconset");
mkdirSync(ios, { recursive: true });
writeFileSync(join(ios, "App-Icon-1024x1024@1x.png"), icon);

const android = join(mobile, "android/app/src/main/res");
for (const [density, scale] of Object.entries({ mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 })) {
  const directory = join(android, `mipmap-${density}`);
  mkdirSync(directory, { recursive: true });
  const size = 48 * scale;
  await sharp(icon).resize(size, size).webp({ lossless: true }).toFile(join(directory, "ic_launcher.webp"));
  const roundMask = Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`);
  await sharp(icon)
    .resize(size, size)
    .composite([{ input: roundMask, blend: "dest-in" }])
    .webp({ lossless: true })
    .toFile(join(directory, "ic_launcher_round.webp"));
  const adaptiveSize = 108 * scale;
  await sharp(adaptive)
    .resize(adaptiveSize, adaptiveSize)
    .webp({ lossless: true })
    .toFile(join(directory, "ic_launcher_foreground.webp"));
}

const store = join(root, "store-assets");
mkdirSync(store, { recursive: true });
await sharp(icon).resize(512, 512).png({ compressionLevel: 9 }).toFile(join(store, "app-icon-512.png"));
console.log("Generated mobile, iOS, Android and store icons from the ribbon heart master.");
