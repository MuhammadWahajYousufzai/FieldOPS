import ribbonHeart from "../../../mobile/assets/brand/ribbon-heart-master.png";

// Preserve old bookmarks while current surfaces use the content-hashed asset
// bundled by Next. This survives Appwrite's monorepo SSR packaging, too.
export function GET() {
  return new Response(null, {
    status: 308,
    headers: {
      Location: ribbonHeart.src,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
