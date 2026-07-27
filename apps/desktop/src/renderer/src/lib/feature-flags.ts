/**
 * Master switch for the token/cost usage UI: RunDetailPanel's Usage tab and
 * the Reports sidebar page. Flip to false and rebuild (`pnpm build:desktop`)
 * before shipping to a client who shouldn't see usage data — set true to
 * monitor performance internally or give a client a rough usage estimate.
 *
 * Usage is still captured in the background regardless of this flag (see
 * packages/core's orchestrator recordUsage wiring) — flipping this back to
 * true later shows full history, nothing is lost while it's off.
 */
export const SHOW_TOKEN_USAGE = true;

/**
 * Master switch for the results-page Repair button (RunDetailPanel). Held
 * back for a later release — set true to re-enable. All underlying code
 * (startRepair, the runs:repairCandidates IPC handler, matchRepairCandidates)
 * stays fully intact and functional while this is off; only the button's
 * render is gated.
 */
export const SHOW_REPAIR_ACTION = false;
