# FieldOPS design system — Sunlit Route

## Product ground

**Subject:** Karachi rice-distribution field operations.

**Audience:** sales representatives working outdoors on intermittent connections, plus managers coordinating verified visits, routes, outlets, and evidence.

**Single system job:** make it immediately clear what is live, what needs action, and what has been safely recorded.

## Visual idea

FieldOPS should feel like a crisp dispatch instrument under bright daylight—not a generic SaaS admin template. The grain-and-map-pin mark carries a coral route through its center, connecting the product's three truths: rice, place, and movement.

The deliberate aesthetic risk is a high-energy cyan, yellow, mint, and coral mark against route navy. It improves recognition in outdoor glare and gives the product a specific identity. The rest of the interface remains quiet, structured, and information-first.

## Core tokens

| Token | Hex | Job |
|---|---|---|
| Route navy | `#102A58` | Navigation, deep surfaces, primary text |
| Signal blue | `#5269FF` | Primary actions and active routes |
| Signal sky | `#1FC7FF` | Live state and focus accents |
| Rice sun | `#FFC938` | Pending work and the crop identity |
| Field mint | `#21B985` | Confirmed, safe, synchronized states |
| Paper sky | `#F5F7FF` | Quiet canvas |

Clay red remains a semantic exception for destructive or blocking states; it is not part of the decorative palette.

## Type roles

- **Display:** platform rounded display stack, used for page and card titles with tight spacing.
- **Body:** Avenir Next / Segoe UI variable / platform sans, optimized for long operational copy.
- **Utility:** SF Mono / Cascadia Code / Roboto Mono, used sparingly for dates, status eyebrows, and data labels.

Mobile follows the same hierarchy with native system fonts, heavier display weights, and utility letter spacing so Dynamic Type and Android scaling remain reliable.

## Layout language

```text
WEB
┌── dispatch rail ──┬── page job / immediate action ──────────┐
│ bright mark       │  quiet title card with route spine       │
│ monitor           ├───────────────────────────────────────────┤
│ manage            │  the one operational workspace           │
│ system            │  tables, maps, review cards, controls     │
│ signed-in state   │                                           │
└───────────────────┴───────────────────────────────────────────┘

MOBILE
┌── brand + sync signal ────────────────────────────────────────┐
│ current work access                                           │
│ one dominant next action                                      │
│ supporting tasks and evidence steps                           │
├── Today | Visits | Sales | Activity | Profile ────────────────┤
└────────────────────────────────────────────────────────────────┘
```

## Component rules

- Page titles live in a bordered white job card with one slim route-color spine.
- The web rail is the dispatch board; the selected destination becomes a bright white route card.
- Cards use 20–24 px radii, cool blue-gray borders, and low navy shadows.
- Primary actions use Signal blue. Pending is Rice sun; confirmed is Field mint; delete is clay red.
- Buttons preserve their width while busy and disable only the action in flight.
- Status labels state what happened or what the person can do next.
- No decorative metric bento grids, invented forecasts, emoji icons, or ornamental numbering.
- Media screens always show the seven-day expiry and explain that visit history remains after media deletion.

## Motion and access

- Use one subtle page-entry transition and restrained hover/focus feedback; do not animate dense data rows.
- Respect `prefers-reduced-motion` and keep all essential state independent of animation.
- Minimum touch target is 44 px; mobile primary actions use 48 px or greater.
- Keyboard focus uses Signal sky or Signal blue with visible offset.
- Verify 375, 768, 1024, and 1440 px widths; never hide content behind the navigation deck.
