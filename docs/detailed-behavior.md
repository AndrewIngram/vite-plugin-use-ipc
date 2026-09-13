# Detailed behavior

Start with the [README](../README.md) for setup and examples. This page records details you may need when debugging or building more complex features.

## Source contract

The exact unparenthesized directive belongs in the module's directive prologue. Inline, misplaced, wrapped, conflicting, and narrowly similar misspelled directives are errors. Escapes and template literals are not supported spellings.

Every runtime export must be a locally declared async function or async generator. Named and default declarations, async arrows, async function expressions, direct local export aliases, and string export names work. Erased type exports are allowed. Values, classes, runtime enums, re-exports, imported bindings, synchronous functions, and wrappers that manufacture functions are rejected. Private helpers, imports, side effects, recursion, parameters, and state remain ordinary destination code.

TypeScript checks the original source signatures. It does not prove clone compatibility, process direction, authorization, or startup order. Async functions returning iterables remain ordinary calls; stream behavior requires a declared async generator. Directives in dependency files under `node_modules` are not transformed.


## Streams and cancellation

```ts
"use ipc:main";
export async function* read(signal: AbortSignal) {
  // Pass signal to each operation that may wait indefinitely.
  yield 1;
}
```

A reference checks connection availability when called, then opens lazily on the first `next()`. Each `next()` pulls one result. `next(value)`, `throw(value)`, final return values, and yields inside `finally` are preserved. Operations serialize per iterator. `return(value)` awaits its value locally. Unopened `return` or `throw`, and an already-aborted signal, never open a remote stream.

Generators accept at most one top-level AbortSignal. The receiver substitutes a local signal. Abort reasons are not sent. Caller abort and `return()` request cancellation immediately, even behind a pending read. A cancellation during loading is remembered until a stream ID exists. Disconnect aborts opening and retained stream controllers.

Cancellation is cooperative. Producers must pass their signal into awaited work to wake idle reads. A producer may throw on abort. Imports and arbitrary Promises cannot be interrupted. Cleanup may reject or wait indefinitely. One `return()` can yield `done: false` from `finally`; cancellation and `for await` break do not drain arbitrary cleanup yields. Ordinary calls have no cancellation API.

Each peer allows 256 pending outgoing requests and 256 retained incoming streams. Each caller iterator allows 256 queued or executing operations. Overflow rejects and settled work frees its slot. These limits do not bound all inbound work, payload bytes, or producer buffering.


## Dependency lifetime

```ts
import { createIpcBinding } from 'vite-plugin-use-ipc/binding';
const service = createIpcBinding<EventSource>('event source');
const unbind = service.bind(applicationOwnedSource);
const lease = service.get(); // { value, signal }
unbind(); // clears ownership, then aborts lease.signal
```

Capture one lease at the start of a handler. Combine its signal with a caller signal when both lifetimes matter. Binding constructs and disposes no service. Duplicate binds and unbound reads throw; stale disposers cannot clear a newer owner. Same-name bindings are independent.

Shutdown order is unbind dependencies, dispose IPC, then dispose application-owned services. Already executing ordinary work needs an application shutdown policy.


## Values, errors, and trust

MessagePorts use structured clone. Maps and ArrayBuffers are copied; buffers are not detached. There are no transfer lists, remote callbacks, iterable arguments, or arbitrary proxies. Functions, DOM objects, and Electron host objects are outside the data contract. Clone failures reject the operation without poisoning later calls.

Errors preserve name, message, destination stack text, recursive causes, aggregate contents, and cloneable enumerable own data properties such as `code`. Standard JavaScript error types are reconstructed; custom subclasses retain their name but not their prototype. Cloneable non-Error throws arrive as their original value. Non-cloneable custom properties and accessor properties are omitted. Circular or excessively deep error chains receive a fallback Error, and error-object identity is not preserved. No automatic redaction is applied; only attach details that should reach the other process.

Every attached main-frame document can invoke every discovered main export. Main checks attachment, current main-frame identity, and transferred port count. It does not enforce origins or per-function permissions. Keep attached windows on trusted application content and validate application arguments. Discovery includes exports unused by caller imports. IDs and omitted caller source are not authorization or secret storage.

There are no retries, deadlines for calls, negotiation, reconnect loops, state replay, or delivery guarantees across disconnects. Malformed messages and unknown replies are ignored. A channel that stops delivering without closing can leave requests pending. Message deserialization errors and inability to post even an error reply have no recovery policy. Duplicate concurrent renderer/preload startup is outside the supported single-attempt lifecycle.


## Development and verification

IPC edits, additions, and deletions refresh discovery and request a full renderer reload. Main-owned edits also require a main rebuild and process restart, owned by the application. Two watchers can temporarily see different revisions. IDs hash relative filename and exact source text; comments change IDs, dependency-only edits do not.

This repository pins Node 24.19.0 through pnpm, Vite 8.3.0, and Electron 44.3.0. Compatibility claims are limited to the tested versions and local platform; other operating systems need their own Electron runs.

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:electron
pnpm test:package
```

See the [basic example](../examples/basic) and [implementation notes](implementation-notes.md).

The Electron commands provision the pinned Electron binary on first use.

The package test packs and installs into a fresh temporary consumer, checks declarations and export files, then runs production, Vite development, and ASAR Electron fixtures. Tests use real MessageChannels and Electron ports. No external application or service is required. The full specification is in `use-ipc-spec.md` in the repository.
