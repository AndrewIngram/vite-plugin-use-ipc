# Dependency requirements

The package's requirements describe what a consuming app needs. The repository's pinned development tools provide a reproducible build environment and do not require consumers to install those tools.

| Dependency | Declared range | Reason |
| --- | --- | --- |
| Node | `^20.19.0 || >=22.12.0` | Matches [Vite 8's Node requirement](https://v8.vite.dev/guide/). The plugin does not need Node 24. |
| Vite | `^8.0.0` | The compiler imports `parseSync`, `Visitor`, and `transformWithOxc` from Vite. These APIs are available in Vite 8.0.0. |
| Electron | `>=35.0.0` | Electron 35 includes Chromium 134, which supports `Symbol.asyncDispose` in renderer pages. The runtime uses this symbol for iterator cleanup. See [Electron 35](https://releases.electronjs.org/release/v35.0.0) and [Chrome 134](https://developer.chrome.com/release-notes/134#explicit_resource_management_async). |
| `@jridgewell/remapping` | `^2.3.1` | The first release under this package name provides the source-map composition API used by the compiler. |
| `magic-string` | `^0.30.1` | Version 0.30.0 fails our NodeNext TypeScript build. Version 0.30.1 fixes its declaration exports. See the [changelog](https://github.com/Rich-Harris/magic-string/blob/master/CHANGELOG.md). |
| `tinyglobby` | `^0.2.15` | Retains fixes for include patterns: empty lists, symlinks, Windows paths, and negated brackets. Version 0.2.0 failed our empty-include test. Version 0.2.15 includes the later pattern fixes. See the [changelog](https://github.com/SuperchupuDev/tinyglobby/blob/main/CHANGELOG.md). |

Compatible dependency updates are allowed by the package ranges. The lockfile selects exact versions for development. Electron is an optional peer so compiler-only consumers do not have to download Electron.

## Verify the minimums

Run `pnpm test:minimum`. It creates a temporary copy, installs the exact minimum direct dependencies and peers, builds against their types, and runs all compiler, runtime, error, and Vite tests on Node 20.19.0 and 22.12.0. It also runs the Electron 35.0.0 fixture in custom-protocol, development-server, and ASAR modes, including iterator disposal in both directions.

The command checks the actual Node version before running each suite. pnpm downloads the required runtimes if necessary. ASAR packaging runs under Node 22.12 because that development tool has its own Node requirement.

The minimums and the current development versions have been tested on macOS arm64. This does not establish Windows or Linux compatibility, or test every intervening release. Use a maintained release of Node and Electron when choosing versions for an application.
