# FieldOPS design system — Ribbon

## Product and reference

FieldOPS is for Karachi rice-distribution salespeople and the managers coordinating their visits, routes, orders, and evidence. The interface should make the next task clear while distinguishing work saved on the phone from work confirmed by the office.

The September 2026 user-supplied reference establishes the visual direction: a crimson-to-blush header, warm ivory canvas, rounded white cards, one prominent red summary, a wine-colored next-action card, and charcoal navigation. Its example accounts and figures are not product data.

## Brand identity

The approved identity is the pink/coral ribbon-heart in `apps/mobile/assets/brand/ribbon-heart-master.png`. Both the in-app header and web branding use this exact named master. Do not use the previous blue/yellow grain mark, substitute initials, or regenerate the approved launcher icon.

The mobile launcher icons are already correct and stay separate from in-product logo rendering. The web imports the master as a content-hashed Next asset so it does not depend on copying a monorepo public directory. The old SVG URL redirects to that asset.

## Tokens

| Role | Value | Use |
| --- | --- | --- |
| Ribbon red | `#CB183D` | Primary actions, selected destinations, main summary |
| Blush | `#F8DCE2` | Supporting accents and gentle header fade |
| Warm ivory | `#F6F1ED` | Page canvas |
| Charcoal | `#2D2729` | Body text and navigation |
| Wine | `#541C2A` | Next assigned visit |
| White | `#FFFFFF` | Cards and controls |

Supporting tokens: line `#E9DFDA`, muted text `#75686B`, confirmed green `#248564`, pending amber `#EDB35E`, error `#AA342C`. Status always has text, never color alone.

## Typography

- Web display: Avenir Next Condensed / Avenir Next / Segoe UI Variable Display. Bold, compact headings with restrained negative tracking.
- Web body and utility: Avenir Next / Segoe UI / system sans. Sentence-case labels and tabular figures. Reserve uppercase for short section labels.
- Native: system fonts, 28–34 pt page headings, 19–20 pt sections, readable 12–14 pt supporting copy. Preserve font scaling and let content wrap.

## Layout

```text
WEB
Charcoal rail | Crimson page heading + primary shortcut
              | Date and salesperson filters
              | Red featured total + white summary cards
              | Direct links to routes, reports and orders
              | Assignments / selected management workspace

APP
Ribbon-heart header + refresh + upload status
Page title and date / compact location-ready state
Red assigned-visits card + white completed/new-place cards
Session action / wine next-visit card
Customer visit and order actions
Charcoal icon-and-label navigation above the safe area
```

## Interaction and access

- Preserve all live data, permissions, location gates, visit evidence, and offline queue behavior.
- Keep location problems visible; compress successful location checks into one tappable row.
- Reset the content scroll position when switching app screens.
- Use keyboard avoidance for sign-in and field forms.
- Use at least 44 px touch targets and clear labels for icon-only actions.
- Mobile web navigation collapses behind a labeled menu; include sign-out there.
- Keep keyboard focus visible, tables horizontally scrollable, and motion reduced when requested.
- A recorded order is not a forecast; a queued upload is not server confirmation. Never invent performance trends or decorative metrics.
- Media expires after seven days; visit history remains. Keep expiry and delete consequences explicit.
