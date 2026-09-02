# Management control room

## Job

Help a Karachi field-operations manager see integrity problems first, then complete one bounded task: review a mark, publish a daily visit, manage a place, protect a territory, or change team access.

## Visual direction

- Charcoal `#2D2729`: text, navigation, and the operations-integrity header.
- Ribbon red `#CB183D`: page headers, primary actions, and selection.
- Amber `#EDB35E`: pending decisions only.
- Green `#248564`: confirmed and healthy states.
- Warm ivory `#F6F1ED`: quiet workspace background.
- Clay red `#AA342C`: blocking integrity failures, with an explicit status label.

Typography uses restrained bold headings and readable sentence-case labels. Data remains plain and literal; controls use the same verb before and after completion. Rounded white cards and a crimson header follow the supplied field-sales UI reference.

## Layout

```text
┌──────── rail ────────┬──────────────── workspace ────────────────┐
│ Overview             │ Direct page job + live-route action       │
│ Management           ├────────────────────────────────────────────┤
│ Sales pipeline       │ OPERATIONS INTEGRITY                       │
│ Review marks         │ reviews · boundary issues · coverage       │
│ All controls         ├────────────────────────────────────────────┤
│                      │ Sales pipeline: deals and next actions      │
│                      ├────────────────────────────────────────────┤
│                      │ Mark review queue                           │
│                      ├────────────────────────────────────────────┤
│                      │ Daily plan | Places | Territories | Team   │
│                      │ one selected task workspace                 │
└──────────────────────┴────────────────────────────────────────────┘
```

The signature element is the operations-integrity strip. It encodes real blockers, including outlets outside territory polygons, rather than acting as a decorative metric row.

## Interaction rules

- Keep Overview, Sales pipeline, Review marks, and All controls as separate sidebar views instead of one long page.
- The sales pipeline is intentionally bounded to customer opportunities; FieldOPS has no chat, manager contact, calling, or WhatsApp surface.
- Deal value is labelled as a seller-entered working estimate; no target, forecast, or attainment figure is invented.
- A busy action disables only itself.
- A boundary cannot be saved when it strands an active outlet.
- Verified salesperson GPS coordinates never change through place-name editing.
- Empty means verified empty; partial backend failures receive an explicit warning and retry path.
- All map actions have visible text instructions and server-side validation.
