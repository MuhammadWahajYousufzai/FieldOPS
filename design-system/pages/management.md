# Management control room

## Job

Help a Karachi field-operations manager see integrity problems first, then complete one bounded task: review a mark, publish a daily visit, manage a place, protect a territory, or change team access.

## Visual direction

- Field navy `#14213D`: structure, navigation, and the operations-integrity header.
- Route blue `#2563EB`: primary actions and movement.
- Rice gold `#D8A629`: pending decisions only.
- Route green `#267057`: confirmed and healthy states.
- Canvas `#F8FAFC`: quiet workspace background.
- Clay red `#B5523B`: blocking integrity failures only.

Typography uses the existing compact, heavy operational hierarchy. Labels and data remain plain and literal; controls use the same verb before and after completion.

## Layout

```text
┌──────── rail ────────┬──────────────── workspace ────────────────┐
│ Overview             │ Direct page job + live-route action       │
│ Management           ├────────────────────────────────────────────┤
│ Team desk            │ OPERATIONS INTEGRITY                       │
│ Review marks         │ reviews · boundary issues · coverage       │
│ All controls         ├────────────────────────────────────────────┤
│ Reports              │ Team Desk: messages | deals | phone setup  │
│                      ├────────────────────────────────────────────┤
│                      │ Mark review queue                           │
│                      ├────────────────────────────────────────────┤
│                      │ Daily plan | Places | Territories | Team   │
│                      │ one selected task workspace                 │
└──────────────────────┴────────────────────────────────────────────┘
```

The signature element is the operations-integrity strip. It encodes real blockers, including outlets outside territory polygons, rather than acting as a decorative metric row.

## Interaction rules

- Do not render every create/edit form at once. Keep one task view selected.
- The Team Desk is one manager serving one organization's salespeople; never expose an organization switcher or multi-manager assignment flow.
- Call and WhatsApp controls open the device application and never imply that FieldOPS records calls.
- Deal value is labelled as a seller-entered working estimate; no target, forecast, or attainment figure is invented.
- A busy action disables only itself.
- A boundary cannot be saved when it strands an active outlet.
- Verified salesperson GPS coordinates never change through place-name editing.
- Empty means verified empty; partial backend failures receive an explicit warning and retry path.
- All map actions have visible text instructions and server-side validation.
