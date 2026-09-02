# Map browser regression check

Run `pnpm --filter @fieldops/web build` and then `pnpm --filter @fieldops/web test:maps` from the repository root. Open the printed loopback URL in a browser.

This fixture mounts the actual production components in React Strict Mode with synthetic data and real WebGL. It does not connect to Appwrite and is not a deployable application route. Do not disable or mock WebGL: a raster fallback is not a passing result.

For initialization failures, open `/webgl-check` on the same loopback server. It runs a minimal WebGL1/WebGL2 pixel-rendering check using default, high-performance, and low-power preferences without loading React or the map library. A failed independent check does not identify the cause by itself; collect the browser's graphics report rather than assuming its acceleration setting is off.

Check the following before shipping map changes:

- Routes: crisp English-labelled vector streets, solid recorded route, dashed GPS-gap link, three marker colors, location popups, smooth zoom/pan and Fit route.
- Move live marker, remove all data, and restore it. Layers must update without duplicates; the street map must remain usable when empty.
- Outlet: click within the shaded area or use map center. Clicking outside must show validation and preserve the last valid selection.
- Boundary: add three distinct points, inspect the closed polygon, undo, clear, pan, and add map center.
- Switch between all three views repeatedly to exercise teardown/reinitialization.
- Inspect rendered map: one active WebGL canvas, loaded style/tiles, English label expressions, and the expected route features/markers. Switching views must not accumulate active canvases.
- Click Unchanged status tick, then inspect again: route-source writes must not increase. Moving only the live marker must not resend route geometry either.
- Toggle 10,000 fixes and Measure zoom performance after tiles load. Record frame timing and visually check for blank frames and zoom stutter; a visible map alone is not a performance test.
- The brand icon must load. Browser console must not report map errors.

Finally verify the deployed `/routes` page and logo, not only this local fixture. These checks do not require creating, deleting, or editing production records. If the browser rejects the actual WebGL context, report the exact limitation and do not claim visual/performance verification passed.
