export interface TrayCloseState {
  closeToTray: boolean
  explicitQuit: boolean
  /**
   * An instance with active or pending recovery ownership owns a client (and,
   * for local API instances,
   * a gateway process). Closing the manager window must not tear down that
   * client merely because the user did not enable the optional tray setting.
   */
  activeInstances?: boolean
}

/**
 * Closing the main window is a user preference. Explicit stop-and-quit from
 * the tray or a maintenance restart must win so cleanup cannot be trapped by
 * hide-to-tray behavior.
 */
export function shouldHideOnClose(state: TrayCloseState): boolean {
  return !state.explicitQuit && (state.closeToTray || state.activeInstances === true)
}

/** Ordinary Quit preserves owned clients; stopping them requires an explicit action. */
export function shouldPreserveInstancesOnQuit(state: Pick<TrayCloseState, 'explicitQuit' | 'activeInstances'>): boolean {
  return !state.explicitQuit && state.activeInstances === true
}
