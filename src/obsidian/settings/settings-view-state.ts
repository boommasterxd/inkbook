/** Keeps disclosure choices within one settings surface across content refreshes. */
export class SettingsViewState {
  readonly expandedSections = new Set<string>();
}
