# Third-party notices

The library does not bundle its dependencies into the published JavaScript. Its error codec in `src/runtime/errors.ts` is adapted from `packages/core/src/runtime/runtime-shared.ts` in Andrew Ingram's use-worker project, revision `b8ec1378ca55d91cb677545ed98ea002ba67ce6a` (https://github.com/AndrewIngram/vite-plugin-use-worker). That code is MIT licensed, copyright (c) 2026 Andrew Ingram, as covered by the included LICENSE. The adaptation adds nested-envelope validation, bounded ancestor traversal, safe own-property restoration, and fallback handling. There is no dependency on a shared library.

Runtime dependencies of the Vite plugin are installed separately, with their own license files:

- `magic-string` 0.30.21, MIT, Rich Harris.
- `@jridgewell/remapping` 2.3.5, MIT, Justin Ridgewell.
- `tinyglobby` 0.2.15, MIT, Madeline Gurriarán.

Vite 8.3 is a peer dependency. Its Oxc parser and transformer are used through Vite's public API. Vite, Rolldown, Oxc, and their dependencies retain their distributed notices. Electron is an optional peer supplied by the application. Its notices belong with the shipped Electron application.

TypeScript, Node type declarations, Electron, and ASAR tooling used to build or test this repository are development dependencies and are not included in this package's distribution files.
