# ADR-0017: Auto-update & distribution

- **Status:** Accepted (baseline) — signing/notarization/auto-update deferred
- **Date:** 2026-06-29
- **Deciders:** Anurag

## Context

Healix ships as an Electron desktop app + a `healix` CLI. We need a repeatable way to produce a runnable desktop artifact, while the app bundles `@healix/core` (ESM) and relies on `playwright`/`archiver` at runtime.

## Decision

- **Packager:** **electron-builder**, configured in `apps/desktop/package.json` (`build` block). `pnpm --filter @healix/desktop package` produces an unpacked `release/mac-arm64/Healix.app`; `dist` targets nsis (Windows) and AppImage (Linux) — the mac target is still `["dir"]` (no dmg configured yet).
- **Bundling split:** `@healix/core` is **bundled** into the main process by electron-vite (it's ESM); its heavy runtime deps (`playwright`, `playwright-core`, `chromium-bidi`, `archiver`) are marked **external** in `electron.vite.config.ts` and declared as desktop **dependencies** so they resolve from `node_modules` at runtime (fixes the `chromium-bidi` load crash; main bundle 7.3MB → ~130K).
- **pnpm + electron-builder:** `@healix/core` is a **devDependency** of the desktop app (it's bundled, not required at runtime), which avoids electron-builder walking the workspace symlink into `packages/core` during asar packaging. `.turbo`/logs excluded via `build.files`.
- **Icon:** green-leaf mark at `apps/desktop/build/icon.{svg,png}` (electron-builder auto-uses `build/icon.png`); renderer favicon at `src/renderer/public/favicon.png`.

## Consequences

- A signed-ad-hoc `Healix.app` builds and **boots** today (verified). Codegen runs work in the packaged app (they shell out to the scaffolded suite's own Playwright).
- **Deferred:** Developer-ID signing + **notarization** (needs Apple certs), Windows/Linux installer CI, **auto-update** (electron-updater + a release feed), and verifying **computer-use** browser launch from inside the packaged asar (Playwright JS is packed; running it in-process from an Electron asar is a known edge — the production-grade path is a Playwright sidecar process). The CLI remains the fully-portable distribution today (`pnpm healix …`).
