# Basic example

Build the package from the repository root with `pnpm build`. Then run `pnpm install` and `pnpm dev` in this directory. `pnpm build` creates bundled main, sandboxed preload, and renderer outputs; `pnpm start` runs them.

The page invokes a main-owned calculator and prints the result. The calculator's private call count lives only in main. This example uses electron-vite 6.0.0-beta.1, Electron 44.3.0, and Vite 8.3.0.
