export interface LoginItemController {
  setLoginItemSettings(options: { openAtLogin: boolean }): void
}

/**
 * Apply the persisted launch-at-login preference at the Electron boundary.
 * Keeping this tiny and dependency-free makes the setting testable without
 * importing Electron or touching the user's login items in unit tests.
 */
export function applyLaunchAtLogin(app: LoginItemController, enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled })
}
