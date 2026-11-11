# Dependencies and the audit

GitHub reported 89 Dependabot alerts on the default branch (7 critical, 37 high). This page records what `npm audit` found, what was upgraded, what was not and why, and what would replace the one dependency that cannot be fixed by upgrading it.

Counts below are from `npm audit` on 2026-11-11 and count advisories, not packages. They will not match Dependabot's number exactly, because Dependabot counts one alert per advisory per manifest path and keeps alerts for the default branch until it changes.

| | Advisories before | Advisories after |
|---|---|---|
| Our own dependency tree (everything outside `ganache`) | 43 (1 critical, 12 high) | **0** |
| Inside `ganache`'s shrinkwrapped tree | 65 (6 critical, 29 high) | 65 (6 critical, 29 high) |

`npm audit --omit=dev` and `npm audit` now report the same 33 packages, all of them `ganache` or something below it.

---

## (a) Production: upgraded

| Package | Was | Now | What it fixed |
|---|---|---|---|
| `express` | 4.22.2 | 4.22.3 | Pulls in `proxy-addr` 2.0.8 (critical: IP spoofing through an IPv4-mapped IPv6 trust subnet. `server/index.js` trusts one proxy by hop count rather than by subnet, so the advisory's exact path probably never applied here. `req.ip` is still what the rate limit and the sign-in throttle key on, which is reason enough not to argue the point.), `body-parser` 1.20.9 (high: DoS through trailing bytes after a compressed body) and `qs` 6.16 (moderate DoS). Same major, no API change. |
| `nodemailer` | 6.10.1 | 10.5.0 | 22 advisories: header and SMTP command injection, recipient-domain confusion, quadratic address parsing. Four majors, but `server/platform/mailer.js` uses only `createTransport(SMTP_URL)` and `sendMail({ from, to, subject, text })`, which did not change. The test suite does not set `SMTP_URL`, so this path was checked separately: nodemailer 10.5.0 against a minimal local SMTP listener, with an authenticated URL, delivered the message with the right `RCPT TO` and `Subject`. |
| `follow-redirects` (via `solc`) | 1.16.0 | 1.16.3 | Credential headers kept across cross-origin redirects. Inside `solc` it is used only by `loadRemoteVersion`, which Limen never calls; updated anyway, since it is in range. |
| `tmp` (via `solc`) | 0.0.33 | 0.2.7 | Path traversal through prefix/postfix. `solc` 0.8.24 pins `tmp` to exactly 0.0.33, so it is raised with a scoped `overrides` entry in `package.json` (`"solc": { "tmp": "^0.2.6" }`). `solc` only uses `tmp.fileSync()` in its SMT-checker callback, which has the same signature in 0.2.x and is not on any path Limen runs. |

`cors`, `ethers`, `pg` and `pdfkit` had no advisories and were not touched.

### Why `solc` itself stays at 0.8.24

`solc` had one finding, and it was only `tmp`, now fixed by the override above. The compiler version stays pinned on purpose. From 0.8.25, `solc` targets the Cancun EVM by default (later releases target newer forks still), which emits opcodes such as `MCOPY` that ganache 7.9 cannot execute; 0.8.24 defaults to Shanghai, which ganache runs. Raising it means either setting `evmVersion: 'shanghai'` in `server/compile.js`, or replacing ganache first (below). Changing the compiler also changes the deployed bytecode, so it should be its own change with the contract tests as the gate, not part of a dependency sweep.

## (b) The in-process chain: `ganache`, kept, with one fix

`ganache` is a production dependency, not a dev one. With `RPC_URL` unset, which is the Render blueprint's default, the server runs its chain on it. All 65 remaining advisories are inside it.

**It cannot be upgraded.** Consensys sunset Truffle and Ganache in 2023; 7.9.2 is the last release and nothing newer will come. `npm audit`'s suggested "fix" is to downgrade to ganache 6.4.5, a 2019 release that is worse on every count. It also cannot be patched from outside: ganache ships an `npm-shrinkwrap.json` (`hasShrinkwrap: true` in the lockfile), so npm installs its tree exactly as published, and a root `overrides` entry does not reach inside it. `.github/workflows/ci.yml` records the same finding for `fsevents`.

**What actually runs.** The audit lists everything in ganache's shrinkwrap, and most of it is the build tooling of ganache's own monorepo, recorded as `extraneous`. The list below was measured, not assumed: the server's `Chain` was booted on the local chain, the contracts were deployed, and `require.cache` was read.

| Group | Packages flagged | Loaded at runtime? |
|---|---|---|
| ganache's own build and test tooling, among them (`webpack`, `mocha`, `@microsoft/api-extractor`, `terser-webpack-plugin`, `browserslist`, `json5`, `js-yaml`, `minimatch`, `braces`, `micromatch`, `picomatch`, `semver`, `nanoid`, `serialize-javascript`, `validator`, `ajv`, `cross-spawn`, `diff`, and the browserify crypto shims `cipher-base`, `sha.js`, `pbkdf2`, `browserify-sign`) | 27 packages, including 4 of the 5 critical ones | **No.** Installed on disk, never required. |
| `elliptic`, `bn.js` | the JS fallback inside `secp256k1` | **No.** `secp256k1` loads its native prebuild (`linux-x64`, `darwin-x64` and `win32-x64` ship in the package), so the JS fallback is not used. |
| `lodash` | | **No.** |
| `secp256k1` 4.0.3 | ECDH private-key extraction (GHSA-584q-6j8j-r5pm) | **Yes**, but ganache uses it to sign and recover, not for ECDH, and every key on this chain is derived from ganache's published deterministic mnemonic anyway. There is no secret on this chain to extract. |
| `@trufflesuite/uws-js-unofficial`, and its `ws` 8.13.0 | DoS through many headers, memory exhaustion from tiny fragments, uninitialised memory disclosure | **Yes.** uWS ships native binaries only for the Node 18 and 20 ABIs, so on Node 22 (Render's `NODE_VERSION`) and on Windows it falls back to `ws`. These are attacks by a client of ganache's JSON-RPC server. See below for why no outside client can reach it any more. |

One caveat: ganache's runtime is a webpack bundle (`dist/node/*.js`), and whatever it bundled is invisible to `npm audit` in either direction.

**The fix that made "acceptable" true.** `server/chain.js` started the chain with `server.listen(port)`. Called that way, ganache 7 accepts connections on **every** interface, while `server.address()` still reports `127.0.0.1`. Its JSON-RPC has no authentication and all 64 accounts on it are unlocked, including the deployer and the buyer. Measured on this machine against the unchanged branch: a JSON-RPC call to the machine's LAN address listed all 64 unlocked accounts, so anyone on the network could have sent transactions as the buyer and rewritten spending policy. On Render only `$PORT` is routed, so the public demo was not exposed. A systemd or Windows-service deployment without a host firewall (both paths in `docs/DEPLOYMENT.md`) was exposed.

The call is now `server.listen(port, '127.0.0.1')`. Re-measured: loopback answers, both LAN addresses refuse the connection, and the full suite passes. The only client is the Limen process itself, through ethers on `127.0.0.1`, which takes the `ws` advisories above out of reach too.

**Why it is acceptable now:**

1. It is reachable from loopback only.
2. It holds no real value. Its keys come from a published mnemonic, and its state is rebuilt on every boot.
3. The vulnerable code that does load is either a fallback that is not taken, or a server that no outside client can reach.
4. Any deployment that handles real money or needs more than one instance already sets `RPC_URL` and `DEPLOYER_KEY`, and then ganache is never required (`server/chain.js` only `require`s it in the local-chain branch).

### What replaces it

The direction is to stop shipping ganache in the production image at all.

1. **Now, for real deployments:** run against an external EVM with `RPC_URL`, `DEPLOYER_KEY` and `AGENT_KEY`, as `docs/DEPLOYMENT.md` describes for multi-instance. Ganache is then installed but never loaded.
2. **Next, for the local chain: tried on 2026-11-11, and deferred.** The plan was to swap ganache for a maintained local EVM. `server/chain.js` needs only JSON-RPC with deterministic unlocked accounts, chain id 31337, a 30M block gas limit and instamine. Each candidate was installed and checked. None can replace ganache yet without breaking `npm start` somewhere the team runs it, so ganache stays.

   - **Hardhat's EDR** (`@nomicfoundation/edr`, the Rust EVM behind Hardhat 3) is still the closest fit. It installs from npm, with a prebuilt native binary per platform pulled in as an optional dependency, so no separate download step is needed. What was found:
     - **It needs Node 22.** Every release from 0.18 declares `engines: node >= 22`. Version 0.25.0 is the one Hardhat 3.21.2 ships, and the one to pin exactly, because EDR's API is Hardhat-internal and changes between minor versions. `engines` in `package.json` and `node-version` in CI would both have to move off 20. Node 20 has been end-of-life since April 2026, and Render already runs 22, so that part is not a cost.
     - **It has no HTTP server.** EDR is a library: `EdrContext.createProvider(...)` returns a provider whose `handleRequest(json)` answers JSON-RPC in-process. The plan was a small `ethers.JsonRpcApiProvider` subclass whose `_send` calls `handleRequest`. With no port open, the loopback-binding question above disappears entirely. The 64 node accounts would be derived from ganache's own deterministic mnemonic (`myth like bonus …`) and passed in as owned accounts. Every address would then stay exactly what it is today, including the two hard-coded in `scripts/samples.js`. This also avoids a subtler problem: `Chain.buyerFor()` derives workspace buyers from `test test … junk` at `m/44'/60'/0'/0/<hash>`. Hardhat's default accounts sit at `/0` to `/63` on that same path, so a workspace whose hash landed there would share a key with a node account.
     - **It does not load on a Windows 11 PC with Smart App Control on.** That is the blocker. Smart App Control decides by reputation, file by file. It refused `edr.win32-x64-msvc.node` with "An Application Control policy has blocked this file". The Rolldown and Lightning CSS bindings Vite 8 uses are just as unsigned, but they load. EDR has no JavaScript fallback, unlike ganache, whose native `secp256k1` falls back to `elliptic`. So the local chain, and with it `npm start` without `RPC_URL`, would fail at boot on any such PC. Smart App Control is on by default on clean Windows 11 installs, and it is on, enforcing, on the machine this was checked on. It can't be switched back on without reinstalling Windows, so turning it off is not the fix.
   - **Tevm** (`tevm`) is rejected. It is pure JS, so Smart App Control is not an issue, but the current release is a prerelease (`1.0.0-next.149`, last published 2026-07-30). Installed on its own, it brought in about 1,200 packages and 844 MB, and `npm audit` reported 34 advisories (19 high). That replaces one audit problem with another.
   - **Anvil** (Foundry) is rejected. It is a separate binary, which breaks the one-`npm install` setup and adds a step to the Render build. It is also an unsigned native executable, so it would very likely be blocked the same way as EDR. Not tried.

   **Revisit when** any one of these is true:
   - EDR ships a Windows binary that Smart App Control loads, because it is signed or has gained reputation. To check, run `node -e "require('@nomicfoundation/edr')"` on a Windows PC with Smart App Control on.
   - Windows is dropped as a development platform for Limen.
   - A pure-JS local EVM reaches a stable release with a clean `npm audit`.

   When it happens, the work is the plan above, plus three follow-ups. The `solc` pin can move, then: EDR runs Cancun and later, so a newer compiler's default EVM target is fine. The `tmp` override goes if the new `solc` no longer pins `tmp` 0.0.33. And CI can switch to `npm ci`, because the `fsevents` lockfile entry exists only because of ganache's shrinkwrap; confirm that by running `npm ci` on Linux before switching. Until then, everything in this section still holds: ganache, loopback-only, accepted for the reasons listed.
3. **Optionally, in between:** move `ganache` to `optionalDependencies`, so that `npm install --omit=optional` on an `RPC_URL` deployment does not install it at all. That needs a clear boot error when `RPC_URL` is unset and ganache is missing. It is not done here because it changes how the default demo installs.

## (c) Dev-only tooling: upgraded

| Package | Was | Now | Notes |
|---|---|---|---|
| `vite` | 5.4.21 | 8.3.8 | Fixes path traversal in optimized deps, `server.fs.deny` bypasses on Windows, and the `launch-editor` command-injection set. All of them sit at or below 6.4.3; 8 is the current major. Vite 8 bundles with Rolldown instead of esbuild and Rollup, so the `esbuild` dev-server advisory is gone with the dependency itself. Requires Node `^20.19.0 \|\| >=22.12.0`, so `engines` in `package.json` now says that. CI's `node-version: '20'` resolves to a later 20.x, and Render runs 22. |
| `@vitejs/plugin-react` | 4.7.0 | 6.3.0 | Required by Vite 8. `web/vite.config.js` was renamed to `vite.config.mjs`, because Vite 8 warns about ESM syntax in a file it would load as CommonJS (the root `package.json` is `"type": "commonjs"`). The contents are unchanged. |
| `source-map-js` (via `postcss`) | 1.2.1 | 1.2.2 | In-range update. |
| `moment` (via `pg-mem`) | 2.30.1 | 2.31.0 | In-range update. `pg-mem` is used only by the tests. |

The Rolldown and Lightning CSS native bindings for `linux-x64` (glibc and musl) are recorded in the lockfile as optional, so CI and Render install the right one even though the lockfile was regenerated on Windows.

## How this was checked

- `npm test`: 574 passed, 0 failed, after a `npm run build:web`. Run before the web app is built, one test fails (`every page carries a CSP; the API is not cached`). Without `web/dist`, `/` serves a fallback page whose CSP has no `frame-ancestors`. That failure predates this change: it also happens on `feat/production-platform-supplier-portal` from a clean checkout. CI runs `npm test` before `npm run build:web`, so it will hit the same failure until one of the two is changed.
- `npm run build:web` succeeds with Vite 8, from a clean `web/dist`, repeatedly. The very first build after installing Vite 8 on Windows crashed once; every build since (eight, three of them from an empty `web/dist`) has succeeded. It is noted here in case it shows up in CI.
- CI's install command, `npm install --no-save`, leaves the new lockfile byte-for-byte unchanged. Do not switch CI to `npm ci`; the reason is in `.github/workflows/ci.yml` and still applies while ganache is installed.

## Keeping it this way

- After a dependency change, run `npm audit --omit=dev`. Anything outside `node_modules/ganache/` is new, and is ours to fix.
- Dependabot will keep reporting the ganache findings until ganache is removed. Dismiss them in GitHub as "risk is tolerable", with a link to this page, rather than letting them bury new alerts.
