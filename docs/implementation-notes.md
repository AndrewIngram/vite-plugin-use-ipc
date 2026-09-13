# Implementation and validation decisions

The compiler, peer, reference registry, adapters, and binding follow the ownership boundaries in sections 6 and 13 of the specification. Public runtime entry points share `runtime/references.js`; the renderer and binding import no Node or compiler code. Node's built-in test runner replaces the advisory Vitest baseline.

Three integration findings changed the implementation during validation:

1. An empty caller transform map still allowed Vite/Rolldown to retain original destination text in a final source map. Caller replacement therefore happens in the pre-plugin load hook, before Vite captures its input. Original AST validation still happens before lowering. Destination transformation composes its maps normally. Both directions have tests scanning minified output and source maps for destination content.
2. Installed development imports receive Vite dependency-version queries. Returning a bare absolute runtime path from `resolveId` bypassed that behavior and produced a second runtime instance. Private runtime resolution now delegates to Vite's normal resolver. Public runtime entries are excluded from dependency prebundling, and the package is deduplicated. The fresh tarball fixture verifies this with real Electron calls in development.
3. Registering directories with the production file watcher did not reliably trigger rebuilds on additions. During a watched build, a recursive directory watcher updates a private temporary file registered with Rolldown. That file and the configured source root use canonical paths. The relay checks the configured discovery patterns and previously discovered paths, including deletions. It retains both discovered symlink paths and canonical target paths, so removing a link refreshes the registry even when its target still exists. This prevents another build's output from causing a rebuild cycle. Output, cache, dependency, and Git directories do not trigger the relay. Closing the build watcher closes the directory watcher, drains pending checks, and removes the temporary files. Tests run main and renderer production watchers together, verify generated registries after edits, additions, and deletion, and check that both watchers stay idle between source changes.

These changes preserve the specified API and protocol. They add no delivery, security, or cancellation guarantees. The limits in README and specification section 15 still apply.

## Verification commands

- `pnpm typecheck`: public implementation declarations and strict TypeScript checks.
- `pnpm test`: compiler, binding, real Node MessageChannels, real Vite builds, development HTTP responses, aliases, source maps, and simultaneous watchers.
- `pnpm test:electron`: isolated sandboxed Electron fixtures using a custom application protocol, Vite development, and ASAR packaging. Includes two windows, subframe rejection, invalid port counts, timeout, streams, crashes, navigation, unbind/rebind, and reinstall.
- `pnpm test:package`: tarball installation outside this checkout; packed export and path audits; valid and invalid consumer types; the same Electron modes; standalone electron-vite example compilation.

Local baseline: Node 24.19.0, TypeScript 7.0.2, Vite 8.3.0, Electron 44.3.0, electron-vite 6.0.0-beta.1, pnpm 10.14.0, macOS arm64. Windows and Linux integration runs are required before making support claims for those systems. Registry name availability and package publication have not been checked or performed.

## Error codec adoption

The error codec is adapted locally from use-worker, with provenance in THIRD_PARTY_NOTICES.md. IPC now preserves cloneable thrown values, so pending rejection callbacks accept unknown again. This is an intentional expansion from the earlier Error-only contract. The response envelope validates the recursive codec before reconstruction; application payloads remain schema-free. Both main and renderer must use the new codec.

Node MessageChannel tests cover both directions, causes, aggregates, codes and data, missing stacks, cycles, malformed envelopes, hostile metadata, omitted properties, and generator errors. The Electron fixture exercises a rich AggregateError in both directions in each installed-package mode.
