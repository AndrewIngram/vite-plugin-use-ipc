# Useful capabilities beyond the first release

Assessed 13 September 2026 against the current implementation and primary documentation/source. These are proposals, not implemented features. Priorities below express product value, not bug severity. Alternative libraries were inspected, not installed or benchmarked.

I would first add ordinary-call deadlines and cancellation, then trusted caller context. Structured errors and connection diagnostics would make both easier to use. The current directive/import model is worth preserving; adopting an entire router framework would change the main reason to choose this package.

## What already exists

Typed calls in both directions, explicit window targeting, lazy handlers, structured-clone values, pull-based async generators, cooperative stream cancellation, disposal, and dependency lifetimes already exist. Subscriptions are therefore not missing at the transport level. Their missing pieces are adapters and application conventions. See [README](../README.md) and [remote iterator](../src/runtime/remote-iterator.ts).

Most candidates below are deliberately excluded by [spec section 1](../use-ipc-spec.md) or recorded in [section 15.3](../use-ipc-spec.md). They require an explicit next-version design. They are not failures to implement the existing spec.

Windows/Linux runs and a broader supported-version matrix are release-quality work, not new capabilities. Keep those checks separate from feature prioritization. The [README validation boundary](../README.md) currently limits compatibility claims to tested versions and the local platform.

## Highest value

### 1. Ordinary-call deadlines and cooperative cancellation

A user starts a search, changes the query, and wants the old search to stop. A save operation waits forever because its destination remains connected but stops replying. Our ordinary calls support neither an AbortSignal nor a deadline. An application can race a Promise against a timer, but that leaves the peer's pending request allocated and does not tell the destination to stop. The pending map clears on reply, post failure, or disposal. See [Peer.request and call](../src/runtime/peer.ts).

There is a useful precedent in birpc: a configurable response timeout, with a 60-second default, removes timed-out pending entries. This is a deadline mechanism, not evidence of remote work cancellation. [birpc source](https://github.com/antfu-collective/birpc/blob/main/src/main.ts).

Proposed scope: optional per-call deadlines and signals, removal of expired pending requests, ignored late responses, and a destination signal for cooperative work. Keep call options separate from business arguments. Specify whether a deadline covers loading and queueing. Stream-open timeouts also need late-open cleanup so abandoning the response cannot orphan the resulting stream. Never infer that a timed-out save did not happen, or automatically retry it. This needs protocol and lifecycle changes, but solves a common problem without changing how services are organized.

### 2. Trusted caller context and optional policy hooks

In a multi-window editor, a main handler may need the document associated with the calling window. Today it receives only caller-supplied arguments; every attached main frame can call every discovered main export. Passing a window ID as an argument does not establish which window sent the request. The main adapter knows the sender when it accepts the port, then constructs a peer without exposing that identity to handlers. See [main adapter](../src/runtime/main.ts) and [spec trust boundary](../use-ipc-spec.md).

electron-better-ipc passes the originating BrowserWindow to main callbacks and supports handlers restricted to one window. tRPC supplies reusable middleware and input/output validation; these are useful design precedents rather than a reason to copy its router API. [electron-better-ipc API](https://github.com/sindresorhus/electron-better-ipc#ipcmainanswerrendererchannel-callback), [tRPC middleware](https://trpc.io/docs/server/middlewares), [tRPC validators](https://trpc.io/docs/server/validators).

Proposed scope: immutable context derived from the accepted connection, a per-attachment permission policy, and an optional invocation hook for authorization and validation. Keep origin restrictions and function permissions distinct. Capture document lifetime so navigation cannot give old requests a new identity. Define local destination calls explicitly: they share service implementations today but have no remote sender.

Runtime validation is already possible inside an exported async function. The additional capability is reusable boundary policy and schema integration. Start with validator-agnostic hooks; a mandatory schema library would add little for small trusted applications. Avoid requiring wrapper-produced exports, which the compiler currently rejects.

## Valuable follow-ups

### 3. Structured application errors

An editor needs to distinguish a file conflict from permission denial and display field errors without parsing English messages. Update: the local worker-derived error codec now preserves cloneable custom data properties such as `code`, causes, aggregate contents, standard error types, and non-Error throws. The serialization gap is closed; stable application codes, schemas, and explicit redaction remain possible additions. See [error codec](../src/runtime/errors.ts).

tRPC supports a formatted error shape inferred by clients, including application data such as validation details. [tRPC error formatting](https://trpc.io/docs/server/error-formatting).

Proposed scope: a documented cloneable error envelope with a stable code and optional application data, plus explicit formatting/redaction. Arbitrary error prototypes and recursive object graphs would add unnecessary complexity. Returning a discriminated result union already works today and is a good convention for expected business failures. Typed Promise rejection is not something TypeScript automatically provides merely because the wire envelope has a type.

### 4. Acknowledged connection state and diagnostics

Renderer installation currently proves receipt of a preload port, not acceptance by main or readiness of destination services. There is no public connection-state subscription, request timing hook, or pending-work snapshot. This makes a startup race or stalled call harder to explain. See [startup documentation](../README.md) and [main installation API](../src/runtime/main.ts).

Proposed scope: a main acceptance acknowledgement, connection/disconnection notifications, and optional diagnostics containing function identity, direction, duration, outcome, and pending counts. Keep payload logging opt-in. A build identity check could explain mismatched registries during development without promising communication between arbitrary versions. Application readiness should remain an explicit signal separate from transport acceptance.

These are recommendations inferred from our startup and debugging limits. birpc provides a smaller precedent through request, timeout, function-error, and general-error hooks, plus closed-state inspection. [birpc source](https://github.com/antfu-collective/birpc/blob/main/src/main.ts). A diagnostics hook should observe failures without changing whether the request settles.

### 5. Subscription recipes and adapters

A file watcher or job-progress source needs listener registration, buffered delivery, overflow behavior, and listener cleanup. Our generators already carry the resulting stream; applications repeatedly implement the conversion around them. electron-trpc supports subscriptions and works with tRPC clients, while typed-ipc offers typed send/listen events. [electron-trpc README](https://github.com/jsonnull/electron-trpc), [typed-ipc example](https://github.com/alex8088/electron-toolkit/blob/master/packages/typed-ipc/README.md).

Start with examples for EventEmitter/EventTarget sources, bounded queues, abortable reads, and cleanup on navigation. Add a small adapter only after those examples reveal a stable common interface. Pulling one remote result at a time does not bound a push producer's local event buffer. React/Vue hooks, replay, and caching can remain optional integrations. This offers useful ergonomics with much less scope than a second subscription protocol.

## Conditional opportunities

| Capability | Useful scenario | Assessment |
| --- | --- | --- |
| Buffer ownership transfer | Large images, audio, or numerical arrays | Comlink has explicit transfer lists and custom transfer handlers. However, Electron's main-side `MessagePortMain.postMessage` documents its transfer list as `MessagePortMain[]`, not the browser's arbitrary transferables. Prototype the actual Electron route before proposing an ArrayBuffer API or a zero-copy claim. [Comlink](https://github.com/GoogleChromeLabs/comlink#comlinktransfervalue-transferables-and-comlinkproxyvalue), [Electron MessagePortMain](https://www.electronjs.org/docs/latest/api/message-port-main#portpostmessagemessage-transfer). |
| Utility processes or workers | Indexing or other CPU-heavy work that should not occupy main | Comlink supports workers and Node worker_threads; Electron utility processes offer Node-enabled child processes with message-port communication. A new target needs discovery, bootstrapping, identity, supervision, and shutdown rules. Keep it a separate project until a concrete application requires it. [Comlink](https://github.com/GoogleChromeLabs/comlink#node), [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process). |
| Per-peer incoming concurrency and configurable limits | Several windows launch expensive work together | Our fixed outgoing/retained-stream limits do not bound every incoming call or loading stream. Add admission control only with a defined rejection/queueing policy and fairness model. This is an extension to the documented resource model, not evidence of a new leak. [Spec limits](../use-ipc-spec.md). |
| Notifications and broadcast | Refresh menus or settings across windows | electron-better-ipc broadcasts to renderers; typed-ipc has typed events. Explicit loops over known windows and current calls often suffice. A new notification API would need clear error and disconnect semantics. Avoid automatic focused-window targeting because the current explicit target is safer for document operations. [electron-better-ipc](https://github.com/sindresorhus/electron-better-ipc#ipcmainsendtorendererschannel-data), [typed-ipc](https://github.com/alex8088/electron-toolkit/blob/master/packages/typed-ipc/README.md). |

Remote object proxies and callbacks, network transport, automatic reconnect/retry, and state replay have real uses but would expand the ownership and delivery model substantially. Comlink's proxy model and birpc's transport adapters demonstrate different product choices. They do not make them a good fit for this package's first extension. [Comlink](https://github.com/GoogleChromeLabs/comlink#comlinktransfervalue-transferables-and-comlinkproxyvalue), [birpc](https://github.com/antfu-collective/birpc#features).

## Suggested next scope

Design one small release around ordinary-call lifetime control and stable error codes. Keep the existing call syntax as the default. Then design caller context and policies with a real multi-window example before choosing an API. Connection diagnostics can accompany these changes; subscription recipes can ship independently without a protocol change. Defer transfer APIs and additional process targets until there is a workload to measure and test.
