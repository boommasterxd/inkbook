# Pen Diagnostics

## Recording

Run **Inkbook: Start pen diagnostics** from Obsidian's command palette. On an empty drawing, test hovering, pressing and releasing the side button while hovering, touching down with the button held, releasing during contact, lifting, and pressing during a normal stroke. Run **Inkbook: Stop and save pen diagnostics** afterward.

Logs are Markdown files under `Inkbook Diagnostics/`, named `pen-input-<timestamp>-<uuid>.md`. Open the file directly on the phone and add the device, stylus, Android and One UI versions in its supplied field. No developer console is required.

## Capture and Limits

Recording starts only after the start command. It observes pointer, raw pointer, mouse, touch, context-menu, capture and window-lifecycle events through passive capture listeners, without changing input behavior. Events across up to eight workspace windows include relative timestamps, button masks, pressure, geometry, coordinates, pointer type, capture state and whether the target belongs to Inkbook. At most four coalesced pointer samples and two changed touches are stored per event. Metadata includes Obsidian/plugin versions, viewport information and browser user-agent provenance; the user agent never selects platform behavior. This provenance is the sole reason for the diagnostic capture module's scoped platform-lint exception.

One recording lasts at most 120 seconds and stores at most 12,000 records. Batches append through the public Vault API every five seconds with serialized writes. Manual stop, quit and plugin unload request a final save; an abrupt process termination can lose the unsaved batch. Saving errors stop capture and preserve the failed batch in memory for **Stop and save pen diagnostics** to retry before closing Obsidian.

Events consumed by Android or WebView before JavaScript delivery cannot be captured. The log records capture-time flags, not the eventual outcome of Inkbook event handlers. A trace can identify observable event sequences but cannot by itself prove hardware behavior or recover missing native events.

## Data Handling

The diagnostic is opt-in and includes input outside Inkbook while recording, to detect host-level differences. It does not collect note text, DOM content or identifiers, vault file paths, clipboard data or typed keys. Coordinates can reveal pen movements, and the user agent can identify device/browser details. Use an empty test drawing, stop after reproduction, and inspect the file before sharing. Inkbook performs no diagnostic upload; configured vault synchronization can synchronize the Markdown log. Delete unwanted logs through Obsidian, including synchronized copies according to the sync provider's behavior.
