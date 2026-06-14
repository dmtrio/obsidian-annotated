/**
 * Compile-time flags injected by esbuild `define` (esbuild.config.mjs).
 * BUILD_OAUTH is `false` in the lite (community-store) build, which lets
 * esbuild tree-shake the OAuth gate — express and the SDK auth router are
 * absent from that bundle, not merely dormant. PLN — MCP OAuth Shim, D6.
 */
declare const BUILD_OAUTH: boolean;
