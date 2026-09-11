import { createControlPlaneApp } from './app-composition.js'

/**
 * The all-in-one application: every route, control and media, in one process.
 * Route composition and the optional split-plane shape live in
 * `app-composition.ts` (`createControlPlaneApp()`/`createMediaPlaneApp()`),
 * shared by this app and `media-server.ts` so the two deployment modes can
 * never drift.
 */
export const appReady = createControlPlaneApp()
