/**
 * Clio backend singleton accessors.
 *
 * The actual singleton lives in `@cfcf/core` (so the iteration loop can
 * share it); this file re-exports the three public helpers the server
 * needs. Keeping this shim file lets us swap import paths across the
 * server without pulling `@cfcf/core`'s internals into every route file.
 */

export { getClioBackend, setClioBackend, closeClioBackend } from "@cfcf/core";
