# Localization

Inkbook provides English and German interface text. Language selection and device-local persistence are defined in [Settings](settings.md#language). Auto uses Obsidian's public `getLanguage()` result, normalizing case and language subtags; `de` variants select German and unsupported languages select English. An explicit preference overrides the host language.

Localize Inkbook-owned visible text, accessible names and descriptions, feedback, settings, and commands. Keep user content, filenames, paths, document data, and persisted identifiers unchanged. Host-owned UI remains under Obsidian's control. Changing the interface language must preserve document and session state, settings scroll position, and focus where applicable.

New import findings and conversion warnings carry validated semantic codes and render in the current language. Existing journals without these codes preserve their original diagnostic details as historical data, introduced by a localized explanation rather than guessing a translation from saved message text.

## Catalogs and ownership

The plugin owns a `Localization` instance in `src/domain/localization/` and passes it to the surfaces that need it. A language change notifies subscribed surfaces; subscriptions follow their surface lifecycle. Avoid mutable global language state and replacing arbitrary DOM text after rendering.

Localized interface roots declare their resolved `lang` so assistive technology can pronounce an explicit language override independently of Obsidian. Bind that attribute to the surface lifetime and restore its previous value on cleanup; never change the host document's language.

Messages use semantic flat keys in the surface catalogs under `src/domain/localization/locales/en/` and `src/domain/localization/locales/de/`. `catalogs.ts` combines these catalogs and derives `MessageKey` from English; the German catalog conforms to the same keys. `t` interpolates named `{placeholder}` values, formatting numeric parameters with the selected locale. Use the instance's `number`, `date`, and `plural` methods for locale-sensitive values and select the appropriate translated plural form. English is the fallback for a missing German message.

## Adding or changing translations

1. Add or update semantic keys in the relevant English and German surface catalogs. Keep placeholders consistent and translate the complete user-facing message rather than assembling sentence fragments.
2. Pass the owning localization instance through the existing surface interface. Render messages through `t`, use locale-aware formatting for numbers and dates, and choose plural forms using `plural`.
3. For another language, add matching surface catalogs, register them in `catalogs.ts`, extend the supported language and preference types and resolution, and expose the choice in settings. Preserve English fallback and update the language-selection contract.
4. Verify the affected behavior, including language changes on open surfaces, accessible labels, interpolation and plural forms, and preservation of state, scroll, and focus. Do not translate persisted identifiers or user data.
