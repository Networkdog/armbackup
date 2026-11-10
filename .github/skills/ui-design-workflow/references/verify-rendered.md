# Verify the rendered result (workflow step 5)

`npm.cmd` is the Windows spelling; use `npm` elsewhere. Your own design explanation is not evidence (guide §2.3).

## 1. Serve and look
Serve the app as the README section "Local CLI development and debugging" describes (backend with uvicorn, frontend with `npm.cmd run dev --prefix frontend`; it needs `az login` and Azurite or an approved storage account), or use the URL of an instance that is already running. If it cannot be served after two attempts, serve the built app (`npm.cmd run build --prefix frontend`, then `npm.cmd run preview --prefix frontend`) against a `page.route` mock of the API (section 4); only if that fails, run the area's e2e spec and list the inventory under "Not verified".

Open the screen and look at screenshots at 320, 390, 1024 and 1440 px in both themes when a browser tool exists. 320 is the WCAG 1.4.10 reflow width: no loss of content or function and no two-way scrolling (a table may scroll). 390 and 1024 sit around the repo breakpoints 760 and 1100 px. Probe horizontal overflow at 320 and 390 px: `document.documentElement.scrollWidth > innerWidth` names a page that overflows.

## 2. Inventory per theme
```
node .github/skills/ui-element-audit/scripts/element-inventory.mjs --url <url> --keyboard --screenshot <png> --annotate --theme light
```
Run it again with `--theme dark`, and once with `--forced-colors` (focus drawn only by `box-shadow` then shows as `A11Y-FOCUS-NO-INDICATOR`; look at the screenshot for status and borders that vanish). `--theme` only emulates `prefers-color-scheme`. If the dark run reports `THEME-NO-CHANGE`, the page ignored it (a page with its own switch; this repo's `ThemeControl` follows the system unless `localStorage['azfw-theme']` holds `light` or `dark`). Set the switch with `--init-script <file>` (for example `localStorage.setItem('azfw-theme','dark')`) and say so in the report.

## 3. Audit
Load `ui-element-audit`, judge the eight gates, fix P0 and P1, re-run. At most 3 passes.

## 4. Server-driven states
Create each one (loading, error, stale, partial, no permission) with Playwright `page.route` mocks in your own script, as `frontend/e2e/azure-helpers.ts` does, or with an `--init-script <file>` that stubs `fetch`. `--steps` only repeats UI actions (click, fill, press, hover, wait), so it covers UI-driven states such as an empty search result. Write which method produced which state, then walk the keyboard path.

## 5. Repo checks
When the change lives in the repo: `npm.cmd run build --prefix frontend`, then the e2e spec for the area with `--workers=1` (build first; set `PW_STORAGE_CONNECTION_STRING` if the default Azurite port fails). A new state or behaviour gets a case in that spec (copy the nearest test). When the suite cannot start (no `.venv`, no Azurite), run the new case against a mock of the API and list it under Not verified. For an artifact outside the repo (prototype, single file), say that build and e2e do not apply.

Self-critique alone did not reliably improve output; deterministic checks must also improve.
