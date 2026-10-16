# Nandico add-on service — receiving pushes from HealerHelper PACS

This is the contract for the service that receives event pushes from the PACS
server. Everything the receiver needs is in the request body: it never calls
back into PACS.

## What you need to implement

1. Expose one HTTPS `POST` endpoint at `https://addon.nandico.in/outbox`.
   We send you the username (`nandico`), password and HMAC secret out of
   band; configure your receiver with exactly those.
2. On each request, read the raw body, then verify Basic auth and/or the
   signature (Authentication below). Fail → respond `401`.
3. De-duplicate on envelope `id`; a repeat `id` → respond `200` and do nothing.
4. Respond `2xx` within 30 s; do slow work (sending WhatsApp/SMS, downloading
   the PDF) asynchronously after responding.
5. Act on `type` and notify each `recipients[].mobile` with `shareLink`
   (and `otpCode` when present); for `SIGNOFF`, fetch the PDF from
   `reportPdfLink` if you send the file.
6. Respond `400` for a body you can never accept, `5xx` for a temporary failure
   you want retried.

The sections below are the reference for each step; "Full example request" at
the end is one complete request to test your endpoint against.

## When pushes start

Pushes are off until we enable them per PACS group: an admin ticks the events to
send (`SIGNOFF`, `VIEW_IMAGES_PATIENT`, `VIEW_IMAGES_DOCTOR`) under "Events pushed
to the Nandico add-on service" in that group's settings. You only receive the
ticked types, and only for those groups. The pushes are sent by a PACS server
running with the outbox enabled on our side; that is already switched on.

## Transport

- One HTTPS `POST` per event to `https://addon.nandico.in/outbox` (configured
  on our side as `outbox.addon.url`). Plain HTTP is only used against a local stub.
- `Content-Type: application/json`.
- Our client waits 5 s to connect and 30 s for your response. Respond before
  that, or the push is treated as failed and retried.
- Each attempt is also aborted after 60 s in total, however the bytes arrive.
  Redirects are not followed.
- Pushes run in parallel (up to 8 at a time) and in no guaranteed order.

## Hosting on addon.nandico.in

The add-on box is `addon.nandico.in` (IP `168.144.187.125`). nginx on it already
terminates TLS for that domain (Let's Encrypt, renewed automatically). Run your
service on any local port — Java, Python, anything — and forward `/outbox` to it
by adding this inside the `server` block for `addon.nandico.in` in
`/etc/nginx/sites-available/default`:

```nginx
location /outbox {
    proxy_pass http://127.0.0.1:<your-port>;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 30s;
}
```

Then run `sudo nginx -t && sudo service nginx reload`. Keep it a plain
`proxy_pass`, never a `return 301` or `rewrite ... redirect`: we do not follow
redirects. nginx passes the body and the `Authorization`, `X-Timestamp` and
`X-Signature` headers through unchanged, so Basic auth and the signature check
work exactly as without the proxy.

## Envelope

```json
{
  "id": 1234,
  "type": "SIGNOFF",
  "groupId": 42,
  "reportStatusId": 987654,
  "createdAt": "2026-10-07 18:02:11",
  "payload": { "...": "see per-type payload below" }
}
```

| field | meaning |
|---|---|
| `id` | our queue row id; unique per push. The same `id` is re-sent on every retry, so use it to de-duplicate. |
| `type` | `SIGNOFF`, `VIEW_IMAGES_PATIENT` or `VIEW_IMAGES_DOCTOR` |
| `groupId` | the PACS group (client account) the event belongs to |
| `reportStatusId` | the study the event is about; same value as `payload.reportStatusId` |
| `createdAt` | when the event was queued |
| `payload` | the event body, below |

Dates everywhere are strings `yyyy-MM-dd HH:mm:ss` in Indian Standard Time
(Asia/Kolkata, UTC+05:30). Fields whose value is null are omitted from the
JSON, so treat every field below as optional unless marked required. Non-ASCII
characters (for example in `patientName`) arrive as standard JSON `\uXXXX`
escapes; any JSON parser decodes them.

## Payload (all three types share one shape)

| field | type | notes |
|---|---|---|
| `reportStatusId` | number | required |
| `customerReportId` | number | required |
| `patientName` | string | |
| `centerName` | string | the centre the patient visited |
| `modality` | string | e.g. `CT`, `MR`, `CR` |
| `studyCreatedAt` | date string | when the study was registered |
| `shareId` | string | the opaque share token |
| `shareLink` | string | full URL the patient/doctor opens to view images (and the report once ready) |
| `otpCode` | string | the OTP the viewer must enter on `shareLink`; absent when the group does not use OTPs |
| `hasReport` | boolean | required; `true` when a signed-off report is available |
| `reportPdfLink` | string | full URL that downloads the report PDF; present only when `hasReport` is true |
| `reportFileName` | string | suggested file name for the PDF, `<patient>-<yyyyMMdd>-0.pdf` |
| `recipients` | array of `{ "mobile": "9876543210", "kind": "PATIENT" }` | who to notify; always a 10-digit Indian mobile (`^[6-9][0-9]{9}$`). `kind` is `PATIENT`, `REFERRING_DOCTOR` or `SHARED` (a number the patient shared the study with). De-duplicated by mobile. |

Per type:

- `SIGNOFF` — fired on the first sign-off of a report, only when a report
  exists; a re-sign-off after rework does not push again. `hasReport` is always
  true; `recipients` lists the patient, every referring doctor and every shared
  number known at that moment.
- `VIEW_IMAGES_PATIENT` — fired when the study is registered or a user sends
  the viewing link to the patient. `recipients` has exactly one entry of kind
  `PATIENT`.
- `VIEW_IMAGES_DOCTOR` — fired when the study is shared with a consulting
  doctor. `recipients` has exactly one entry of kind `REFERRING_DOCTOR`.

A push is only sent for a study that has a patient record. Auto-registration
with auto-WhatsApp disabled creates none, so those studies do not push until a
patient is added.

Likewise, when the group disables automatic WhatsApp to referring doctors (or
excludes the study's modality for them), no doctor mapping is stored: no
`VIEW_IMAGES_DOCTOR` push fires and `SIGNOFF` lists no doctor.

For the two view-images types `hasReport` may be false (images only); the same
`shareLink` later shows the report once it is signed off, and a separate
`SIGNOFF` push follows.

We never send PDF bytes. Download from `reportPdfLink` when you need the file.

## Authentication — two schemes on every request

Both headers are always present. Verify at least one; verifying both is
better. Credentials are exchanged out of band.

**1. HTTP Basic**

```
Authorization: Basic base64(username ":" password)
```

**2. HMAC-SHA256 signature over the exact body**

```
X-Timestamp: 1759840931              # Unix epoch seconds, as sent by us
X-Signature: sha256=<lowercase hex of HMAC_SHA256(secret, X-Timestamp + "." + rawBody)>
```

To verify:

1. Read the raw request body bytes exactly as received — do not re-serialise
   or pretty-print the JSON first.
2. Compute `HMAC_SHA256(secret, X-Timestamp + "." + rawBody)` with the shared
   secret as UTF-8 bytes; hex-encode in lowercase.
3. Compare to the value after `sha256=` using a constant-time comparison.
4. Reject if `|now - X-Timestamp| > 300 s` (5-minute replay window).

Known test vector for your HMAC implementation:
`HMAC_SHA256("key", "The quick brown fox jumps over the lazy dog")` =
`f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8`.

## Reference receiver (Node.js)

A starting point, not a finished service: one file, Node 18+, built-in modules
only (no npm install). It listens on `127.0.0.1:3999`, so in the nginx block
above use `proxy_pass http://127.0.0.1:3999;`. Node is suggested because it
idles in roughly 40 MB and its event loop handles our parallel pushes without
threads; any language that follows the rules above works.

```js
// receiver.js — Node 18+, no dependencies. Listens behind nginx on 127.0.0.1.
const http = require('http');
const crypto = require('crypto');

const PORT = 3999;
const USER = 'nandico';
const PASS = '<password we send you>';
const SECRET = '<HMAC secret we send you>';
const seen = new Set(); // replace with a table keyed on envelope id

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function authorised(req, raw) {
  const basic = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  if (!safeEqual(req.headers.authorization || '', basic)) return false;
  const ts = req.headers['x-timestamp'] || '';
  if (!(Math.abs(Date.now() / 1000 - Number(ts)) <= 300)) return false; // NaN-safe
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET)
    .update(ts + '.').update(raw).digest('hex');
  return safeEqual(req.headers['x-signature'] || '', sig);
}

http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/outbox') return res.writeHead(404).end();
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks); // raw bytes: never re-serialise before checking
    if (!authorised(req, raw)) return res.writeHead(401).end();
    let env;
    try { env = JSON.parse(raw.toString('utf8')); } catch { return res.writeHead(400).end(); }
    if (seen.has(env.id)) return res.writeHead(200).end();
    seen.add(env.id);
    res.writeHead(200).end();         // respond first...
    setImmediate(() => handle(env));  // ...then do the slow work
  });
}).listen(PORT, '127.0.0.1');

function handle(env) {
  // switch on env.type; notify each env.payload.recipients[].mobile with shareLink
}
```

An in-memory `seen` set forgets ids on restart, and marking an id before
`handle` finishes drops that event if `handle` then fails. A production
receiver stores ids durably and records its own send state.

## What to respond

| your status | what we do |
|---|---|
| any `2xx` | delivered; never re-sent |
| `4xx` other than `408` and `429` | the push is marked failed and never re-sent (the same body cannot succeed later). Use this for a malformed or unauthenticated request. |
| `408`, `429`, any `3xx` or `5xx`, a timeout, or a connection failure | retried |

Respond quickly and process asynchronously if your work is slow. The response
body is never read; only the status code matters.

## Retry schedule you should expect

- After a retryable failure the push is re-sent after 1 min, then 2, 4, 8, 16,
  32 min, then every hour.
- Retries stop 24 h after the event was first queued; the push is then marked
  failed on our side.
- A push still undelivered 24 h after queueing is marked failed without another
  request, even after an outage on our side.
- Because retries re-send the same `id` and body, an endpoint that is
  idempotent on `id` is safe against duplicates (for example, if you returned
  `2xx` but our client timed out reading it).
- Our worker polls once a minute, so expect pushes within about a minute of
  the event, not instantly.

## Full example request

A `SIGNOFF` push with fake data, credentials `nandico` / `example-password` and
HMAC secret `example-secret`. The body is sent compact, on one line, exactly as
below; the signature is over these bytes, so your verifier should accept this
request as-is (ignore the replay window when testing with this fixed
timestamp).

```http
POST /your/endpoint HTTP/1.1
Content-Type: application/json
Authorization: Basic bmFuZGljbzpleGFtcGxlLXBhc3N3b3Jk
X-Timestamp: 1791377115
X-Signature: sha256=ee5bfdfc6b284d0f0ceabd92cde0d0367d75038a82a260a1d8a8f93059d4e934

{"id":4104,"type":"SIGNOFF","groupId":42,"reportStatusId":987654,"createdAt":"2026-10-07 18:35:15","payload":{"reportStatusId":987654,"customerReportId":556677,"patientName":"RAVI KUMAR 45Y/M","centerName":"CITY DIAGNOSTIC CENTRE","modality":"CT","studyCreatedAt":"2026-10-01 15:47:51","shareId":"Ab12Cd34Ef","shareLink":"https://pacs.example.com/share/?link=Ab12Cd34Ef","hasReport":true,"reportPdfLink":"https://pacs.example.com/rd/all/Gh56Ij78Kl90","reportFileName":"RAVI KUMAR 45Y/M-20261001-0.pdf","recipients":[{"mobile":"9876500001","kind":"PATIENT"},{"mobile":"9876500002","kind":"REFERRING_DOCTOR"},{"mobile":"9876500003","kind":"SHARED"}]}}
```

The same body, pretty-printed for reading:

```json
{
  "id": 4104,
  "type": "SIGNOFF",
  "groupId": 42,
  "reportStatusId": 987654,
  "createdAt": "2026-10-07 18:35:15",
  "payload": {
    "reportStatusId": 987654,
    "customerReportId": 556677,
    "patientName": "RAVI KUMAR 45Y/M",
    "centerName": "CITY DIAGNOSTIC CENTRE",
    "modality": "CT",
    "studyCreatedAt": "2026-10-01 15:47:51",
    "shareId": "Ab12Cd34Ef",
    "shareLink": "https://pacs.example.com/share/?link=Ab12Cd34Ef",
    "hasReport": true,
    "reportPdfLink": "https://pacs.example.com/rd/all/Gh56Ij78Kl90",
    "reportFileName": "RAVI KUMAR 45Y/M-20261001-0.pdf",
    "recipients": [
      {
        "mobile": "9876500001",
        "kind": "PATIENT"
      },
      {
        "mobile": "9876500002",
        "kind": "REFERRING_DOCTOR"
      },
      {
        "mobile": "9876500003",
        "kind": "SHARED"
      }
    ]
  }
}
```

Reproduce the signature with:

```bash
printf '%s' '1791377115.<body above, exactly>' | openssl dgst -sha256 -hmac example-secret
```
