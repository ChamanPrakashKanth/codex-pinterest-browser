# Manifest and recovery

Pass one JSON object or an array of up to 20 objects. Use paths relative to the explicitly supplied root. An absolute path inside that root is also accepted.

| Field | Value |
| --- | --- |
| `imagePath` | JPEG, PNG, or static WebP path |
| `title` | Required, up to 100 characters |
| `description` | Required, up to 500 characters |
| `altText` | Required, up to 500 characters |
| `board` | Required, exact existing board name, up to 100 characters |
| `destinationUrl` | Optional absolute HTTP(S) URL, up to 2,048 characters |
| `publishingMode` | `dry-run` by default, or `prepare` |

The CLI `--mode` overrides every entry in the manifest. `dry-run` performs validation and duplicate checks without scheduling a browser action. `prepare` records validated images for the extension. Mode selection never grants publishing approval. For machine-readable stdout without npm's banner, use `node scripts/pin.js` with the same arguments.

## Boards and metadata generation

To get candidate board names, keep the paired review tab open and run:

```sh
npm run pin -- boards --refresh
npm run pin -- boards
```

The scan reads the rendered board picker in a temporary tab and caches only board names in bridge memory. It can miss boards outside virtualized rows. Use a known exact board name directly when you have one.

The skill can generate copy from inspected images. For a reproducible local alternative, save one observation object or an array to a file and run `node scripts/pin.js generate --observations observations.json`. The command writes a submit-compatible JSON manifest to stdout. Provide only details verified in the image. Supply the subject as a noun phrase, the optional setting as a phrase such as “beside a brick wall,” and optional detail as a phrase such as “a rear rack and upright handlebars.”

```json
{
  "imagePath": "city-bike.jpg",
  "subject": "green city bicycle",
  "setting": "beside a red brick wall",
  "detail": "a rear rack and upright handlebars",
  "board": "City cycling"
}
```

## Status and recovery

| State | Meaning |
| --- | --- |
| `dry-run` | Validation passed. No new ledger pin was created. |
| `queued`, `preparing` | The extension has yet to finish preparing the composer. |
| `ready` | The composer showed a loaded preview, matching metadata and board, and an enabled Publish control. |
| `failed`, `interrupted` | Draft preparation failed or its session was lost. |
| `publishing` | Approval was recorded and the publish result is pending. Closing tabs or stopping the bridge can make the outcome uncertain. |
| `blocked` | The extension detected a problem before it clicked Publish. |
| `published` | A fresh success notice included a Pinterest pin URL. |
| `uncertain` | A publish request was approved, but the extension could not verify its result. |
| `reconciled` | A person supplied the canonical pin URL after checking Pinterest. |
| `discarded` | The local job and its duplicate reservation were released. |
| `error` | A manifest entry did not pass submission. Check its code and message. |

A duplicate response includes `duplicate: true` and the existing pin ID with its current state. Image bytes that differ produce different fingerprints.

```sh
npm run pin -- status --id PIN_ID
npm run pin -- retry --id PIN_ID
npm run pin -- discard --id PIN_ID
npm run pin -- reconcile --id PIN_ID --url https://www.pinterest.com/pin/123456789/
```

Use `retry` for a recoverable draft after addressing the error and inspecting any abandoned composer tabs. If a browser restart or closed composer made a ready pin unavailable, pair the extension and retry the local pin ID. Use `discard` to release an unpublished local job and remove any corresponding Pinterest draft manually. Neither command replays an uncertain publication. If Pinterest shows a pin after an uncertain outcome, use `reconcile` only after a person confirms its identity. If the pin cannot be located, the duplicate reservation remains in place.
