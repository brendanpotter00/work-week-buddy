/**
 * The sync layer: the outbox drain, the pull watermark, and the four backup
 * layers' client half.
 *
 * Everything here is a reconciliation path. Nothing here is a render path —
 * `docs/IMPL_STORE_SYNC.md` §6: the dashboard never reads the cloud.
 */
export * from "./wire";
export * from "./client";
export * from "./flush";
export * from "./pull";
export * from "./fingerprint";
export * from "./backup";
export * from "./restore";
