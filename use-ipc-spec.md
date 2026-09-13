# Standalone use-ipc specification

Status: implementation specification, draft 1. Date: 12 September 2026.

This document specifies an Electron IPC library and its Vite plugin. An implementer can build the library from this document without access to another application or an earlier implementation.

The scope preserves the established directive syntax, public function names, call behavior, and stream semantics. Package exports and neutral identifiers are specified here as distribution requirements. Section 15 distinguishes established behavior from release checks and known limitations. Those checks must not be described as capabilities already verified.

`MUST` identifies a requirement. `SHOULD` identifies a recommendation with a documented exception. `MAY` identifies an implementation choice. Unless a section says otherwise, its behavioral statements are requirements.

## 1. Purpose and scope

The library lets Electron main and renderer code import remote async functions as ordinary JavaScript module exports. A module directive declares where the implementation runs:

```ts
// src/ipc/calculator.ts
"use ipc:main";

export async function add(left: number, right: number): Promise<number> {
  return left + right;
}
```

A renderer imports the same source module:

```ts
import { add } from "../ipc/calculator";

const answer = await add(20, 22);
```

In the renderer build, the plugin replaces the entire module with remote references. In the main build, the module retains its implementation and private state. TypeScript checks the original function signature in both builds.

The initial release includes:

- Module-level `"use ipc:main"` and `"use ipc:renderer"` directives.
- Async function calls and async generator iteration in both directions.
- Explicit window selection for main-to-renderer calls.
- A dedicated MessagePort connection for each attached renderer.
- Structured-clone arguments, results, and yielded values.
- Error transport and cooperative stream cancellation.
- Lazy destination modules with shared state across local and remote calls.
- Connection disposal on navigation, renderer failure, window closure, and explicit shutdown.
- An optional dependency binding helper with an abortable lifetime.
- Vite development and production transforms, declarations, and package tests.

The initial release excludes:

- Inline directives, closure capture, and function hoisting across processes.
- Synchronous IPC, renderer-to-renderer routing, workers, and network transports.
- Automatic window selection, broadcast, and window creation.
- Request retries, request deadlines, reconnect loops, caching, and state replay.
- Framework hooks, UI state, application event feeds, and runtime argument schemas.
- Remote callbacks, returned functions, async-iterable arguments, and arbitrary object proxies.
- Buffer ownership transfer, transfer-list APIs, and zero-copy claims.
- Cancellation of ordinary async calls and forced termination of destination work.
- Mixed-version communication or independently deployed main and renderer bundles.

Host-application names and domain-specific terminology MUST NOT appear in the package identity, plugin name, channels, virtual IDs, examples, fixtures, error messages, build output paths, or documentation. Examples use generic services, counters, documents, or event readers. Required third-party attribution remains intact when applicable.

## 2. Package and public API

### 2.1 Package identity

This specification uses `vite-plugin-use-ipc` as a provisional package name. Registry availability has not been checked. Selecting another neutral package name changes import specifiers, not directive syntax or behavior.

Publish one package with separate entry points:

| Import                         | Public exports                                    | Execution environment                     |
| ------------------------------ | ------------------------------------------------- | ----------------------------------------- |
| `vite-plugin-use-ipc`          | Default `useIpc`, types `IpcOptions` and `Target` | Node, inside Vite configuration           |
| `vite-plugin-use-ipc/main`     | `installMainIpc`, `callRenderer`, type `MainIpc`  | Electron main                             |
| `vite-plugin-use-ipc/preload`  | `installIpcPreload`                               | Electron preload                          |
| `vite-plugin-use-ipc/renderer` | `installRendererIpc`                              | Electron renderer main world              |
| `vite-plugin-use-ipc/binding`  | `createIpcBinding`, type `IpcBinding`             | Any JavaScript realm with AbortController |
| `vite-plugin-use-ipc/env`      | Ambient declaration for the registration module   | TypeScript only                           |

The compiler, transport peer, lazy registry, and reference metadata are private implementation modules. Applications do not register raw handlers, construct peers, or choose function IDs.

There is no combined runtime barrel. Importing the renderer or binding entry MUST NOT import Electron, Node built-ins, Vite, a parser, or the compiler.

### 2.2 Declarations

The public declarations have these contracts. The library may split these declarations across its entry points.

```ts
import type { BrowserWindow } from "electron";
import type { Plugin } from "vite";

export type Target = "main" | "renderer";

export interface IpcOptions {
  target: Target;
  root: string;
  include?: string[];
}

export default function useIpc(options: IpcOptions): Plugin;

export interface MainIpc {
  attach(window: BrowserWindow): void;
  dispose(): void;
}

export function installMainIpc(): MainIpc;
export function installIpcPreload(): () => void;
export function installRendererIpc(): Promise<() => void>;

export function callRenderer<A extends unknown[], R>(
  window: { webContents: { id: number } },
  fn: (...args: A) => R,
  ...args: A
): R;

export interface IpcBinding<T> {
  bind(value: T): () => void;
  get(): { readonly value: T; readonly signal: AbortSignal };
}

export function createIpcBinding<T>(name: string): IpcBinding<T>;
```

`callRenderer` preserves argument tuples and the return type. An async function returns its original Promise type. An async generator returns its original async generator type without an additional Promise wrapper.

The generic function signature does not prove that `fn` is a generated reference. Runtime metadata performs that check. Wrapping, binding, or copying properties from a reference does not copy its metadata. Direct imports retain their full declared types. `callRenderer` has the generic signature shown above, which does not promise to retain every overloaded or higher-rank generic inference relationship.

### 2.3 Virtual modules and identifiers

| Identifier                             | Purpose                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `virtual:use-ipc/register`             | Public side-effect import that installs destination handler loaders        |
| `virtual:use-ipc/runtime`              | Private generated-code import for reference creation and lazy registration |
| `\0virtual:use-ipc/register`           | Internal resolved registration ID                                          |
| `\0virtual:use-ipc/entry/<module-key>` | Internal destination entry ID                                              |
| `use-ipc`                              | Vite plugin name                                                           |
| `use-ipc:connect`                      | Electron channel that transfers a connection port to main                  |
| `use-ipc:request-port`                 | Window message requesting a renderer port                                  |
| `use-ipc:port`                         | Window message delivering the renderer port                                |

`\0` represents an actual leading NUL in the resolved Vite ID. It is not a literal backslash followed by zero. These IDs follow [Vite's virtual module convention](https://vite.dev/guide/api-plugin#importing-a-virtual-file).

The package MUST provide this declaration:

```ts
declare module "virtual:use-ipc/register" {}
```

Each consuming TypeScript project includes it, for example through `compilerOptions.types`. Existing entries in that array remain necessary:

```json
{
  "compilerOptions": {
    "types": ["vite/client", "vite-plugin-use-ipc/env"]
  }
}
```

Main and preload projects use their own environment types. Including the ambient module declaration does not install the runtime or generate a registry.

## 3. Application integration

### 3.1 Vite configuration

Main and renderer builds MUST use the same source root, include patterns, source revision, and library version. The renderer's Vite root may differ from the shared source root.

```ts
// electron.vite.config.mts
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import useIpc from "vite-plugin-use-ipc";

const root = fileURLToPath(new URL(".", import.meta.url));
const include = ["src/ipc/**/*.{ts,tsx}"];

export default defineConfig({
  main: {
    plugins: [useIpc({ target: "main", root, include })],
    build: { externalizeDeps: false },
  },
  preload: {
    build: { externalizeDeps: false },
  },
  renderer: {
    plugins: [useIpc({ target: "renderer", root, include })],
  },
});
```

The configuration is an integration example for the validation versions in section 13.4. It bundles runtime dependencies to avoid duplicate registry instances. An application may retain selective externalization if the installed-package tests establish that generated references and runtime imports still share one module instance. Electron itself remains external to main and preload bundles.

There is no preload plugin target. Preload only installs the port bridge.

### 3.2 Startup and shutdown

The main entry imports the registry before it accepts connections:

```ts
import "virtual:use-ipc/register";
import { BrowserWindow } from "electron";
import { installMainIpc } from "vite-plugin-use-ipc/main";

const ipc = installMainIpc();

// Run after Electron app.whenReady() and after application services start.
export async function openWindow(preload: string, url: string) {
  const window = new BrowserWindow({
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  ipc.attach(window);
  try {
    await window.loadURL(url);
  } catch (error) {
    window.destroy();
    throw error;
  }
  return window;
}

// At application shutdown: ipc.dispose().
```

This example owns one application installation. A multi-window application creates one `MainIpc` instance and calls its `attach` method for each window. It does not call `installMainIpc` for each window.

The preload entry installs its bridge once per document:

```ts
import { installIpcPreload } from "vite-plugin-use-ipc/preload";

installIpcPreload();
```

The renderer entry imports the registry, then awaits its connection before invoking remote functions:

```ts
import "virtual:use-ipc/register";
import { installRendererIpc } from "vite-plugin-use-ipc/renderer";
import { add } from "../ipc/calculator";

async function start() {
  const disposeIpc = await installRendererIpc();
  try {
    const answer = await add(20, 22);
    return { answer, disposeIpc };
  } catch (error) {
    disposeIpc();
    throw error;
  }
}
```

The application invokes `start` and retains the disposer. `pagehide` also disposes the renderer connection automatically.

Importing the registry is safe before the transport is installed. Calling a remote function is not. An application module that makes a remote call during import evaluation violates the startup order.

An application that uses dependency bindings shuts down in this order:

1. Unbind dependencies so new handlers cannot acquire them and active lifetime signals abort.
2. Dispose the IPC installation so connections close and pending caller requests reject.
3. Dispose the application-owned services.

Ordinary work already executing requires its own shutdown policy. Closing IPC does not terminate that work.

### 3.3 Calling a renderer

```ts
// src/ipc/window-actions.ts
"use ipc:renderer";

export async function setTitle(title: string): Promise<string> {
  document.title = title;
  return document.title;
}
```

```ts
// Main, after this specific renderer reports application readiness.
import { callRenderer } from "vite-plugin-use-ipc/main";
import { setTitle } from "../ipc/window-actions";

await callRenderer(window, setTitle, "Document editor");
```

The window is explicit even when only one window exists. Calling the generated `setTitle` reference directly from main fails because it supplies no target window.

The library provides no application-readiness event. Receiving a port does not prove that the destination UI has mounted or that a lazily imported handler can use its application dependencies. The application owns that readiness condition. A document load event alone is not a substitute.

The same `callRenderer` API returns a remote iterator when its function argument is an async generator. Local renderer imports of renderer-owned functions remain ordinary local functions and require no window selection.

## 4. Source language contract

### 4.1 Directive placement

A directive is an exact, unparenthesized string-literal expression in the module's directive prologue. Either single or double quotes work. Comments, a byte-order mark, and an allowed JavaScript hashbang do not end a prologue. A non-directive statement does.

```ts
"use strict";
"use ipc:main";

export async function run() {}
```

A module has one destination. Declaring both destinations is an error. Inline function-body directives are errors even when the function is async. A directive after an import or executable statement is misplaced. A parenthesized directive is wrapped and invalid.

Validate the original source AST before TypeScript or JSX preprocessing. A transform may otherwise erase or normalize an invalid string statement before validation sees it.

Ordinary string values, comments, and unrelated directives do not enable IPC:

```ts
"use client";
const label = "use ipc:main";
// use ipc:renderer
```

Escaped spellings and template literals are outside the specified directive syntax. Implementations MUST NOT advertise them as equivalent supported spellings without additional tests.

### 4.2 Exports

Every runtime export in a directive module MUST resolve to a locally declared async function or async generator. At least one such export is required.

| Export form                      | Supported example or rule                                   |
| -------------------------------- | ----------------------------------------------------------- |
| Named async declaration          | `export async function run() {}`                            |
| Async arrow                      | `export const run = async () => 1`                          |
| Async function expression        | `export const run = async function () {}`                   |
| Local named alias                | `const run = async () => 1; export { run as execute }`      |
| Named default declaration        | `export default async function run() {}`                    |
| Anonymous default declaration    | `export default async function () {}`                       |
| Default async arrow              | `export default async () => 1`                              |
| Default local binding            | `const run = async () => 1; export default run`             |
| String export name               | `const run = async () => 1; export { run as "run-job" }`    |
| Async generator                  | Named, default, and locally aliased `async function*` forms |
| Multiple exports of one function | Each exported name gets its own remote function ID          |
| TypeScript type export           | Allowed when erased before runtime export analysis          |

Reject synchronous functions, synchronous generators, values, classes, runtime enums, namespace values, destructured export bindings, and expressions that manufacture a function. A call such as `export const run = wrap(async () => 1)` is not a locally declared async function expression.

Reject `export * from`, `export { name } from`, namespace re-exports, and imported bindings exported under a local name. Alias analysis resolves a directly declared binding, not an arbitrary assignment chain. For example, `const alias = run; export { alias }` is not a supported function declaration form.

Type-only declarations do not satisfy the requirement for a runtime function export. A type-only module with an IPC directive therefore fails the nonempty-export check.

Private helpers, private values, imports, side effects, and module state are allowed. They remain in the destination module. A private helper may be synchronous.

Default parameters, parameter destructuring, rest arguments, generics, recursion, and TypeScript annotations retain their ordinary destination behavior. No dynamic `this` value is transported. Functions that depend on caller-supplied `this`, custom function properties, or reference equality between different exported aliases are outside the remote contract.

The accepted filename extensions include `js`, `jsx`, `ts`, `tsx`, `mjs`, `mts`, `cjs`, and `cts`. The suffix does not add support for CommonJS `module.exports` as an IPC declaration. IPC export analysis uses ESM exports.

### 4.3 Typo diagnostics

Inspect standalone string-literal expressions for likely directive typos. Compare each candidate with both valid directives:

- Equal lengths are similar when one or two character positions differ.
- Lengths that differ by one are similar when a single insertion or deletion makes them equal.
- Other strings are not similar.

An exact match is handled as a directive, not a typo. This deliberately narrow check catches examples such as `"useipc:main"` and `"use ipc:maim"`. Do not apply typo errors to string values used as data.

A cheap text prefilter may avoid parsing unrelated modules, but it MUST still find the specified typo candidates. The AST decides whether a candidate is a standalone expression and whether its placement is valid.

### 4.4 Type safety boundary

TypeScript reads the original modules. The plugin does not generate a second application interface or rewrite TypeScript's module resolver. Editor completion and call checking use the original exports.

This preserves function types but does not prove structured-clone compatibility, application authorization, process direction, or installation order. Runtime schemas are application code. A typed function returning a non-cloneable value still fails at the transport boundary.

## 5. Discovery and compilation

### 5.1 Options and discovery

| Option    | Contract                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `target`  | Required. The current build's process, `main` or `renderer`.                                                             |
| `root`    | Required. Resolved to an absolute path relative to the configuration process's working directory. Shared by both builds. |
| `include` | Optional array of glob patterns relative to `root`. Default: `src/**/*.{js,jsx,ts,tsx,mjs,mts,cjs,cts}`.                 |

Each plugin instance owns its discovery map. It scans matching files without executing them, ignores `node_modules` and `*.d.ts`, and processes paths in deterministic sorted order. Ordinary discovered files produce no IPC entry.

Every imported directive module MUST belong to the discovered set. Encountering one outside `include` is a build or dev transform error. The diagnostic identifies the file and explains that both builds must discover the module before registry generation.

Discovery includes all runtime exports in matching directive modules, even exports not imported by application caller code. This registry defines the callable set. Tree-shaking caller imports does not act as an authorization rule.

Source filenames are canonical resolved module IDs for map lookup. Relative-path hashing normalizes Windows separators to `/`. Alias and symlink resolution MUST NOT create two registry identities for what Vite treats as one destination module. Cross-platform and symlink cases need the release checks in section 15.

Query imports of discovered directive modules are errors, including `?raw` and `?url`. A query MUST NOT expose implementation source or bypass the IPC transform. Ordinary non-IPC asset queries retain Vite's normal behavior. Virtual implementation entries are exempt from source discovery checks because the plugin creates them.

### 5.2 Transform order

The plugin runs for both `serve` and `build`, with `enforce: "pre"`. It does not depend on production tree-shaking. Vite orders pre plugins before its core plugins and ordinary user plugins. Hook ordering remains relevant when another plugin also runs early. See [Vite plugin ordering](https://vite.dev/guide/api-plugin#plugin-ordering).

For each candidate module, the compiler performs these steps:

1. Read the original source text and keep it for identity and source maps.
2. Parse that text with the appropriate JavaScript, TypeScript, or JSX grammar.
3. Validate directives on the original AST.
4. Lower TypeScript and JSX while retaining async function and generator forms for export analysis.
5. Analyze runtime exports on the resulting JavaScript AST.
6. Compute the module key and function IDs from the original source.
7. Produce either a destination implementation or a caller replacement for the current target.
8. Produce metadata for destination registry generation.

An implementation using Vite's Oxc transform applies compatible resolved transform settings. It omits Vite-only filtering and injection settings such as `include`, `exclude`, `jsxInject`, `jsxRefreshInclude`, and `jsxRefreshExclude` when calling the lower-level transform. Differences in preprocessing do not enter function IDs.

A plugin that rewrites exports or erases async semantics before discovery may be incompatible. Native React compilation belongs after IPC replacement. IPC modules are read from source during discovery, so arbitrary preceding plugin transformations are not a supported source language extension.

### 5.3 Stable function identity

Use this exact algorithm:

```text
digest(text) = first 16 lowercase hexadecimal characters of SHA-256(UTF-8(text))
relativePath = path.relative(root, absoluteSourcePath), with "\\" replaced by "/"
moduleKey = digest(relativePath) + ":" + digest(originalSourceText)
functionId = moduleKey + ":" + exportedName
```

`exportedName` is the actual external name, including `default` and string-literal names. The export name is appended, not hashed separately. Source text is not normalized. Comments, whitespace, and line-ending changes therefore change its digest.

The same relative path and exact source text produce the same IDs across absolute checkout locations and build targets. Renaming a file or changing its text changes every function ID in that module. Changing only a dependency file does not change the importing module's IDs.

A conformance vector uses `src/ipc/calculator.ts` as the relative path and the source text represented by this JSON string. Its final `\n` is one LF character:

```json
"\"use ipc:main\"; export async function add(a, b) { return a + b; }\n"
```

The expected module key is `11b00b529403b8f2:6f3cee61065efeba`. The `add` function ID is `11b00b529403b8f2:6f3cee61065efeba:add`.

Generated code MUST quote IDs and export names safely. A colon inside an exported name must not require protocol parsing because a function ID is opaque during transport.

IDs are versioned references, not secrets or authentication tokens. The truncated hash is an identity scheme, not a security boundary. The runtime performs no source-version negotiation. A mismatched reference normally fails with `Unknown IPC function`.

### 5.4 Caller replacement

When the build target differs from the directive destination, replace the entire module with generated references:

```js
import { reference } from "virtual:use-ipc/runtime";

const ref0 = reference("main", "<module-key>:add", "function");
export { ref0 as "add" };
```

The kind is either `function` or `async-generator`. A generator proxy returns an async iterator synchronously. A function proxy returns a Promise and converts installation or connection failures into Promise rejections.

The replacement contains no original imports, implementation statements, side effects, or private state. Vite must receive that replacement before it traverses the implementation's imports in the caller build. Destination-only imports may deliberately be unavailable in the caller environment.

The replacement has no original-source map. It MUST NOT embed destination source text through `sourcesContent`. This rule protects the module boundary of the transform. It does not make an Electron application bundle a secret store.

### 5.5 Destination implementation and registry

When the build target matches the directive destination, retain the preprocessed module and remove the IPC directive. Compose the directive-removal source map with the preprocessing source map so implementation locations map back to the original source.

Each discovered module contributes a virtual entry shaped like:

```js
import * as implementation from "/absolute/source/module.ts";

export const handlers = {
  "<module-key>:add": implementation.add,
};
```

The import resolves through the source's normal Vite module ID. Do not copy the implementation into a second virtual module. A normal local import and a remote call MUST share module initialization, private state, and imported dependencies.

The registration module installs a lazy loader for every function whose destination matches the current build. It imports no destination implementation eagerly. Each loader imports the corresponding virtual entry and selects that function's handler.

The loader caches its Promise on first invocation, including concurrent first invocations. A failed import remains a rejected cached Promise for that registered loader. There is no automatic retry. Registering a new loader or starting a fresh runtime creates a new cache.

ESM module caching prevents separate exported-function loaders from evaluating the same implementation multiple times. Ordinary application imports can cause earlier evaluation. Discovery itself never evaluates source, although the destination build must still resolve and bundle its dependencies.

The handler table MUST have no inherited callable entries. Lookup checks own properties. Names such as `toString` must not resolve to Object prototype methods.

## 6. Runtime ownership

The implementation has these responsibilities:

| Component          | Owns                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Compiler           | Directive diagnostics, export analysis, identities, generated code, source maps             |
| Vite plugin        | Discovery, module resolution, virtual modules, watch invalidation                           |
| Reference registry | Function metadata, lazy handlers, one active transport resolver per realm                   |
| Peer               | One connection's requests, streams, message validation, and disposal                        |
| Main adapter       | Attached windows, accepted connections, navigation and window listeners                     |
| Preload adapter    | Transfer of a dedicated port between isolated and main worlds                               |
| Renderer adapter   | Startup handshake, its peer, page lifetime                                                  |
| Binding helper     | An explicitly supplied dependency and its lifetime signal                                   |
| Application        | Service construction, argument validation, authorization, UI readiness, and state semantics |

The runtime's handler table and active transport resolver MUST be singletons within one bundled realm. They are not shared across processes. Each renderer has its own instance.

Generated references carry private metadata in a WeakMap or equivalent identity-based structure. Creating a reference is safe before installation. Invoking it resolves the current connection. References do not permanently capture a particular main installation or window connection.

Exactly one transport resolver may be configured at a time in a realm. A second active configuration throws `IPC runtime already installed`. A disposer clears the resolver only if it still owns that configuration.

Main resolves only renderer destinations, using the selected window's `webContents.id`. Renderer resolves only main destinations, using its own peer. A target-process import is an ordinary function and bypasses this resolution completely.

Existing remote iterators retain the peer on which they opened. Replacing a connection does not migrate an iterator, pending request, or function execution.

## 7. Connection establishment and lifecycle

### 7.1 Port setup

The setup uses Electron IPC only to transfer a MessagePort. Calls and iterator messages then use that port directly. Electron documents port transfer and its renderer-side close event in [MessagePorts in Electron](https://www.electronjs.org/docs/latest/tutorial/message-ports).

```text
renderer main world           isolated preload                  main
       |                            |                            |
       | request-port { id }        |                            |
       |--------------------------->|                            |
       |                            | create MessageChannel      |
       |                            | connect + port1            |
       |                            |--------------------------->|
       | port { id } + port2        |                            |
       |<---------------------------|                            |
       |                                                         |
       |<============ call and stream messages =================>|
```

The renderer generates an opaque request token using `crypto.randomUUID()`. It registers a message listener before posting `{ type: "use-ipc:request-port", id }` to its own window.

Preload accepts that message only when `event.source === window`, the message type matches, and `id` is a string. It creates a fresh `MessageChannel`, transfers `port1` with `ipcRenderer.postMessage("use-ipc:connect", null, [port1])`, and transfers `port2` to the renderer with `{ type: "use-ipc:port", id }`.

Renderer accepts a reply only when `event.source === window`, the type and token match, and exactly one port is attached. It removes the listener and startup timeout, starts the port, creates its peer, configures references, and resolves with a disposer.

Port delivery uses `window.postMessage` with `"*"` as the target origin to support the isolated-world bridge and application protocols. The token correlates replies. It does not authenticate code running in that same page.

If no matching port arrives within 10,000 milliseconds, startup rejects with `IPC preload connection timed out` and removes its listener. No call timeout is implied by this startup timeout.

Main accepts a connection only when:

1. The sender's `webContents.id` belongs to an attached window.
2. `event.senderFrame` is the sender's current main frame.
3. Exactly one port was transferred.

Main closes all received ports for a rejected connection. A valid replacement connection closes the previous peer before installing the new one. Main starts each accepted port and handles its `message` and `close` events.

There is no acknowledgement from main in this handshake. Renderer installation resolving proves receipt of a preload-provided port, not acceptance by main. Correct attachment order is required. Application readiness remains a separate condition.

### 7.2 Attachment and disposal

`installMainIpc` installs one Electron connection listener. `attach(window)` registers a window for future connections. Reattaching the same `webContents.id` to the same live installation is a no-op. Attach before loading the window's URL.

| Event                                         | Required effect                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Main-frame navigation to a different document | Close the current peer, retain attachment for the new document                             |
| In-page navigation or subframe navigation     | Keep the current peer                                                                      |
| Renderer process gone                         | Close the current peer, retain attachment                                                  |
| Window closed                                 | Close its peer, remove its listeners, delete attachment                                    |
| New valid port from an attached main frame    | Close its previous peer and use the new one                                                |
| Renderer `pagehide`                           | Close peer, clear owned resolver, remove pagehide listener                                 |
| Renderer disposer                             | Same effect as pagehide, idempotently                                                      |
| Main disposer                                 | Remove connection listener, dispose all attached entries, clear windows and owned resolver |
| Preload disposer                              | Remove request-port listener; already transferred connections remain peer-owned            |

Disposing main or renderer is idempotent. The application does not call `attach` on a disposed installation. To restart main IPC explicitly, create a new installation and attach its windows again.

A closed peer cannot reopen. A new document runs preload and renderer startup again. The library does not initiate a reconnect within an existing renderer document.

### 7.3 Peer disposal

Closing a peer MUST immediately mark it closed, detach port listeners, close the port, notify local close listeners, and reject every pending outgoing request with `IPC connection closed`.

It also aborts controllers for handlers still opening and for retained streams. For each retained iterator, it requests `return()` as best-effort asynchronous cleanup. It clears pending requests, retained streams, opening controllers, and per-stream work queues.

Cleanup failures during connection teardown do not reopen the connection or create unhandled rejections. The close operation does not await a potentially blocked iterator. Already executing ordinary handlers may continue, but their responses are discarded after closure.

## 8. Message protocol

### 8.1 Transport interface

The peer depends on a small adapter that contains no Electron-specific policy:

```ts
interface Port {
  postMessage(message: unknown): void;
  listen(receive: (message: unknown) => void, closed: () => void): () => void;
  close(): void;
}
```

`listen` installs callbacks and returns a listener disposer. The adapter starts its underlying port where required. `postMessage` may throw synchronously for an uncloneable value or a transport failure.

### 8.2 Wire shapes

Both ends use the same protocol. No envelope version is added in this release.

```ts
type Request =
  | {
      type: "request";
      id: number;
      method: "call";
      functionId: string;
      args: unknown[];
    }
  | {
      type: "request";
      id: number;
      method: "open";
      functionId: string;
      args: unknown[];
      signalIndex?: number;
    }
  | {
      type: "request";
      id: number;
      method: "next" | "return" | "throw";
      streamId: number;
      value: unknown;
    };

type SerializedThrown =
  | { kind: "value"; value: unknown }
  | {
      kind: "error";
      name: string;
      message: string;
      stack?: string;
      cause?: SerializedThrown;
      aggregateErrors?: SerializedThrown[];
      properties?: Record<string, unknown>;
    };

type Response =
  | { type: "response"; id: number; ok: true; value: unknown }
  | {
      type: "response";
      id: number;
      ok: false;
      error: SerializedThrown;
    };

type Cancel = { type: "cancel"; id: number };
```

In `Cancel`, `id` is the destination's stream ID, not a request ID. Cancellation has no response and consumes no pending-request slot.

Each peer starts its outgoing request sequence and allocated stream sequence at zero and increments before allocation. Request IDs correlate responses only within that peer. Stream IDs identify iterators owned by the receiving peer. Identical numbers in another window or the opposite request direction do not collide.

Generated IDs are positive safe integers and are not reused during a connection. Implementations must avoid wrapping into a still-live ID. Sequence exhaustion is not a tested baseline case and belongs to release verification.

### 8.3 Incoming validation

Parse incoming messages from `unknown`. Validate the envelope before executing a handler:

- Every message has a safe-integer `id` and a recognized `type`.
- A successful response contains a `value` property, even when its value is `undefined`.
- A failed response contains a valid `SerializedThrown`. Value variants require an own `value` property. Error variants require string `name` and `message`, an optional string `stack`, recursively valid causes and aggregate contents, and optional object properties. Reject cyclic or over-depth encoded error trees.
- `call` and `open` contain a string `functionId` and an array `args`.
- `signalIndex`, when present, is allowed only on `open` and is an integer within the argument array.
- Iterator operations contain a safe-integer `streamId` and a `value` property.

Ignore malformed messages, messages received after closure, unknown response IDs, and cancellation of unknown streams. Extra properties do not change dispatch. Validation does not inspect application argument schemas.

Dispatch a function only if its ID is an own property of the handler table. An unknown function produces an error response. Do not evaluate a received function name as JavaScript or resolve it as a filesystem path.

The generated client distinguishes function and generator kinds. The wire protocol does not separately authenticate that distinction. A hand-written message that uses the wrong method for a registered export has no useful supported result.

### 8.4 Ordinary calls and errors

Before sending a request, reserve a pending-request entry. If serialization or posting fails, remove that entry and reject the caller. The peer remains usable for subsequent requests.

On `call`, invoke the destination handler with the argument array and await its result. Calls may execute concurrently and finish out of order. Match replies by request ID. The transport provides no transaction, retry, deduplication, or exactly-once completion guarantee across disconnects.

Error transport adopts the use-worker behavior locally, without a shared dependency. For Error instances, preserve name, message, optional destination stack, cause presence and value, AggregateError contents, and cloneable enumerable own data properties. Reconstruct Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, and AggregateError. Custom subclasses retain their name and data but not their prototype. Standard fields cannot be overwritten by the custom-property envelope.

Cloneable non-Error throws retain their original value, including undefined. Non-cloneable thrown values fall back to an Error description. If even describing the error fails, send a generic serialization-failure Error. Skip custom accessor properties and non-cloneable custom data properties. Define received custom properties as own data properties, including names such as __proto__, without changing the error prototype.

Track error ancestors to truncate circular causes and aggregate entries; repeated references in separate branches are serialized independently. Truncate error chains at depth 64. Error-object identity is not preserved. Stack text remains destination stack text. No automatic redaction or typed application error-code contract is introduced. Both peers must use the updated codec; legacy error envelopes are not supported.

If posting a success response fails because its value is not cloneable, send an error response through the same request ID. One clone failure must not poison unrelated requests. If the transport cannot send even an error reply, delivery is not guaranteed. A posting failure without an accompanying close event requires the release audit in section 15.

### 8.5 Value semantics

Arguments, return values, yielded values, and values passed to iterator methods use structured clone. There is no JSON conversion and no user transfer list. Plain data, Maps, and ordinary ArrayBuffers MUST work in the conformance suite. ArrayBuffers are copied without detaching the sender's buffer.

Functions, DOM nodes, and Electron host objects are outside the supported data contract. Prototype preservation is not promised. Promise-valued async function results are awaited before transport. An async function that returns an iterator does not become a stream merely because its result is iterable. The export must be an async generator.

Electron's serialization restrictions are described in its [IPC renderer documentation](https://www.electronjs.org/docs/latest/api/ipc-renderer). The library's tests, not generic structured-clone support in an unrelated browser, establish its supported values.

## 9. Remote async generators

### 9.1 Lazy creation and pull behavior

Calling a generated async generator reference checks connection availability and returns an object implementing `AsyncGenerator`. It does not open a remote stream or run the generator body until its first `next()`.

On the first advancing `next()`:

1. Send `open` with the function ID and prepared arguments.
2. Destination creates an AbortController and tracks it while the lazy handler loads.
3. Destination replaces the designated signal slot when present and awaits the handler result.
4. Destination validates that the result is an object with a callable `next` method.
5. Destination retains the iterator under a new stream ID and replies with that ID.
6. Caller sends `next` with the stream ID and the supplied value.

Subsequent iterator operations use that stream ID. There is no prefetch. One `next()` requests one iterator result. An application may choose to yield a batch as that result's value.

If the connection closes or the stream limit is reached while an iterator is opening, abort its controller, request cleanup, and do not retain it.

### 9.2 Ordering and results

Each caller iterator has a Promise chain that serializes operations in invocation order. A rejected operation does not leave the chain permanently rejected. Different iterators and ordinary calls may progress concurrently.

Destination also serializes `next`, `return`, and `throw` operations per stream. A `return` aborts the stream controller immediately upon receipt, before waiting behind an earlier operation.

Forward `next(value)` to `iterator.next(value)`, `return(value)` to `iterator.return(value)`, and `throw(value)` to `iterator.throw(value)`. Values passed to `return` are awaited locally before posting, matching the existing async generator contract. No other arguments are recursively awaited.

Preserve both fields of each iterator result, including a final return value. On `{ done: true, value }`, abort the destination controller, remove the stream, mark the caller iterator finished, and remove its cancellation and connection listeners.

A `return()` result can have `done: false` when the producer yields inside `finally`. That stream remains active and can be advanced again. Do not replace a cleanup yield with a fabricated terminal result.

```ts
"use ipc:main";

export async function* example(): AsyncGenerator<number, number | undefined, unknown> {
  try {
    yield 1;
  } finally {
    yield 2;
  }
  return undefined;
}
```

For `example`, after the first `next()`, `return(7)` produces `{ done: false, value: 2 }`. The following `next()` produces `{ done: true, value: 7 }`.

If `throw` is handled inside the generator and yields a value, the stream continues. If an iterator operation throws out of the producer, remove the stream, abort its controller, attempt `return()`, and reject that operation. Cleanup is cooperative and may itself fail or wait.

If opening, advancing, or validating a stream reply fails at the caller, mark that iterator finished and detach its listeners. If a stream ID is known, await a best-effort remote `return(undefined)` and ignore failure of that cleanup request before rejecting with the original caller-side error. This closes a producer whose yielded value could not be cloned. It can still wait on non-cooperative destination cleanup.

Breaking a `for await` loop requests `return()`. It does not repeatedly drain values yielded during cleanup. Applications that yield in `finally` own the consequences of abandoning a still-active iterator.

### 9.3 Terminal and unopened behavior

| Iterator state and operation                | Result                                                        |
| ------------------------------------------- | ------------------------------------------------------------- |
| Never advanced, `return(value)`             | No remote open. Resolve `{ done: true, value: await value }`. |
| Never advanced, `throw(value)`              | No remote open. Reject with `value`.                          |
| First `next` with an already-aborted signal | No remote open. Resolve `{ done: true, value: undefined }`.   |
| Finished, `next()`                          | Resolve `{ done: true, value: undefined }`.                   |
| Finished, `return(value)`                   | Resolve `{ done: true, value: await value }`.                 |
| Finished, `throw(value)`                    | Reject with `value`.                                          |
| Pending operation when connection closes    | Reject the pending request with a connection error.           |

An iterator that has subscribed to peer closure marks itself finished when that peer closes. Later operations follow terminal behavior. An unopened iterator that has never subscribed still encounters the closed peer when it first tries to open.

For an incoming operation on an unknown or completed stream, destination returns `{ done: true, value: undefined }`, except that `return` echoes its supplied value. This is transport cleanup behavior. The public caller handles its own finished-state `throw` before sending it.

`[Symbol.asyncIterator]()` returns the same iterator. `[Symbol.asyncDispose]()` awaits `return(undefined)` when that language capability is available in the supported runtime.

### 9.4 AbortSignal forwarding

A remote async generator accepts at most one top-level AbortSignal argument. The caller recognizes the signal, replaces its argument slot with `undefined`, and sends `signalIndex` in `open`. Destination inserts its own controller's signal at that slot.

Multiple top-level signals throw a TypeError when the iterator is created. Nested signals, cross-realm signal detection beyond the supported realm, and signals on ordinary async calls are unsupported. Abort reasons are not transported.

Caller cancellation is independent of the iterator operation queue:

- Calling `return()` immediately requests cancellation, even when a previous `next()` is pending.
- Aborting the caller signal immediately requests cancellation and queues a best-effort `return(undefined)`.
- If the stream ID is known, cancellation sends `Cancel` immediately.
- If `open` is pending, remember cancellation and send it as soon as the stream ID arrives, before the next iterator request.
- Destination handles `Cancel` by aborting that stream's controller without waiting for queued work.
- Disconnect aborts both opening and retained destination controllers.

Cancellation by itself does not remove the retained iterator or invent a completed response. The awaited producer operation determines what happens next. A cooperative reader may resolve its pending `next()` with `done: true`. A producer that throws on abort propagates that error.

The generator MUST pass its received signal to the work it awaits when prompt cleanup is required. `return()` cannot interrupt an arbitrary unresolved Promise. The runtime does not terminate threads or main-process work.

### 9.5 Bounds and backpressure

| Resource                                            | Default bound | Overflow behavior                                        |
| --------------------------------------------------- | ------------- | -------------------------------------------------------- |
| Pending outgoing requests per peer                  | 256           | Reject the next request with `IPC request limit reached` |
| Retained incoming streams per peer                  | 256           | Reject the excess open and request iterator cleanup      |
| Queued and executing operations per caller iterator | 256           | Reject with `IPC iterator request limit reached`         |

The public API exposes no limit options in this release. Tests may inject smaller peer limits internally. Queue entries are released when their operation settles, including on rejection. Completed streams free their retained slot.

Cancellation does not consume an outgoing request slot. A caller `return()` attempts its immediate cancellation even if queuing the return operation then exceeds the iterator bound.

These bounds apply to cooperative generated clients. They do not cap message byte size, producer buffers, all incoming handler work, or all stream opens still loading. They are not a complete resource defense against a page that sends arbitrary protocol messages.

## 10. Explicit dependency binding

`createIpcBinding<T>(name)` creates an independent binding. Its name is used in errors and does not identify a global registry slot. Two bindings with the same name remain independent.

The binding has two states:

```text
unbound -- bind(value) --> bound(value, lifetime signal)
bound   -- disposer() --> unbound, previous lifetime signal aborted
```

`get()` throws `<name> is not bound` before the first bind and after unbinding. `bind()` throws `<name> is already bound` while an owner is active.

`bind(value)` returns an idempotent disposer. It first clears the binding, then aborts that binding's signal. An abort listener that calls `get()` therefore observes the unbound state. A stale disposer cannot clear a later binding.

A lease obtained from `get()` retains its original value and signal after unbinding. The helper does not mutate or dispose that value. Capture the lease once at the start of an operation so an await cannot accidentally switch the operation to a new owner.

```ts
// src/services/event-binding.ts, an ordinary module without an IPC directive.
import { createIpcBinding } from "vite-plugin-use-ipc/binding";

export interface EventReader {
  next(): Promise<IteratorResult<string, undefined>>;
  close(): void;
}

export interface EventSource {
  open(signal: AbortSignal): EventReader;
}

export const eventsBinding = createIpcBinding<EventSource>("event source");
```

```ts
// src/ipc/events.ts
"use ipc:main";
import { eventsBinding } from "../services/event-binding";

export async function* watchEvents(signal: AbortSignal) {
  const lease = eventsBinding.get();
  const reader = lease.value.open(AbortSignal.any([signal, lease.signal]));
  try {
    while (true) {
      const next = await reader.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.close();
  }
}
```

The application implements `EventSource`. In this example, aborting or closing a reader must wake an idle `next()` with a completed result. That is the event source's contract, not functionality supplied by the binding or IPC runtime.

The main entry constructs and starts the event source, then calls `eventsBinding.bind(source)` before attaching windows. Directive modules import the binding module. They do not import the main entry or construct an application singleton.

## 11. Trust and application boundaries

An attached window's main-frame document can call every main handler in the generated registry. There is no per-window function allowlist, origin policy option, or hidden privilege attached to a particular imported reference.

Main validates attachment and frame identity at connection establishment. It does not validate the document origin. After a navigation, attachment remains active and a new main-frame document can request another connection. The application must keep attached windows on trusted application content and control navigation accordingly. Electron recommends validating IPC senders in its [security guidance](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages).

The preload bridge exposes a port, not `ipcRenderer`, a raw Electron event, or an unrestricted contextBridge object. A script already executing in that page can participate in the port exchange. Context isolation and the correlation token do not authorize that script's business operations.

No sender window, frame, or Electron event is appended to handler arguments. A main handler receives only its declared arguments, with the stream signal substitution where applicable. Applications requiring authenticated caller context or per-window permissions need a separately designed API extension.

The initial release supports trusted application documents and application-defined validation. It does not claim to make privileged handlers safe for arbitrary remote pages. Function IDs and omitted caller implementation code must not be described as access control.

## 12. Development behavior and diagnostics

### 12.1 Watch and reload

The plugin watches discovered files and the directory prefixes needed to detect additions. A refresh rescans the configured patterns and rebuilds the discovery map. It uses a generation counter or equivalent ordering rule so an older asynchronous scan cannot overwrite a newer one.

After a relevant refresh, invalidate the registration module and generated entry modules, remove stale exports from newly generated registries, and issue a full renderer reload. The plugin does not hot-swap a live peer's handlers. A conservative implementation may rescan and reload on every watched change.

Source IDs change on any edit to their module text. Removing a module or export removes it from the next registry. Adding a module inside `include` makes it discoverable without restarting the Vite server. An invalid edit reports its compiler error rather than installing a partially valid registry.

For a main-owned module change, the main build must also rebuild and the Electron main process must restart. The plugin does not manage that process. Main and renderer build watchers may observe an edit at different times. Mixed revisions can temporarily reject calls until both processes restart with matching source.

A dependency-only edit may leave IDs unchanged. The destination's normal module rebuild or process restart is still required. IDs are not hashes of the entire transitive dependency tree.

### 12.2 Diagnostics contract

Compiler errors identify the source file and export or directive involved. Where an AST node position is available, report it. Original directive positions are measured before preprocessing. Error wording may improve, but these conditions remain distinguishable:

| Condition                        | Diagnostic content                                               |
| -------------------------------- | ---------------------------------------------------------------- |
| Wrong directive placement        | `misplaced directive` or `wrapped directive`                     |
| Similar unsupported spelling     | `misspelled directive` and the actual spelling                   |
| Inline directive                 | Module-level directives required; inline definitions unsupported |
| Both destinations                | An IPC module must have exactly one target                       |
| Invalid runtime export           | Export name where available; async function requirement          |
| Imported export or re-export     | Locally declared function required or re-export unsupported      |
| No callable runtime exports      | At least one async function required                             |
| Directive file outside discovery | File path, `useIpc.include`, and matching-build requirement      |
| Query import                     | IPC modules do not support query imports and the requested ID    |

Runtime errors include these existing messages or equivalent wording with the same meaning:

| Condition                                      | Error                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| Invocation before configuration                | `IPC runtime is not installed`                                       |
| Duplicate active configuration                 | `IPC runtime already installed`                                      |
| Main reference targets main                    | `Main IPC references must target a renderer`                         |
| Renderer reference targets renderer            | `Renderer IPC references must target main`                           |
| Missing window selection or connection         | Target renderer is not connected; use `callRenderer` after readiness |
| `callRenderer` receives an ordinary function   | TypeError: expected a function transformed by use-ipc                |
| Port startup timeout                           | `IPC preload connection timed out`                                   |
| Closed peer                                    | `IPC connection closed`                                              |
| Unknown function                               | `Unknown IPC function`                                               |
| Pending-request overflow                       | `IPC request limit reached`                                          |
| Invalid opened iterator                        | TypeError: `IPC stream did not return an iterator`                   |
| Stream overflow or connection lost during open | `IPC stream limit reached or connection closed`                      |
| Iterator queue overflow                        | `IPC iterator request limit reached`                                 |
| Multiple signal arguments                      | TypeError: `IPC streams accept one top-level AbortSignal`            |
| Invalid stream reply                           | TypeError identifying invalid stream ID or iterator result           |

Generated async function proxies reject on invocation failures. Generator reference creation can throw synchronously. `callRenderer` can also throw synchronously while validating its argument or choosing a connection, even when the underlying export is an async function.

The library does not log successful calls, arguments, payloads, or user data by default. It introduces no telemetry service.

## 13. Implementation layout and distribution

### 13.1 Module layout

A suitable source layout is:

```text
src/
  vite.ts                 plugin factory and Vite hooks
  compiler/
    directives.ts         directive recognition and diagnostics
    exports.ts            local export analysis
    compile.ts            identities, generated code, source maps
  runtime/
    peer.ts               protocol, requests, streams, cancellation
    references.ts         singleton registry and reference metadata
    main.ts               Electron main adapter and window lifecycle
    preload.ts            isolated-world port transfer
    renderer.ts           renderer setup and page lifecycle
    binding.ts            explicit dependency lifetime
  env.d.ts                ambient virtual module declaration
tests/
  compiler/
  runtime/
  vite/
  electron/
  package/
examples/
  basic/
```

This layout is advisory. Ownership and public module boundaries are required. The peer must run in tests over real `node:worker_threads` MessageChannels without importing Electron. The binding must run without the peer.

The selected package design keeps runtime and compiler versions together while isolating their imports by entry point. Splitting them into independent packages introduces version coordination without changing the initial caller API. A manual handler-registration library would remove compilation but would not preserve ordinary source imports, so it is outside this specification.

### 13.2 Published files and exports

Publish compiled JavaScript and `.d.ts` declarations. Users must not need a loader for TypeScript files in `node_modules`. Package-internal runtime resolution must point to installed distribution files, not repository source paths or a consumer-relative plugin directory.

The following export map illustrates the required layout. Every referenced file must exist in the packed tarball:

```json
{
  "name": "vite-plugin-use-ipc",
  "type": "module",
  "files": ["dist", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
  "exports": {
    ".": { "types": "./dist/vite.d.ts", "import": "./dist/vite.js" },
    "./main": { "types": "./dist/runtime/main.d.ts", "import": "./dist/runtime/main.js" },
    "./preload": { "types": "./dist/runtime/preload.d.ts", "import": "./dist/runtime/preload.js" },
    "./renderer": {
      "types": "./dist/runtime/renderer.d.ts",
      "import": "./dist/runtime/renderer.js"
    },
    "./binding": { "types": "./dist/runtime/binding.d.ts", "import": "./dist/runtime/binding.js" },
    "./env": { "types": "./dist/env.d.ts" }
  },
  "sideEffects": true,
  "keywords": ["vite-plugin", "electron", "ipc", "typescript"]
}
```

Start with conservative side-effect metadata. The generated registry's side-effect import MUST survive optimization. Narrowing the metadata is allowed only when an installed, minified consumer test proves registration still occurs.

Keep the internal `references` module shared among main or renderer runtime entry points and generated virtual imports. Do not separately inline its mutable state into each entry point. Bundling it twice creates a configured resolver with no handlers or registered handlers with no resolver.

The package is ESM for Vite configuration. Main and preload consumers may bundle it into CommonJS outputs through Vite. This does not require a second native CommonJS package entry. A CommonJS preload must contain its bundled runtime code because a sandboxed preload cannot rely on arbitrary package loading at runtime.

The package can be a development dependency when the consumer bundles all required runtime files into the shipped application. Externalized runtime files require the package to ship as an application dependency instead. The basic example uses the bundled arrangement.

### 13.3 Dependencies

Vite is a peer dependency for the plugin. Electron is supplied by the consuming application and remains external. It may be an optional peer to avoid forcing an Electron binary installation for compiler-only use. The package's own Electron tests install it as a development dependency.

The compiler needs source parsing, TypeScript and JSX lowering, AST traversal, SHA-256 hashing, source-map edits, source-map composition, and file globbing. Existing compatible choices include Vite's parser and Oxc transform, `estree-walker`, `magic-string`, `@jridgewell/remapping`, and `tinyglobby`. Their specific APIs are replaceable if the conformance behavior is preserved.

Renderer runtime code requires only JavaScript and browser APIs. Main runtime code imports Electron. Preload runtime code imports Electron and uses window messaging. The runtime has no application, React, state-management, event-feed, or worker-library dependency.

Copying existing third-party code requires keeping its applicable license and notices. An independent implementation may use a different parser or write its own analysis. The final package must identify actual included dependencies and adaptations, not retain notices for files it does not distribute.

### 13.4 Compatibility baseline

The inspected validation environment contains these versions. This is a starting test environment, not a claim that all earlier or later versions work:

| Tool          | Version      |
| ------------- | ------------ |
| Node          | 24.19.0      |
| Vite          | 8.3.0        |
| Electron      | 44.3.0       |
| electron-vite | 6.0.0-beta.1 |
| TypeScript    | 7.0.2        |
| Vitest        | 5.0.0        |

The initial implementation should reproduce the baseline before broadening compatibility. Publish peer and engine ranges only for tested versions. Do not infer Vite 6 or 7 support from a generic `Plugin` type when the implementation uses Vite's newer parser and Oxc APIs.

The transport assumes MessageChannel, Electron MessagePort close events, AbortController, crypto.randomUUID, and the async iterator protocol. Examples that combine lifetimes additionally use AbortSignal.any. Async disposal declarations require matching TypeScript library support.

macOS, Windows, and Linux distribution claims require the corresponding Electron integration jobs. Browser-only execution, generic Node execution of the renderer adapter, and renderer web SSR are not supported targets. Vite's main-process SSR-style build mode is a separate supported bundling technique.

## 14. Conformance suite

Tests must exercise the built artifacts and real transport boundaries. A mock function that already behaves like the desired proxy cannot establish compiler or serialization correctness.

### 14.1 Compiler cases

Run export and runtime transformation cases for both destinations:

- Every accepted export form in section 4, including multiple aliases and string names.
- Private imports, top-level side effects, and private state absent from caller output.
- A destination-only import that cannot resolve or execute in the caller environment.
- Shared module state across ordinary destination imports and remote invocation.
- Default parameters, rest arguments, recursion, and erased type exports.
- Named, default, and aliased generators.
- Each invalid directive placement, likely typo, and invalid runtime export.
- Ordinary strings and comments that do not trigger compilation.
- Identical IDs across different absolute roots and preprocessing settings.
- Changed IDs after edits or renames and unchanged IDs after unrelated file changes.
- Generated quoting for unusual export names.
- Type-check fixtures for valid and invalid argument tuples, return types, generator yield and next types, `callRenderer`, and the ambient registration import.
- Destination source maps that recover an original TypeScript throw location.
- Caller maps and chunks that contain no destination source content.

At least one test evaluates transformed caller exports against compiled destination handlers over a transport. Snapshot comparisons alone do not establish callable behavior.

### 14.2 Peer and binding cases

Use real Node MessageChannels with structured clone for peer tests:

- Concurrent calls whose replies complete in a different order.
- Maps and ArrayBuffers, including proof that buffers are not detached.
- Unknown functions, prototype-property IDs, invalid envelopes, and unknown replies.
- Uncloneable arguments and results followed by a successful call on the same peer.
- Remote standard error types, name, message, stack, custom properties, nested causes and aggregates, cloneable non-Error throws, serialization fallback, and malformed nested error envelopes.
- Lazy generator opening and one pull per `next`.
- `next(value)`, caught `throw(value)`, return values, and finally yields.
- Queued operations after completion and per-stream serialization.
- A generator yielding an uncloneable value and receiving cleanup.
- Pending-request, retained-stream, and iterator-queue limits with slot reuse.
- Pending requests rejected on either side's closure and disposal idempotence.
- Two simultaneous peers with coinciding request and stream numbers.
- An already-aborted signal that opens no stream.
- Multiple top-level signals rejected and abort reasons omitted.
- Cancellation while a lazy handler is still loading.
- Cancellation while an actual producer is awaiting an idle read.
- Dependency unbinding, rebinding, stale disposers, and independent same-name bindings.

The idle-read fixture must be self-contained. It maintains a subscription count, supplies an initial item, then waits on a deferred read. Abort or close resolves that read as done, removes its abort listener, and decrements the count once. Run cancellation through caller abort, iterator return, peer disconnect, and binding unbind. Prove that the read was pending at the destination before triggering cancellation.

Include a producer that throws on abort so tests do not accidentally promise successful completion for every cancellation. Include a non-cooperative producer to prove that connection closure rejects caller requests without claiming it terminates the producer.

### 14.3 Vite development and build cases

Exercise a real Vite server and production build:

- Identical discovery configuration in main and renderer builds with different Vite roots.
- Registry generation without source evaluation.
- Source aliases resolving to the same implementation module.
- IPC source outside `include` rejected.
- A served `?raw` request rejected without exposing implementation code.
- Export edits, file creation, and deletion reflected in the generated registry.
- Overlapping refreshes that do not restore stale entries.
- Full reload after source changes and a fresh connection afterward.
- Build output and development responses free of caller-side destination imports.
- Framework compilation after IPC replacement.
- Side-effect registration retained in a minified build.

### 14.4 Electron integration cases

Build isolated main, preload, and renderer entry points. Run once from a custom application protocol and once against the Vite dev server. Use temporary user data and clean up windows, servers, ports, and temporary files.

The fixture must exercise:

- Context isolation, disabled Node integration, and a bundled sandboxed preload.
- Calls in both directions and explicit targeting of two windows.
- A renderer-owned DOM operation and a main-owned Node operation.
- Map serialization, errors, and generators over actual Electron ports.
- Local main state shared with remotely invoked main handlers.
- Preload absence and the 10-second startup failure.
- Unattached senders, subframes, and an invalid number of transferred ports.
- Reload and navigation with an idle stream open.
- Window closure and renderer failure while requests or streams are pending.
- Dependency unbind and rebind while another window remains connected.
- Main installation disposal followed by an explicit new installation.

Wrong-process fixtures deliberately throw if their implementation executes in the caller realm. A framework fixture may use React and its compiler, but the basic example and runtime must not depend on React.

### 14.5 Installed-package and release cases

Build a tarball, install it in a fresh temporary consumer outside the source checkout, and run that consumer's type checks, Vite builds, and Electron fixture. A workspace symlink alone does not establish package correctness.

Verify all public exports, private runtime resolution, retained registration, unique runtime state, bundled CommonJS main and preload outputs, and absence of source-checkout paths. Repeat the application launch after packaging its assets into an ASAR archive.

Provide rerunnable scripts for `build`, `typecheck`, unit and Vite tests, Electron tests, and installed-package tests. The build and test commands require no external application repository or service.

The package audit scans package metadata, source, declarations, generated code, examples, fixtures, docs, channels, and packed files for application-specific identifiers and filesystem paths. It also checks actual third-party notices and the presence of every export target.

## 15. Release checks and known limits

### 15.1 Evidence at specification time

The inspected compiler, peer, binding, and Vite test suites pass 62 tests across four files. Their coverage includes bidirectional compilation, export forms, maps, errors, source identity, source-map composition, watch edits and deletion, pull iteration, idle-read cancellation, and binding ownership.

The source also contains an Electron fixture for development and production behavior. That fixture was inspected for this specification but was not rerun as part of writing it. Installed-package behavior, ASAR packaging, and coordinated edits across simultaneously running main and renderer builds are not established by that evidence.

Several requirements above extend verification beyond those existing tests. In particular, file-addition watching, all resource-limit edges, invalid setup senders, installed exports, and platform coverage require dedicated cases in the standalone repository.

### 15.2 Release gates

| Gate                   | Required result                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Package independence   | Fresh tarball consumer builds and runs without any other application source.                                         |
| Neutral identity       | Packed files contain only library and generic example terminology, apart from applicable attribution.                |
| Runtime identity       | Generated registration and public runtime entries share one resolver and handler table in each realm.                |
| Transport conformance  | Unit, Vite, and real Electron tests pass without replacing the transport with mocks.                                 |
| Packaged application   | Main, preload, and lazy handler chunks run from an ASAR-packaged fixture.                                            |
| Development lifecycle  | Main rebuild/restart and renderer reload converge after export changes, additions, and deletion.                     |
| Declared compatibility | Peer ranges, engine ranges, and operating-system claims match successful test jobs.                                  |
| Documentation          | Startup, shutdown, serialization limits, cancellation, and application trust responsibilities match tested behavior. |

### 15.3 Limits that must stay explicit

The following are boundaries of the preserved behavior, not features silently added by extraction:

- Port acquisition has no main-side acknowledgement. Main-to-renderer application readiness remains caller-owned.
- The adapters expect a single startup attempt per realm. Core duplicate configuration is rejected, but simultaneous renderer installations and duplicate preload listeners need a dedicated lifecycle audit before claiming leak-free rejection.
- Cancellation cannot interrupt a handler module import or an arbitrary awaited Promise. During a slow open, cancellation is remembered until a stream ID exists. Disconnect can abort the opening controller immediately.
- An iterator yielding in `finally` may remain active after one return request. Neither `for await` break nor automatic cancellation promises to drain arbitrary cleanup yields.
- A cleanup `return()` can reject or wait indefinitely. Ordinary operation cleanup can therefore affect the delivered error or its timing. Forced cleanup and error-precedence redesign are outside this scope.
- Outgoing and retained-stream limits do not bound all inbound work or payload bytes from a hand-written peer.
- Invalid protocol messages are ignored. There is no negotiation, protocol-error event, or automatic disconnection policy for them.
- Port `messageerror` events and failures while posting an error response need explicit release tests. A transport that stops delivering without closing can leave requests pending because there are no call deadlines.
- Closing a connection can leave an ordinary side effect completed without its caller receiving a result. Retrying is an application decision.
- Attached main frames are trusted as application documents. Per-function permissions, origin policies, and sender-context injection require a separate design.
- A generated registry may expose exports that no caller currently imports. Restrict callable code through dedicated modules and include patterns.
- Async functions returning iterables remain ordinary calls. Stream behavior depends on the declared async generator form.
- There is no source transform for directive modules imported as published dependency files under `node_modules`.

Unexpected behavior discovered while implementing these checks must be recorded as a compatibility decision. Preserve documented semantics unless an explicit API or protocol revision is selected. Do not turn an untested edge case into a public guarantee by copying its current implementation.

## 16. Implementation completion criteria

The implementation is complete when a fresh consumer can install the package, configure both Vite builds, and run the examples using only this document and the published files.

Completion requires all of the following:

1. The public entry points, directive grammar, compilation rules, and IDs match this specification.
2. Caller builds contain generated references without destination implementation imports or source content.
3. Local destination imports and IPC calls share module state.
4. Calls and generators operate in both directions with explicit window selection.
5. Cancellation, queued iteration, errors, and connection disposal satisfy the conformance cases.
6. The dependency binding helper remains independent of application construction and disposal.
7. Runtime state is unique within each realm and the renderer runtime imports no Node or compiler code.
8. The installed tarball and packaged Electron fixture pass the release gates.
9. No test, example, build script, or documentation depends on an external host application.
10. Published documentation states the limits in section 15 without promising unsupported delivery, cancellation, or security properties.
