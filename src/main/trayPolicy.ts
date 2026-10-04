export interface TrayCloseState {
  closeToTray: boolean
  explicitQuit: boolean
}

/**
 * Closing the main window is a user preference. An explicit quit from the
 * tray/menu must always win so the cleanup path cannot be trapped by the
 * hide-to-tray behavior.
 */
export function shouldHideOnClose(state: TrayCloseState): boolean {
  return state.closeToTray && !state.explicitQuit
}
