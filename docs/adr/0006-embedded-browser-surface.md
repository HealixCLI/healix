# ADR-0006: Single embedded browser surface (Playwright/CDP) for computer-use + browser-use

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Anurag

## Context

Both computer-use (vision: screenshots → coordinate actions) and browser-use (DOM/accessibility-tree actions) need a **real, controllable browser**. The old stack used a Python `browser-use` subprocess plus a separate Playwright explorer and a Playwright-MCP client — three overlapping surfaces. We want one. We also want a **live view** inside the Electron app.

## Decision

Use **one Chromium instance controlled by Playwright over CDP** as the single automation surface:

- **computer-use** captures screenshots and dispatches mouse/keyboard by coordinate (CDP input).
- **browser-use** issues DOM/AX-tree actions via the same Playwright session.
- The session is **mirrored live** into the Electron UI via a screenshot stream, with an optional **headed pop-out** of the real window.
- Discovered flows are recorded and **codegen'd into deterministic Playwright specs** that re-run headless without the AI.

## Consequences

- One dependency (Playwright) covers automation, exploration, execution, and export — no Python `browser-use` subprocess.
- CDP input gives computer-use precise control and consistent coordinates.
- Live mirroring adds a screenshot-streaming channel (throttle for performance).
- Bundling Playwright browsers into the Electron build (size, code-signing) needs an early spike.
