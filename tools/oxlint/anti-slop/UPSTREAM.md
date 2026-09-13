# Vendored source

Installed from `.agents/skills/install-anti-slop/assets/anti-slop` in the sibling `vite-plugin-use-worker` checkout.

Source checkout: https://github.com/AndrewIngram/vite-plugin-use-worker. The skill assets were untracked at installation, so their upstream commit is unknown; the checkout HEAD does not identify them.

The pristine copied assets are recoverable from `upstream-source.tar.gz` beside this file. SHA-256: `44beb210319943804128f2060d556b332613a04fada3572040a6a032b8bb2d43`.

Installed entry points: `tools/oxlint/anti-slop/index.ts` and `tools/oxlint/anti-slop/effect/index.ts`. Only the generic plugin is enabled; this project does not declare Effect.

No deviations from the copied assets. This provenance record and pristine archive were added locally. The nested `vendor/eslint-stylistic/LICENSE` and `UPSTREAM.md` are preserved.

## Local configuration policy

The application enables `no-runtime-typeof` at error severity with `allowInTypeGuards: true`. Runtime envelope validation remains required before dispatch.

The user approved omitting `no-unknown-parameters`, `no-unknown-returns`, and `no-unsafe-dictionary-type` from the enabled rules. Generic transport payloads, raw receive callbacks, arbitrary thrown values, and temporary structural inspection legitimately use unknown types. Outgoing messages and validated dispatch retain the concrete Message contract. This is an intentional library-specific configuration choice, not an upstream source change. All other configured rules remain enabled; vendored assets and their pristine snapshot are unchanged.
