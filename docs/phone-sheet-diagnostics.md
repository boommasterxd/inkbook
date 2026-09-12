# Phone Sheet Diagnostics

This opt-in diagnostic records owned phone-sheet swipes to investigate device-only motion defects. It is disabled without a valid vault configuration and never records on desktop or tablet.

## Activation and limits

Create `Inkbook diagnostics/swipe-config.json` in the vault:

```json
{
  "version": 1,
  "id": "swipe-investigation-20260912",
  "expiresAt": 1789466400000,
  "maxReports": 3
}
```

Set `expiresAt` to a future Unix timestamp in milliseconds, at most seven days ahead. The example expires at 2026-09-15 10:00 UTC. Configuration is limited to 1,024 bytes; `id` is a bounded ASCII identifier. Recording starts automatically after the configuration is available. Only a claimed sheet drag with at least six pixels of downward finger movement consumes the device-local budget; ordinary taps do not.

At most three swipes are recorded per configuration ID and device. Each capture is bounded to 60 seconds, 7,200 frame samples, 256 event samples, and approximately 2 MB. Animation metadata is sampled at most every 250 ms. Configuration expiry and plugin disposal stop further recording. Reloading the plugin or editing the current configuration without changing its ID does not reset the consumed budget. Device storage retains the most recent configuration ID and count.

## Output and privacy

Reports are written serially after capture completes (normally shortly after pointer release, or at a recording limit) to `Inkbook diagnostics/swipe-trace-1.json` through `swipe-trace-3.json`, replacing the corresponding previous diagnostic reports. Files remain in the vault until deleted; ordinary vault synchronization may copy them to the user's other devices. Inkbook sends no diagnostic data to an external service.

The record contains relative timing, sheet kind, pointer coordinates and ownership events, viewport dimensions, sheet geometry, scroll offsets, motion states, and bounded animation metadata. It does not include setting values, entered text, note contents, field labels, or note paths.

The capture itself performs additional geometry and computed-style reads. It can affect rendering timing, and stable recorded geometry does not prove that the physical display or compositor painted every frame correctly. Compare the observed gesture with event and frame samples; do not claim a hardware-only defect is resolved solely because simulated tests pass.

## Implementation and verification

The menu recorder owns listeners, animation frames, timers, and bounded report buffers. The Obsidian boundary owns configuration, per-device progress, lifecycle, and public Vault writes. No writes occur in the swipe frame callback.

Regression tests cover activation limits, invalid configuration, claimed versus unclaimed gestures, capture cleanup, bounded output, and serialized persistence. Real-device recording supplements the normal Unit and Integration tests and the real-Obsidian visual checks; it is not an end-to-end test suite.
