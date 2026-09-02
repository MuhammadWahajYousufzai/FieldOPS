# Map browser regression check

Run `pnpm --filter @fieldops/web build` and then `pnpm --filter @fieldops/web test:maps` from the repository root. Open the printed loopback URL in a browser.

This fixture mounts the actual production components in React Strict Mode with synthetic data. It deliberately denies WebGL contexts, does not connect to Appwrite, and is not a deployable application route.

Check the following before shipping map changes:

- Routes: street tiles, solid recorded route, dashed GPS-gap link, three marker colors, location popups, zoom/pan and Fit route.
- Move live marker, remove all data, and restore it. Layers must update without duplicates; the street map must remain usable when empty.
- Outlet: click within the shaded area or use map center. Clicking outside must show validation and preserve the last valid selection.
- Boundary: add three distinct points, inspect the closed polygon, undo, clear, pan, and add map center.
- Switch between all three views repeatedly to exercise teardown/reinitialization.
- Inspect rendered map: loaded tiles must be nonzero; expected routes/markers/polygons must exist; WebGL requests and canvas count must both remain zero.
- The brand icon must load. Browser console must not report map errors.

Finally verify the deployed `/routes` page and logo, not only this local fixture. These checks do not require creating, deleting, or editing production records.
