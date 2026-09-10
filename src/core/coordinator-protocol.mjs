/**
 * Protocol version of the View State Coordinator control socket (issue #108).
 *
 * Bumped whenever a coordinator release adds command kinds or changes the
 * envelope contract. A client built against version N refuses to talk to a
 * coordinator reporting < N — a pong WITHOUT the field counts as version 1
 * (the pre-#107 baseline) — and replaces the stale instance with a fresh one
 * (SIGTERM via the coordinator lease pid, then respawn) instead of feeding
 * it commands it cannot understand (`sync_foreground rejected (unknown_kind)`
 * used to strand every foreground state write on extension updates).
 */
export const COORDINATOR_PROTOCOL_VERSION = 2;
