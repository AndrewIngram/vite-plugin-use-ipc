# vite-plugin-use-ipc

Call async functions between Electron's main process and its renderer windows. Both directions are supported:

| Where the function runs | First line of its file | How the other process calls it |
| --- | --- | --- |
| Main | `'use ipc:main'` | Import the function and call it normally |
| A renderer window | `'use ipc:renderer'` | Import the function and call `callRenderer(window, fn, ...args)` |

For example, call a main function from your renderer:

```ts
// src/ipc/calculator.ts
'use ipc:main';

export async function add(left: number, right: number) {
	return left + right;
}
```

```ts
// In your renderer, after setting up the connection:
import { add } from './ipc/calculator';

const answer = await add(20, 22); // 42
```

The function runs in the main process. The plugin replaces the renderer's copy with a function that sends the request and waits for the answer. TypeScript still checks your arguments and return value.

For the other direction, mark the file with `'use ipc:renderer'`. Its functions run in the window you pass to `callRenderer`. The [renderer-call example](#call-a-function-in-a-renderer) below shows the full code.

Both directions also support async generators for sending several results over time. See [the iterator guide](#return-several-results-over-time) after setup.

## How the pieces fit together

An Electron app has three parts involved in this setup:

- **Main** creates windows and runs Node.js code, such as reading files.
- **Renderer** runs the page shown in a window. This is where your UI lives.
- **Preload** is a script Electron runs before the page starts. It connects that page to main.

These parts cannot call each other's functions directly. Electron calls communication between processes **IPC**, short for *inter-process communication*. This plugin handles the messages for you.

A line such as `'use ipc:main'` tells the plugin where a file's exported functions run. Put it at the top of the file, before imports.

## Try the example

From a checkout of this repository, run:

```sh
pnpm install
pnpm build
pnpm --dir examples/basic install
pnpm --dir examples/basic dev
```

The example opens an Electron window and calls an addition function in main. The page displays the answer and a count of calls.

The [complete example](examples/basic) includes the build configuration, HTML file, and all three Electron entry files. It uses Node 24.19.0, Vite 8.3.0, Electron 44.3.0, and electron-vite 6.0.0-beta.1.

## Add it to your app

The following setup uses **electron-vite**, which builds main, preload, and renderer code together. It assumes you already have an Electron app.

Install the beta release:

```sh
pnpm add -D vite-plugin-use-ipc@0.1.0-beta.1
```

The package requires:

- Node 20.19 or later in the Node 20 series, or Node 22.12 or later.
- Vite 8.0 or later in the Vite 8 series.
- Electron 35 or later, which provides the browser APIs used for iterator cleanup.

The example uses newer versions. The minimum versions and the example's versions are tested on macOS arm64. Windows and Linux still need their own Electron test runs.

### 1. Configure both builds

Add the plugin to the main and renderer builds in `electron.vite.config.mts`:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import useIpc from 'vite-plugin-use-ipc';

const root = fileURLToPath(new URL('.', import.meta.url));
const include = ['src/ipc/**/*.ts'];

export default defineConfig({
	main: {
		plugins: [useIpc({ target: 'main', root, include })],
		build: { externalizeDeps: false },
	},
	preload: {
		build: { externalizeDeps: false },
	},
	renderer: {
		plugins: [useIpc({ target: 'renderer', root, include })],
	},
});
```

Keep your app's existing entry files and output settings. The [example configuration](examples/basic/electron.vite.config.mts) shows those settings for a complete app.

Both plugin calls must use the same `root` and `include`:

- `root` is the shared project folder.
- `include` selects the files containing your IPC functions. Here, they live under `src/ipc`.
- `target` tells the plugin which part of the app it is building.

`externalizeDeps: false` includes the package's runtime code in the main and preload builds. Electron itself stays separate. For a sandboxed preload, configure CommonJS output, usually a `.cjs` file, as shown in the example.

Add `vite-plugin-use-ipc/env` to the `types` list in each relevant TypeScript configuration. Keep any entries already there:

```json
{
	"compilerOptions": {
		"types": ["node", "vite-plugin-use-ipc/env"]
	}
}
```

This lets TypeScript recognize the generated module used in the next steps.

### 2. Set up main

In your main entry file, install IPC once. Attach each window **before** loading its page:

```ts
import 'virtual:use-ipc/register';
import { app, BrowserWindow } from 'electron';
import { installMainIpc } from 'vite-plugin-use-ipc/main';

const ipc = installMainIpc();

app.whenReady().then(async () => {
	const window = new BrowserWindow({
		webPreferences: {
			preload: '/absolute/path/to/your/built/preload.cjs',
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	ipc.attach(window);
	await window.loadURL('http://localhost:5173');
});

app.on('before-quit', () => ipc.dispose());
```

Replace the preload path and page URL with your app's values. For a packaged app, load your built HTML file. The [example main file](examples/basic/src/main.ts) handles both development and packaged paths.

`virtual:use-ipc/register` is generated by the plugin. You do not create this file. Importing it tells the runtime which functions this process can receive calls for. Function files are loaded when needed.

For multiple windows, reuse the same `ipc` object and call `ipc.attach(window)` for each one.

### 3. Set up preload

In your preload entry file:

```ts
import { installIpcPreload } from 'vite-plugin-use-ipc/preload';

installIpcPreload();
```

### 4. Set up the renderer and make a call

Create `src/ipc/calculator.ts` using the addition function at the top of this README. Then, in your renderer entry file:

```ts
import 'virtual:use-ipc/register';
import { installRendererIpc } from 'vite-plugin-use-ipc/renderer';
import { add } from './ipc/calculator';

async function start() {
	await installRendererIpc();

	const answer = await add(20, 22);
	document.body.textContent = `The answer is ${answer}`;
}

void start().catch(console.error);
```

Wait for installation before calling an IPC function. Importing the function earlier is fine.

## Call a function in a renderer

Use `'use ipc:renderer'` for functions that need the page, such as updating its title:

```ts
// src/ipc/window-actions.ts
'use ipc:renderer';

export async function setTitle(title: string) {
	document.title = title;
	return document.title;
}
```

From main, use `callRenderer` and choose the window:

```ts
import { callRenderer } from 'vite-plugin-use-ipc/main';
import { setTitle } from './ipc/window-actions';

// Run after this window's renderer has finished setting up IPC.
await callRenderer(window, setTitle, 'Document editor');
```

Main cannot choose a window from `setTitle('Document editor')` alone. Pass the original imported function to `callRenderer`, rather than wrapping it in another function or calling `.bind()` on it.

Your app must arrange when main starts these calls. Loading a page does not guarantee that its renderer has finished setting up IPC.

## Return several results over time

Use an **async generator** when a call produces more than one result. It uses `yield` to send each result:

```ts
// src/ipc/counting.ts
'use ipc:main';

export async function* countTo(limit: number, signal: AbortSignal) {
	for (let number = 1; number <= limit; number++) {
		if (signal.aborted) return;
		yield number;
	}
}
```

Read the results with `for await`:

```ts
import { countTo } from './ipc/counting';

const controller = new AbortController();

for await (const number of countTo(10, controller.signal)) {
	console.log(number);
	if (number === 3) break;
}
```

### Start and read an iterator

Calling a generator returns an **iterator** immediately. An iterator is the object you ask for each result. Do not `await` the call that creates it:

```ts
const iterator = countTo(3, new AbortController().signal);

await iterator.next(); // { done: false, value: 1 }
await iterator.next(); // { done: false, value: 2 }
await iterator.next(); // { done: false, value: 3 }
await iterator.next(); // { done: true, value: undefined }
```

The IPC connection must already be available when you create the iterator. The generator itself starts only on the first `next()`. Nothing is fetched ahead of your requests.

Each result has two fields:

- `value` is the yielded item or the generator's final return value.
- `done` tells you whether the generator has finished.

`for await` calls `next()` for you. It visits yielded items but does not expose the final return value. Read the iterator manually if you need that value.

### Send a value back with next(value)

A generator can receive a value when it resumes after `yield`:

```ts
// src/ipc/adjustment.ts
'use ipc:main';

export async function* adjust(): AsyncGenerator<number, string, number> {
	let total = 0;

	while (true) {
		const amount = yield total;
		if (amount === 0) return 'finished';
		total += amount;
	}
}
```

The three types in `AsyncGenerator<number, string, number>` describe yielded values, the final return value, and inputs sent through `next()`.

```ts
import { adjust } from './ipc/adjustment';

const iterator = adjust();

await iterator.next();  // { done: false, value: 0 }
await iterator.next(5); // { done: false, value: 5 }
await iterator.next(2); // { done: false, value: 7 }
await iterator.next(0); // { done: true, value: 'finished' }
```

The first `next()` starts the generator. A value passed to that first call is ignored, just as with a local async generator.

### Stop early with return(value)

Call `return()` when you no longer need results. You can supply the final value, using the generator's declared return type:

```ts
const iterator = adjust();

await iterator.next();
await iterator.return('stopped'); // { done: true, value: 'stopped' }
```

For a generator whose return type is `void`, use `return(undefined)`. A Promise passed to `return` is awaited before its value is sent. Other iterator inputs are not automatically awaited.

Calling `return()` also requests cancellation immediately, even if an earlier `next()` is still waiting. The generator still needs to cooperate with cancellation, as explained below.

Breaking out of `for await` calls `return()` for you.

### Send an error with throw(value)

`iterator.throw(error)` raises an error where the generator is paused. If the generator catches it, it can yield another value and continue:

```ts
// src/ipc/recovery.ts
'use ipc:main';

export async function* recover() {
	try {
		yield 'ready';
	} catch {
		yield 'recovered';
	}
}
```

```ts
import { recover } from './ipc/recovery';

const iterator = recover();

await iterator.next(); // { done: false, value: 'ready' }
await iterator.throw(new Error('try again'));
// { done: false, value: 'recovered' }
await iterator.next(); // { done: true, value: undefined }
```

If the generator does not catch the error, the operation rejects and that iterator finishes. Errors thrown by the generator use the same error handling as ordinary IPC calls. Values passed into `throw()` are copied like other iterator inputs.

### Cancel work that is waiting

Pass one `AbortSignal` directly as a generator argument, then call `controller.abort()` when you want it to stop:

```ts
const controller = new AbortController();
const iterator = countTo(10, controller.signal);

await iterator.next();
controller.abort();
```

The other process receives its own signal, which the runtime aborts when cancellation is requested. Put checks such as `if (signal.aborted) return` in your generator. If it waits for an operation that accepts a signal, pass the signal to that operation too.

A generator can receive at most one signal. Do not put it inside an object or array. Custom abort reasons are not forwarded.

Cancellation cannot interrupt a module that is still loading or a Promise that ignores the signal. A cancelled operation may finish normally or throw an error. Cleanup can also fail or keep waiting. Ordinary async function calls do not currently support cancellation or timeouts.

### Clean up with finally

Use `try/finally` inside the generator to release resources. The runtime requests cleanup when the consumer stops or the connection closes, but it cannot force unfinished work to stop.

A generator is allowed to yield from `finally`. In that case, `return()` can produce another item instead of finishing immediately:

```ts
// src/ipc/cleanup.ts
'use ipc:main';

export async function* cleanupExample(): AsyncGenerator<number, number | undefined, unknown> {
	try {
		yield 1;
	} finally {
		yield 2;
	}
}
```

```ts
import { cleanupExample } from './ipc/cleanup';

const iterator = cleanupExample();

await iterator.next();    // { done: false, value: 1 }
await iterator.return(7); // { done: false, value: 2 }
await iterator.next();    // { done: true, value: 7 }
```

Avoid yielding from `finally` unless your caller knows to keep reading. Breaking a `for await` loop requests cleanup once; it does not keep consuming cleanup values.

The iterator also supports `Symbol.asyncDispose`. With TypeScript's `await using` syntax, leaving the block awaits `return(undefined)`:

```ts
{
	await using iterator = countTo(10, new AbortController().signal);
	console.log(await iterator.next());
}
```

This has the same cleanup limitations as calling `return()` yourself. `[Symbol.asyncIterator]()` returns the same iterator, so it works directly with `for await`.

### Ordering, finished iterators, and disconnects

Calls to `next`, `return`, and `throw` on one iterator run in the order you make them. Other iterators and ordinary calls can run independently. Each iterator allows 256 queued or running operations; another operation rejects if that limit is reached. Cancellation from `return()` is still requested even if its operation cannot be queued.

These less common cases follow predictable rules:

| Situation | Result |
| --- | --- |
| `return(value)` before the first `next()` | Finishes without starting the remote generator; awaits the supplied value |
| `throw(value)` before the first `next()` | Rejects with that value without starting the remote generator |
| The signal is already aborted on the first `next()` | Finishes without starting the remote generator |
| `next()` after finishing | Resolves to `{ done: true, value: undefined }` |
| `return(value)` after finishing | Resolves to `{ done: true, value }`, after awaiting the value |
| `throw(value)` after finishing | Rejects with that value |

If opening the stream, reading a result, or copying a yielded value fails, the caller finishes that iterator and attempts remote cleanup. Waiting for cleanup may delay the rejection.

A connection closing rejects pending requests. An active iterator becomes finished; it does not reconnect or resume in a new page. An iterator created but never started can instead encounter the closed connection on its first `next()`.

### Use the same methods with renderer generators

All these iterator methods work with `'use ipc:renderer'` too. From main, create the iterator with `callRenderer`:

```ts
// src/ipc/page.ts
'use ipc:renderer';

export async function* pageTitles() {
	yield document.title;
}
```

```ts
// Main, after the selected renderer has set up IPC:
import { callRenderer } from 'vite-plugin-use-ipc/main';
import { pageTitles } from './ipc/page';

const iterator = callRenderer(window, pageTitles);

for await (const title of iterator) {
	console.log(title);
}
```

Creating this iterator is synchronous, just like calling a generator marked with `'use ipc:main'`.

## What can an IPC file export?

Export async functions or async generators. Named exports, default exports, and async arrow functions are supported. Type-only exports are fine too.

Keep other values private or put them in another file. Exporting constants, classes, synchronous functions, or functions imported from another module is not supported.

Helpers and imports inside an IPC file run in the process named by its directive. For example, a main function can import Node's file APIs without those imports being included in the renderer's copy.

Put the directive at the top of the file. Directives inside functions are not supported. Import IPC files normally, without Vite query suffixes such as `?raw`.

## What data can you send?

You can send values such as strings, numbers, plain objects, arrays, Maps, and ArrayBuffers. Electron makes a copy of the data. Changing the received object does not change the sender's object.

You cannot send functions, page elements, or Electron objects such as `BrowserWindow`. Pass the data another process needs, such as a document ID, instead. If a value cannot be copied, the call rejects.

TypeScript helps check function arguments, but it cannot guarantee that Electron can copy every value you pass.

## Handle errors with try/catch

Errors thrown in the other process reject the call:

```ts
try {
	const answer = await add(20, 22);
	console.log(answer);
} catch (error) {
	console.error('The call failed:', error);
}
```

Standard error types, messages, stack traces, causes, and properties such as `code` are preserved when they can be copied. An `AggregateError` keeps its contained errors. A custom error class keeps its name and data, but `instanceof YourCustomError` does not work across the connection.

Non-Error throws keep their value too: `throw 42` makes the other side catch `42`.

Properties defined with getters and properties that cannot be copied are omitted. Circular or very deep error chains use a fallback error. Error details are not automatically hidden, so avoid attaching secrets.

## Close connections and manage services

Reloading or navigating a window closes its old connection. Closing a window or a renderer crash does the same. Pending calls reject, and streams must be started again in the new page. The main installation keeps the window attached for the new connection.

Call `ipc.dispose()` when shutting down main IPC. `installRendererIpc()` also returns a cleanup function if you need to stop renderer IPC yourself. The renderer cleans up automatically when its page is left. Calling a cleanup function more than once is safe.

Install each part once. If you need to install main IPC again, dispose the old installation first.

If your handlers need a service that starts or stops separately, the optional `createIpcBinding` helper stores the current service and provides an abort signal when it is removed. You do not need it for basic IPC calls. See [service lifetime details](docs/detailed-behavior.md#dependency-lifetime).

## Important limits

- Use attached windows only for application content you trust. Any script in an attached page can request the exported main functions. The plugin does not enforce per-function permissions or allowed page origins.
- Incoming IPC messages are checked before use. Your app decides whether its own arguments need further validation.
- Renderer setup fails after ten seconds if preload does not provide a connection. That timeout does not apply to function calls, and setup does not confirm that main has accepted the connection.
- Calls are not retried automatically. A connection that stops responding without closing can leave a call waiting indefinitely.
- Each connection allows 256 pending outgoing requests and 256 open incoming streams. Each iterator allows 256 queued or running operations. Exceeding a limit rejects the new operation. These limits do not cap message size or all work running in main.
- Build main and renderer from the same source and package version. IPC file changes reload the renderer, but main changes also need a rebuild and process restart through your development setup.

See [detailed behavior](docs/detailed-behavior.md) for less common export forms, generator cleanup, build rules, and other limits.

## Work on this package

From the repository root:

```sh
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

For checks that launch Electron:

```sh
pnpm test:electron
pnpm test:package
pnpm test:minimum
```

`test:electron` tests real Electron connections. `test:package` installs a package archive into a temporary app and tests development and packaged builds. `test:minimum` tests the declared minimum dependencies on Node 20.19 and 22.12, then runs the Electron checks on Electron 35. These commands download the required Node or Electron binaries if needed.

See the [implementation notes](docs/implementation-notes.md) for design decisions and [the specification](use-ipc-spec.md) for the full behavior contract.
