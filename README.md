# HIOBuy RFQ API — developer demo

A sample buyer portal ("Northwind Supply", synthetic) with **its own backend**, showing how an integrator uses the
[HIOBuy RFQ API](https://hiobuy.com/en/api-docs/rfq) (`https://api.hiobuy.com/v1/ask/rfqs*`): submit an RFQ, answer the
sourcing team's questions, edit the requirement, follow the linked conversation, and accept / decline / request a
revision of a quotation. Signed webhooks keep the UI current.

**Official documentation:** <https://hiobuy.com/en/api-docs/rfq> — this repository is example code; the documentation is
the contract. More examples: <https://developers.hiobuy.com/examples>.

```text
Browser ──/api/*──▶ Demo backend (server/handler.mjs) ──Bearer key──▶ HIOBuy Gateway ──▶ HIOAsk
HIOAsk ──▶ Gateway ──signed webhook (/hooks/hiobuy)──▶ Demo backend ──▶ UI re-reads the RFQ
```

There is no mock mode: a missing key or an upstream error is shown as an error. Requests reach a real sourcing team,
so the demo deliberately has **no bulk entry, spreadsheet import or batches** and allows 3 new RFQs per hour per client
and 30 per day for the App. Batch submission is documented below for your own integration.

## Requirements

- Node.js 24+.
- A HIOBuy App with Supplier Inquiry and RFQ enabled, and the RFQ permissions `rfq:read` and `rfq:write` granted by a
  HIOBuy administrator (see [Access and authentication](https://hiobuy.com/en/api-docs/rfq)). The App also needs
  `supplier_inquiry:read` / `supplier_inquiry:write`, because the RFQ's conversation uses the message API.
- A **production** API key of that App (sandbox keys are rejected for RFQ). Check access with `GET /v1/ask/identity`.
- For live updates: a webhook endpoint registered in the HIOBuy Developer Center pointing to `<public origin>/hooks/hiobuy`,
  subscribed to `ask.rfq.updated`, `ask.rfq.quotation.sent`, `ask.rfq.quotation.withdrawn`, `ask.rfq.closed` and
  `ask.message.created`. Locally this needs a tunnel; without it the UI still refreshes on focus and after each action.

## Run locally

```bash
npm ci
cp .dev.vars.example .dev.vars && chmod 600 .dev.vars   # fill in HIOBUY_API_KEY (and HIOBUY_WEBHOOK_SECRET)
npm run build && npm start                               # http://127.0.0.1:18891 (UI + backend)
# or, for UI development: npm run dev:backend  +  npm run dev  (Vite on :18890 proxies /api and /hooks)
```

`npm test` runs the backend contract tests against an in-memory fake Gateway (`test/fake-gateway.mjs`) and the
requirement helpers. `node test/preview-server.mjs` starts the backend on that fake Gateway for **local UI preview only**,
with a control port (18892) that plays the sourcing team; it is not part of the demo's runtime.

## What the backend does (what your backend must do)

- Holds `HIOBUY_API_KEY` and the webhook secret as server secrets; they never reach the browser, URLs, logs or the database.
- Gives each visitor an anonymous session (HttpOnly cookie + CSRF token) and an opaque `external_user_id`. In your app this
  is your signed-in user, mapped to an opaque id — never names, emails or phone numbers.
- **Authorizes every RFQ, conversation message and image against that user.** The Gateway only isolates Apps;
  ownership inside your App is your responsibility (`server/store.mjs` → `owned`).
- Sends your reference as `external_ref`. The demo prefixes it (`demo-<visitor>-<your ref>`) so demo requests are
  recognizable to the sourcing team and unique per visitor.
- Forwards `version` / `X-RFQ-Version` for optimistic concurrency and an `Idempotency-Key` on every write; a
  `VERSION_CONFLICT` reloads the page state.
- Proxies images (`/v1/ask/rfqs/{id}/attachments/{id}/content`, `/v1/ask/attachments/{id}/content`) with a
  PNG/JPEG/WebP allowlist; storage URLs are never exposed.
- Verifies `HioBuy-Signature` on the raw body, deduplicates by event id (delivery is at-least-once), acknowledges fast,
  and lets the UI re-read the RFQ — events are notices, not the source of truth.
- Keeps its own requirement change log: the public API returns the current requirement version only.
- Rate-limits per client IP and per App (`DEMO_RATE_LIMITED`).

## Mapping to the API

| Screen | Calls |
| --- | --- |
| RFQ list | `GET /v1/ask/rfqs?external_user_id=…` |
| New RFQ | `POST /v1/ask/rfqs`, then `POST /v1/ask/rfqs/{id}/attachments` per image (needs the current version) |
| RFQ detail | `GET /v1/ask/rfqs/{id}`, `GET …/quotations`, `PATCH …/requirement`, `POST …/answers`, `POST …/cancel`, `POST …/quotations/{v}/decision` |
| Conversation | `GET/POST /v1/ask/conversations/{conversation_id}/messages` |
| Integration | `GET /v1/ask/identity`, the backend's call log and received webhooks |

Not available in the public API, so not in the demo: document parsing, closing an accepted RFQ, read markers.
Accepting a quotation is **not** an order or a payment.

## Submitting several RFQs at once (not in the demo UI)

`POST /v1/ask/rfq-batches` creates 1–100 RFQs in one all-or-nothing transaction. Retry with the same
`Idempotency-Key`. Each item takes the same fields as a single RFQ; `external_ref` must be unique within the batch.

```http
POST /v1/ask/rfq-batches
Authorization: Bearer <HIOBuy API key>
Idempotency-Key: 6f1c2b0e-batch-po-2026-118
Content-Type: application/json

{
  "external_batch_ref": "PO-2026-118",
  "items": [
    { "external_ref": "NW-2001", "external_user_id": "u_7f3a9c",
      "requirement": { "title": "Cotton canvas tote bag", "quantity": 2000, "unit": "pcs", "destination": "Netherlands",
                       "specs": "12 oz natural canvas, one-colour print" } },
    { "external_ref": "NW-2002", "external_user_id": "u_7f3a9c",
      "requirement": { "title": "Bamboo cutting board", "quantity": 800, "unit": "pcs", "destination": "Netherlands",
                       "specs": "35 x 25 cm, juice groove" } }
  ]
}
```

The response (`201`) returns the batch with `items[].id`. Read progress with `GET /v1/ask/rfq-batches/{id}`; there is
no endpoint that lists batches, so store the batch ids in your own system. Each RFQ is then handled, quoted and
decided on its own, exactly like a single RFQ.

## Layout

- `server/handler.mjs` Fetch-API handler (shared by Node and Workers) · `gateway.mjs` Gateway client ·
  `webhook.mjs` signature verification · `store.mjs` SQLite state · `node-host.mjs` local host · `worker.mjs` Worker
  + Durable Object entry (example only; `wrangler.jsonc` is an example configuration)
- `src/api/client.ts` browser client for `/api/*` · `src/requirement.ts` requirement drafts ·
  `src/pages/*` screens · `src/demo.config.ts` synthetic copy and examples
- `test/` contract tests, fake Gateway, local preview harness

## Demo mode

`DEMO_MODE` is on by default: the UI shows a DEMO badge and the backend accepts image uploads only (PDF uploads return
`403 DEMO_PDF_DISABLED`). Set `DEMO_MODE=false` only for a private integration test; PDFs (up to 20 MiB) are then
forwarded, and are always served as downloads because they are stored as uploaded and not scanned.

## Data and privacy

All sample content is synthetic. Do not enter personal or confidential data in a hosted demo: requests reach a real
sourcing team. Never commit `.dev.vars` or anything under `.local/`.

## Support

Integration help: support@hiobuy.com. Bugs in this example: open an issue in this repository.

## License

[MIT](LICENSE)
