/**
 * The server entry point.
 *
 * Kept separate from `app.ts` so that constructing the app costs nothing and binds no
 * port. Tests import `createApp`; only this file listens.
 */

export { createApp, type AppDeps } from './app.js';
export * from './config.js';
export * from './context.js';
export * from './errors.js';
export * from './logger.js';
export * from './middleware.js';
export * from './oauth-contract.js';
export * from './schemas.js';
export * from './serialise.js';
export { isApiPath, mountWebApp, resolveAsset, resolveWebDist } from './web-app.js';
