# Durable Eagle queue — feature branch

This branch is based on local `20dec0a`, including ntfy notifications and restricted-post skipping. It is not deployed to ordinary Chrome. Windows fixtures were tested; Ubuntu is a portable design, not a verified deployment.

## Acceptance, delivery, and completion

Acquisition does not require Eagle. The extension stores 256 KiB Blob chunks in extension-origin IndexedDB. Every append is acknowledged after transaction completion; acceptance follows a full SHA-256 and byte-count check and an atomic job/counter transaction. Accepted work is never evicted to make room. Queue capacity is 1 GiB, including staging and retained submitted files. Browser storage quota can be lower; quota/capacity failure pauses acquisition and retains committed bytes. Partial staging is unaccepted and is retained. Replay of a resumed stream must hash to the assembled staging bytes; changed content is rejected.

Cross-tab claims are serialized by the extension worker and persisted in `storage.session`. A live tab owning the same canonical post prevents another tab from restoring its shared Resume data or starting collection. Ownership is held while that tab remains on the post; closing/navigating it permits recovery. There is no time-based lease that steals a slow owner's job. Browser restart clears session claims; durable job identities still prevent reacquisition from creating duplicate queue jobs. Browser-download mode is protected from concurrent Resume too, but its filesystem downloads are not a durable exactly-once queue.

Accepted jobs have a monotonically committed FIFO sequence. `ready → sending` is committed before the item request. HTTP success moves the job only to `pending-verification`, with source bytes retained. Those jobs do not block later submissions. Worker loss or an ambiguous response produces `unknown`; a fresh exact marker lookup may identify one candidate and permit later work, but a missing candidate is not permission to retry. Multiple candidates or an unavailable lookup pause delivery. No exactly-once guarantee is claimed.

The existing localhost V1 adapter preserves folder/name/source URL and adds an annotation marker containing job identity and original hash. Fresh list/detail lookup is used, never the legacy name/folder cache. V1 JSON/data-URL delivery currently has a separate 128 MiB whole-body memory budget; larger files remain accepted and retained, awaiting a streaming transport. Acquisition supports larger MOVs up to available queue capacity; a synthetic 33 MiB MOV was tested. Actual MOV playback/import and remote V2 transport were not tested. Worst-case V1 base64/JSON string allocation can consume several times the file size.

## Exact verification and retention

HTTP 200, `status: success`, item ID, metadata size, a thumbnail, or a delay never authorize cleanup. The [V1 add API](https://api.eagle.cool/item/add-from-url) documents a status result. The [Eagle Plugin API](https://developer.eagle.cool/plugin-api/api/item) documents `getById` and read-only `filePath`; [Node APIs](https://developer.eagle.cool/plugin-api/tutorial/node-js-native-api) provide the basis for reading and hashing that original file.

`tools/verify-eagle-original.cjs` is an uninstalled, read-only adapter: it checks the exact job marker/source/item identity, reads the Eagle-owned original, and verifies full byte count and SHA-256, with fresh identity/file checks after reading. `DurableQueue.verify` accepts such a trusted proof and can atomically mark registered and remove only extension chunks when explicitly enabled. No proof message is exposed to FANBOX tabs. No plugin, network listener, credentials, or private EagleDB edits were installed. Automatic cleanup remains off until an approved verifier integration supplies trustworthy proof. Pending verification remains visible in the extension's Options queue page.

## Dedicated browser workflow

Use official Chrome for Testing with the same dedicated profile and this branch's stable manifest public key:

```text
node tools/collector.mjs --browser=<CfT executable> --profile=<dedicated directory> --mode=login
# User logs in, then closes the dedicated browser.
node tools/collector.mjs --browser=<CfT executable> --profile=<same directory> --mode=headless
```

Login mode disables extensions, so login cannot trigger collection or Eagle imports. `headed` mode runs the extension for interactive collection; close the browser before switching. The launcher keeps the sandbox enabled, opens no debugging port, and refuses an already running launcher profile. The new manifest public key deliberately gives this feature branch a stable new identity; do not overwrite an existing production extension/profile or assume its old IndexedDB transfers automatically. No signing private key is retained. Ubuntu uses an executable path for that OS; never transfer authentication by copying cookies or exporting tokens.

The queue schema contains jobs, original Blob chunks, counters and hashes, without credentials. A credential-free queue export/import UI and a remote transport are integration work still needed for moving accepted work between machines. Copying an entire Chrome profile between OSes is not a supported queue migration strategy. Transactions request strict durability, but clearing browser data or browser storage eviction is outside the queue's control; no unlimited-storage permission is silently granted.

## Validation

`npm run typecheck`, `npm test`, and `npm run ts` verify the source/build and atomic acceptance, persisted restart, concurrent-tab ownership, capacity failure, changed-source resume, FIFO, retained successful requests, lost responses, proof rejection/cleanup, and 33 MiB chunked bytes. Verifier fixtures cover missing/incomplete/delayed files, equal-size wrong bytes and unrelated filenames. Windows headless fixtures with five same-post tabs produced exactly one PNG plus one HTML in browser mode, and exactly two accepted jobs in queue mode while Eagle was blocked. Actual dedicated-profile restart preserved both jobs and hashes. No real Eagle writes, ordinary-profile changes, or paid-content uploads occurred.

Run the reproducible browser checks with `PFD_CFT=<official executable>` and `npm run test:headless`. They create disposable profiles under ignored `.test-build`, retain synthetic evidence, and block scheduler/Eagle/ntfy traffic. On this Windows desktop, extension scripts did not run from the user-temp fixture directory, so the default uses the tested workspace location. The detached worker disappeared after 38 seconds and woke from the Options page with both jobs intact. `npm run build` also completed; unrelated existing formatter changes were excluded from this branch.
