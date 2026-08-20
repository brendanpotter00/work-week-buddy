# Non-goals

State these plainly so no agent adds them "helpfully."

1. **No polling for input.** The event tap is push. The only timer that samples anything is the documented 5-minute read-only watchdog.
2. **No `CGEventSourceSecondsSinceLastEventType`, no `ioreg` `HIDIdleTime`, no `powerMonitor.getSystemIdleTime()`.** All three are reset by our own jiggler. ESLint-banned.
3. **No Rust, no C++, no node-gyp, no native compilation.** koffi is prebuilt. If a task seems to need a compiler, it is the wrong task.
4. **No second process.** No Swift sidecar, no N-API addon, no helper daemon.
5. **No App Sandbox, no Mac App Store, no notarization, no Apple Developer account.**
6. **No LaunchDaemon.** `CGEventSource*` calls hang without a WindowServer connection. It must be a GUI-session app.
7. **No heartbeat or per-tick sample table.** Intervals plus the single-row open-interval journal.
8. **No window, app, or URL tracking.** Intervals only. No `active-win`, no `get-windows`. This is not a surveillance tool.
9. **No manual editing of intervals in v1.** No "what were you doing?" prompts, no idle-detection popups. It is passive.
10. **No row deletion, ever.** Exclusion is a query-time filter, never a `DELETE`.
11. **No `DELETE` or `UPDATE` route on the Worker.** No arbitrary SQL. The route surface is the enforcement.
12. **No hosted or phone-viewable dashboard.** It reintroduces auth, CORS, egress, and a free tier that pauses. The schema supports adding one later.
13. **No realtime cross-machine presence.** A pull on launch/wake/after-flush is correct. The dashboard shows "work laptop, synced 4h ago."
14. **No microphone detection in v1.** Audio-only meetings will be under-counted. This is the highest-value v1.1 addition and it is the same ~30-line pattern as the camera.
15. **No user auth, no OAuth, no token refresh.** One bearer secret per machine. A background daemon with a refreshable session is a failure mode with no upside here.
16. **Do not "fix" the close rule.** An interval ends at the last real signal. If a change makes `ended_at` closer to `now()`, it is a bug, not an improvement.
