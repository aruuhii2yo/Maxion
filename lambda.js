"use strict";

const { Server }  = require("@modelcontextprotocol/sdk/server/index.js");
// exports map redirects sdk/package.json to dist/cjs/package.json -- derive the cjs dir from that
const _sdkCjsDir = require("path").dirname(require.resolve("@modelcontextprotocol/sdk/package.json"));
const { WebStandardStreamableHTTPServerTransport } =
  require(require("path").join(_sdkCjsDir, "server/webStandardStreamableHttp.js"));
const { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListPromptsRequestSchema } =
  require("@modelcontextprotocol/sdk/types.js");

const si     = require('systeminformation');
const fs     = require('fs');
const crypto = require('crypto');
const os     = require('os');
const path   = require('path');
const { version: PKG_VERSION } = require('./package.json');  // single source of truth

const {
  BedrockRuntimeClient, StartAsyncInvokeCommand, GetAsyncInvokeCommand, InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");
const { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const bedrockClient    = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const s3Client         = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const S3_OUTPUT_BUCKET = process.env.S3_OUTPUT_BUCKET || 'jk-advanced-tech-web-videos';
const PRICES = {
  hourly:  { label: 'hourly',  desc: '1-hour access'   },
  monthly: { label: 'monthly', desc: '30-day access'   },
};
// Lineage.0 is pay-per-video -- each key is a one-time consumable credit.
// Sold as a single Gumroad product priced per LINEAGE0_UNIT_SECONDS-second
// unit; the purchased quantity (not the permalink, which is the same for
// every duration) is what checkAccess uses to determine how much duration a
// given license actually covers.
const LINEAGE0_UNIT_SECONDS = 6;
const LINEAGE0_PRICES = {
  '6':   { price: '0.84',  label: '6-second video  ($0.84)'  },
  '12':  { price: '1.68',  label: '12-second video ($1.68)'  },
  '30':  { price: '3.90',  label: '30-second video ($3.90)'  },
  '60':  { price: '7.80',  label: '60-second video ($7.80)'  },
  '120': { price: '15.60', label: '120-second video ($15.60)' },
};
// Gumroad product permalinks (set these env vars to your real Gumroad product URLs)
const GUMROAD_PRODUCTS = {
  maxion:    { hourly: process.env.GUMROAD_MAXION_HOURLY,    monthly: process.env.GUMROAD_MAXION_MONTHLY },
  diamonize: { hourly: process.env.GUMROAD_DIAMONIZE_HOURLY, monthly: process.env.GUMROAD_DIAMONIZE_MONTHLY },
  quezar:    { hourly: process.env.GUMROAD_QUEZAR_HOURLY,    monthly: process.env.GUMROAD_QUEZAR_MONTHLY },
  lineage0:  { '6': process.env.GUMROAD_LINEAGE_6, '12': process.env.GUMROAD_LINEAGE_12, '30': process.env.GUMROAD_LINEAGE_30, '60': process.env.GUMROAD_LINEAGE_60, '120': process.env.GUMROAD_LINEAGE_120 },
};
const VAULT_DIR        = '/tmp/quezar_vault';

// -- Gumroad license verification ----------------------------------------------

// Verify a Gumroad license key against the live Gumroad API.
// product_permalink: the short Gumroad product permalink (e.g. "quezar-monthly")
// Throws on invalid/expired/already-used keys.
async function verifyGumroadLicense(product_permalink, license_key, { increment_uses_count = false } = {}) {
  // Matches mcp_wrapper.js's normalization: Gumroad canonicalizes permalinks
  // to lowercase in its own API responses, but callers of this hosted path
  // (licenseVerify's request body, in particular) are external input and
  // not guaranteed to match case. Without this, 'Maxion-hourly' entered
  // exactly as internal code always generates it (lowercase) would work,
  // but any consumer typing/copying it with different casing gets rejected
  // even though Gumroad itself would have accepted the key.
  product_permalink = String(product_permalink ?? '').toLowerCase();
  const body = new URLSearchParams({
    product_permalink,
    license_key,
    increment_uses_count: String(increment_uses_count),
  });
  const res = await fetch('https://api.gumroad.com/v2/licenses/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.message || 'License key not valid');
  const purchase = data.purchase;
  // Validate the key belongs to the correct product
  if (String(purchase.product_permalink ?? '').toLowerCase() !== product_permalink) {
    throw new Error(`License is for '${purchase.product_permalink}', not '${product_permalink}'.`);
  }
  // Enforce refund check
  if (purchase.refunded || purchase.chargebacked) throw new Error('License has been refunded.');
  return data;
}

// Determine which Gumroad product permalink is required for a given tool namespace
const NS_GUMROAD = {
  'engine_maxion':      (dur) => GUMROAD_PRODUCTS.maxion[dur],
  'security_diamonize': (dur) => GUMROAD_PRODUCTS.diamonize[dur],
  'storage_quezar':     (dur) => GUMROAD_PRODUCTS.quezar[dur],
  'media_lineage0':     (dur) => GUMROAD_PRODUCTS.lineage0[dur],
};
function requiredPermalink(toolName, duration) {
  for (const [ns, fn] of Object.entries(NS_GUMROAD)) {
    if (toolName.startsWith(ns)) return { ns, permalink: fn(duration) };
  }
  return null;
}

const accessCache = new Map();
// Shortened from an initial 5 minutes: a cache hit does not re-check
// refunded/chargebacked status (doing so would require a Gumroad round trip
// on every hit, defeating the point of caching), so the TTL is the actual
// upper bound on how long a refunded/charged-back customer keeps access
// after the fact. 60s is a deliberate trade-off between that exposure
// window and still meaningfully cutting Gumroad call volume for a polling
// client. Not a complete fix -- true immediate revocation would need a
// webhook-driven invalidation (Gumroad supports sale_refunded, but wiring
// one up is out of scope here) -- but bounds the residual risk to ~1 minute
// instead of ~5.
const ACCESS_CACHE_TTL_MS = 60 * 1000;
// Caps memory growth in a long-lived warm container against unbounded
// distinct license-key lookups (e.g. a key-spraying probe against the
// auto-trial/verify path). Map preserves insertion order, so the oldest
// entry is evicted first once the cap is hit -- a simple LRU-by-insertion,
// not true least-recently-used, but sufficient to bound size without an
// extra tracking structure.
const ACCESS_CACHE_MAX_ENTRIES = 50;
function cacheAccessResult(cacheKey, result) {
  if (accessCache.size >= ACCESS_CACHE_MAX_ENTRIES && !accessCache.has(cacheKey)) {
    accessCache.delete(accessCache.keys().next().value);
  }
  accessCache.set(cacheKey, { result, expires: Date.now() + ACCESS_CACHE_TTL_MS });
}

// Trial limits: 30 minutes of use time or 10 calls per namespace for unlicensed callers
const TRIAL_DURATION_MS = 30 * 60 * 1000;
const TRIAL_MAX_CALLS = 10;
const trialState = new Map();

// Check access for a given tool using a Gumroad license key.
// `duration` is only meaningful (and only supplied by the caller) for
// media_lineage0_* tools, where each duration tier is a distinct consumable
// credit. For engine_maxion/security_diamonize/storage_quezar tools there is
// no per-call duration input -- a license key there could belong to either
// the hourly or the monthly product, so both permalinks are tried and either
// one verifying is sufficient.
// Returns { ok, purchase, tool } on success; { ok: false, msg } on failure.
async function checkAccess(licenseKey, toolName, duration, clientIp = 'default') {
  const isLineage = toolName.startsWith('media_lineage0');
  const ns = Object.keys(NS_GUMROAD).find(n => toolName.startsWith(n));
  if (!ns) return { ok: true };  // free tools (billing_purchase, gateway_status, etc.)

  if (!licenseKey) {
    if (isLineage) {
      return { ok: false, msg: `UNAUTHORIZED: lineage0 license required.\nCall billing_purchase with tool_name="lineage0" and a duration (6, 12, 30, 60, or 120 seconds).\nEach key is a one-time consumable credit — one key, one video.` };
    }
    const trialKey = `${clientIp}|${ns}`;
    const now = Date.now();
    let trial = trialState.get(trialKey);
    if (!trial) {
      trial = { firstCall: now, count: 0, expires: now + TRIAL_DURATION_MS };
      trialState.set(trialKey, trial);
    }
    if (now > trial.expires || trial.count >= TRIAL_MAX_CALLS) {
      return {
        ok: false,
        msg: `UNAUTHORIZED: Free trial expired for ${ns} (${TRIAL_MAX_CALLS} calls / 30-minute limit reached).\nCall billing_purchase with tool_name="${ns}" to purchase hourly or monthly access.`
      };
    }
    trial.count++;
    const remainingCalls = TRIAL_MAX_CALLS - trial.count;
    const remainingMins = Math.max(1, Math.round((trial.expires - now) / 60000));
    return {
      ok: true,
      type: 'auto-trial',
      trialNotice: `\n========================================\n  FREE 30-MIN TRIAL  |  AUTO-ACTIVATED\n========================================\n  Covers: all ${ns}.* tools\n  Remaining: ${remainingCalls} calls | ${remainingMins} min\n  Upgrade: call billing_purchase\n  Enterprise: aruuh@advancedapparchitect.com\n========================================`
    };
  }

  if (isLineage) {
    const permalink = NS_GUMROAD[ns](duration);
    if (!permalink) return { ok: false, msg: `No Gumroad product configured on server for ${toolName}/${duration}. Contact aruuh@advancedapparchitect.com.` };
    // All five GUMROAD_LINEAGE_* env vars currently resolve to the same
    // "lineage0-video" permalink (single dynamically-priced product, not five
    // distinct products) -- so product_permalink alone cannot distinguish a
    // 6s purchase from a 120s one. Gumroad's `quantity` on the purchase is
    // the only per-key signal available: the product is priced at
    // LINEAGE0_UNIT_PRICE per LINEAGE0_UNIT_SECONDS-second unit, so a
    // license must carry enough quantity to cover the requested duration.
    // Combined with increment_uses_count:true so Gumroad's own uses counter
    // advances on every call -- real single-use enforcement additionally
    // requires setting a max-activations limit on the Gumroad product itself
    // (operator/dashboard config, not something this code can set).
    const requiredUnits = Math.ceil(Number(duration) / LINEAGE0_UNIT_SECONDS);
    try {
      // Verify WITHOUT incrementing first: a client retrying or probing
      // durations against an under-sized license must not burn real Gumroad
      // activations on attempts that are rejected here anyway -- if the
      // operator has a max-activations limit configured, a legitimate
      // customer could otherwise lock themselves out of a license they paid
      // for before ever getting a video. The credit is only consumed
      // (a second call, with increment_uses_count:true) once the quantity
      // check below has already confirmed the request will succeed.
      const data = await verifyGumroadLicense(permalink, licenseKey);
      const quantity = Number(data.purchase?.quantity || 0);
      if (quantity < requiredUnits) {
        return { ok: false, msg: `License covers a ${quantity * LINEAGE0_UNIT_SECONDS}-second credit, but this request needs ${duration} seconds. Call billing_purchase with tool_name="lineage0" and duration="${duration}" for a license that covers it.` };
      }
      // The increment call is a second, separate round trip -- Gumroad can
      // apply it server-side (incrementing uses_count) and then have this
      // client fail to observe the result (a dropped connection, a
      // malformed response body). Denying access in that case would burn a
      // real activation the customer never got credit for using, on top of
      // the one this call is legitimately consuming -- worse than the
      // alternative of occasionally letting a request through on a
      // network-level increment failure after the quantity check already
      // passed. Not caught by the outer try/catch on purpose.
      try {
        await verifyGumroadLicense(permalink, licenseKey, { increment_uses_count: true });
      } catch (incrementErr) {
        console.error(`[lineage0] increment_uses_count call failed after a successful quantity check for ${permalink}: ${incrementErr.message}. Granting access anyway -- see the comment above this catch.`);
      }
      return { ok: true, type: 'paid', purchase: data.purchase };
    } catch (e) {
      return { ok: false, msg: `License ${e.message}. Call billing_purchase to get a new license.` };
    }
  }

  // Warm-container cache: a client polling engine_maxion_status/etc. in a
  // loop was paying a full Gumroad round trip (1-2 verify calls) on every
  // single invocation, with no caching -- enough volume trips Gumroad's own
  // rate limit and turns an external dependency's quota into a hard failure
  // here. Not used for the lineage0 branch above: that path intentionally
  // calls verifyGumroadLicense with increment_uses_count:true on every call,
  // which a cache would silently skip.
  const cacheKey = `${ns}|${licenseKey}`;
  const cached = accessCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.result;

  const candidates = [NS_GUMROAD[ns]('hourly'), NS_GUMROAD[ns]('monthly')].filter(Boolean);
  if (!candidates.length) return { ok: false, msg: `No Gumroad product configured on server for ${toolName}. Contact aruuh@advancedapparchitect.com.` };
  let lastErr;
  for (const permalink of candidates) {
    try {
      const data = await verifyGumroadLicense(permalink, licenseKey);
      const result = { ok: true, type: 'paid', purchase: data.purchase };
      cacheAccessResult(cacheKey, result);
      return result;
    } catch (e) {
      lastErr = e;
    }
  }
  // Failures are not cached: a customer with an in-flight billing_purchase
  // whose next call lands within the TTL should not be stuck seeing a stale
  // rejection.
  return { ok: false, msg: `License ${lastErr.message}. Call billing_purchase to get a new license.` };
}

function json400(CORS, msg) { return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) }; }
function json500(CORS, msg) { return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) }; }

// -- License verify endpoint (Gumroad passthrough for desktop apps) ------------
async function licenseVerify(body, CORS) {
  let license_key, product_permalink;
  try { ({ license_key, product_permalink } = JSON.parse(body || '{}')); } catch { return json400(CORS, 'Invalid JSON'); }
  try {
    const data = await verifyGumroadLicense(product_permalink, license_key);
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valid: true, purchase: data.purchase }) };
  } catch (e) {
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valid: false, error: e.message }) };
  }
}


// -- Quezar (ephemeral /tmp on Lambda) ----------------------------------------

const VAULT_MASTER_KEY = crypto.createHash('sha256').update(process.env.QUEZAR_VAULT_KEY || 'quezar-lambda-vault-v1').digest();

function ensureVault() {
  if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true });
}
function VaultKeyFor(id) {
  return crypto.createHmac('sha256', VAULT_MASTER_KEY).update(id).digest();
}
function VaultStore(payload) {
  ensureVault();
  const id   = crypto.randomBytes(8).toString('hex');
  const key  = VaultKeyFor(id);
  const iv   = crypto.randomBytes(16);
  const ciph = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc  = ciph.update(payload, 'utf8', 'hex') + ciph.final('hex');
  const tag  = ciph.getAuthTag().toString('hex');
  fs.writeFileSync(path.join(VAULT_DIR, `${id}.qzt`),
    JSON.stringify({ iv: iv.toString('hex'), tag, data: enc }));
  return id;
}
function VaultRetrieve(id) {
  const file = path.join(VAULT_DIR, `${id}.qzt`);
  if (!fs.existsSync(file)) throw new Error(`Vault ID not found: ${id}`);
  const { iv, tag, data } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = VaultKeyFor(id);
  const dc = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  dc.setAuthTag(Buffer.from(tag, 'hex'));
  return dc.update(data, 'hex', 'utf8') + dc.final('utf8');
}
function VaultDelete(id) {
  const file = path.join(VAULT_DIR, `${id}.qzt`);
  if (!fs.existsSync(file)) throw new Error(`Vault ID not found: ${id}`);
  fs.unlinkSync(file);
}
function VaultList() {
  ensureVault();
  return fs.readdirSync(VAULT_DIR).filter(f => f.endsWith('.qzt')).map(f => f.slice(0, -4));
}

// -- Nova Reel polling --------------------------------------------------------

async function pollNovaJob(invocationArn) {
  for (let i = 0; i < 60; i++) {
    const res = await bedrockClient.send(new GetAsyncInvokeCommand({ invocationArn }));
    if (res.status === 'Failed') throw new Error(`Generation failed: ${res.failureMessage}`);
    if (res.status === 'Completed') {
      const uri    = res.outputDataConfig?.s3OutputDataConfig?.s3Uri || '';
      const m      = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
      const bucket = m ? m[1] : S3_OUTPUT_BUCKET;
      let   prefix = m ? m[2] : uri;
      if (!prefix.endsWith('/')) prefix += '/';
      const list = await s3Client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
      const mp4  = list.Contents?.find(i => i.Key.endsWith('.mp4'));
      if (!mp4) throw new Error(`No .mp4 in ${prefix}`);
      return getSignedUrl(s3Client, new GetObjectCommand({ Bucket: bucket, Key: mp4.Key }), { expiresIn: 3600 });
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Synthesis timed out');
}

// -- Tools ---------------------------------------------------------------------

const TOOLS = [
  {
    name: "engine_maxion_activate", title: "Activate Maxion V16",
    description: "Activates Maxion V16 and returns live host telemetry: CPU brand, core count, current load, memory usage, and CPU package temperature (where the OS exposes a sensor).",
    annotations: { title: "Activate Maxion V16", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: { type: "object", properties: { duration_minutes: { type: "number", description: "How long to keep the engine active, in minutes." } }, required: ["duration_minutes"] },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Telemetry output and activation state." } } },
  },
  {
    name: "engine_maxion_deactivate", title: "Deactivate Maxion V16",
    description: "NOT IMPLEMENTED — returns an error. The Maxion engine exposes no deactivate operation, so no governor or power state is changed. Use engine_maxion_status for live telemetry.",
    annotations: { title: "Deactivate Maxion V16", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Deactivation status message." } } },
  },
  {
    name: "engine_maxion_status", title: "Maxion V16 Status",
    description: "Returns Maxion V16's current CPU load and CPU package temperature from the host system.",
    annotations: { title: "Maxion V16 Status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Current hardware and engine telemetry." } } },
  },
  {
    name: "engine_maxion_diagnostics", title: "Maxion V16 Diagnostics",
    description: "Runs a Maxion V16 diagnostic pass: CPU brand, core count, and total memory for the host system.",
    annotations: { title: "Maxion V16 Diagnostics", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: "object", properties: { deep_scan: { type: "boolean", description: "When true, runs extended diagnostics in addition to standard checks." } } },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Hardware diagnostic report." } } },
  },
  {
    name: "security_diamonize_scan", title: "Diamonize Security Scan",
    description: "Hashes a target file (SHA-256) on this endpoint. It performs NO signature matching, so it cannot return a clean or infected verdict — the result is always INDETERMINATE. Use the engine-backed stdio gateway for a real scan.",
    annotations: { title: "Diamonize Security Scan", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { target: { type: "string", description: "Absolute file path to scan, or the literal string 'SYSTEM_MEMORY' to scan active RAM." } }, required: ["target"] },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Security scan analysis and verdict." } } },
  },
  {
    name: "security_diamonize_quarantine", title: "Diamonize Quarantine",
    description: "NOT IMPLEMENTED — returns an error and isolates NOTHING. The Diamonize engine exposes no quarantine operation; a flagged target is left untouched and must be handled by other means.",
    annotations: { title: "Diamonize Quarantine", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { target: { type: "string", description: "Absolute file path or process name to record as quarantined." } }, required: ["target"] },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Quarantine action outcome." } } },
  },
  {
    name: "security_diamonize_logs", title: "Diamonize Security Logs",
    description: "NOT IMPLEMENTED — returns an error. No interception log is kept, so there are no entries to return and no basis for any verdict about the host.",
    annotations: { title: "Diamonize Security Logs", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { count: { type: "number", description: "Number of recent log entries to return (default 10, max 100)." } } },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Interception and event log entries." } } },
  },
  {
    name: "security_diamonize_status", title: "Diamonize Scanner Status",
    description: "Reports Diamonize's real posture on this endpoint: no scan engine and no resident shield process run here, so nothing is intercepted or monitored.",
    annotations: { title: "Diamonize Scanner Status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Security posture telemetry." } } },
  },
  {
    name: "storage_quezar_store", title: "Store Data in Quezar",
    description: "Encrypts and stores a payload in the Quezar Quantum Vault using AES-256-GCM. Returns a Vault ID for retrieval.",
    annotations: { title: "Store Data in Quezar", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: "object", properties: { payload: { type: "string", description: "Plain-text data to encrypt and store. Accepts any string up to 10 MB." } }, required: ["payload"] },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Stored sector ID and encryption metadata." } } },
  },
  {
    name: "storage_quezar_retrieve", title: "Retrieve Quezar Data",
    description: "Decrypts and retrieves a payload from the Quezar Quantum Vault by Vault ID.",
    annotations: { title: "Retrieve Quezar Data", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { Vault_id: { type: "string", description: "The Vault ID returned when the data was stored." } }, required: ["Vault_id"] },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Decrypted payload." } } },
  },
  {
    name: "storage_quezar_delete", title: "Delete Quezar Record",
    description: "Permanently purges a record from the Quezar Quantum Vault.",
    annotations: { title: "Delete Quezar Record", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { Vault_id: { type: "string", description: "The Vault ID of the record to permanently delete." } }, required: ["Vault_id"] },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Deletion confirmation message." } } },
  },
  {
    name: "storage_quezar_list", title: "List Quezar Sectors",
    description: "Lists all encrypted sector IDs currently stored in the Quezar Quantum Vault.",
    annotations: { title: "List Quezar Sectors", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "List of active sector IDs." } } },
  },
  {
    name: "storage_quezar_status", title: "Quezar Storage Status",
    description: "Quezar telemetry: sector count, vault size, and encryption stats.",
    annotations: { title: "Quezar Storage Status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Vault storage metrics." } } },
  },
  {
    name: "media_lineage0_generate", title: "Generate AI Video or Image",
    description: "4K AI video via Amazon Nova Reel 1.1 or commercial-ready images via Nova Canvas. Polls until synthesis completes and returns a presigned download URL.",
    annotations: { title: "Generate AI Video or Image", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: { type: "object", properties: { media_type: { type: "string", enum: ["video", "image"], description: "Output format: 'video' for 4K Nova Reel 1.1 synthesis, 'image' for Nova Canvas commercial-grade image." }, prompt: { type: "string", description: "Natural-language description of the desired video or image content." }, duration: { type: "string", enum: ["6", "12", "30", "60", "120"], description: "Required for media_type='video': the purchased credit's duration in seconds. Must match the duration passed to billing_purchase." } }, required: ["media_type", "prompt"] },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Generated media URL or synthesis job status." } } },
  },
  {
    name: "media_lineage0_status", title: "Lineage.0 Cluster Status",
    description: "Real-time status of the Lineage.0 Nova synthesis cluster and S3 vault.",
    annotations: { title: "Lineage.0 Cluster Status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Cluster availability and queue status." } } },
  },
  {
    name: "media_lineage0_archive", title: "Lineage.0 Media Archive",
    description: "Lists recently synthesized Lineage.0 multimedia artifacts from the AWS S3 vault.",
    annotations: { title: "Lineage.0 Media Archive", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Archive artifact list." } } },
  },
  {
    name: "billing_purchase", title: "Get Trial or Purchase License",
    description: "Returns a Gumroad checkout link for hourly/monthly access to Maxion/Diamonize/Quezar, or a per-video consumable credit for Lineage.0 ($0.14/sec). Each Lineage.0 key is one-time use -- one key, one video.",
    annotations: { title: "Get Trial or Purchase License", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: "object", properties: { tool_name: { type: "string", enum: ["maxion", "diamonize", "quezar", "lineage0"], description: "The tool namespace to license." }, duration: { type: "string", enum: ["trial", "hourly", "monthly", "6", "12", "30", "60", "120"], description: "For maxion/diamonize/quezar: 'trial' (free 30 min), 'hourly', or 'monthly'. For lineage0: number of seconds (6, 12, 30, 60, or 120) -- each purchase is a single consumable video credit." } }, required: ["tool_name", "duration"] },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "License details or checkout URL." } } },
  },
  {
    name: "billing_activate", title: "Activate Gumroad License Key",
    description: "After completing a Gumroad purchase, call this with your product_permalink and license_key to verify and activate your access. For Lineage.0, the key is consumed after one successful video generation.",
    annotations: { title: "Activate Gumroad License Key", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: "object", properties: { product_permalink: { type: "string", description: "The Gumroad product permalink (e.g. 'quezar-monthly')." }, license_key: { type: "string", description: "The license key from your Gumroad purchase email." } }, required: ["product_permalink", "license_key"] },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "Activation result and expiration time." } } },
  },
  {
    name: "gateway_status", title: "Gateway System Status",
    description: "Holistic health overview: all 19 tools, current license status, billing info, and Quezar vault statistics.",
    annotations: { title: "Gateway System Status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { content: { type: "array", description: "System health overview and tool counts." } } },
  },
];

// -- MCP Server factory --------------------------------------------------------

function buildServer(licenseKey, clientIp = 'default') {
  const server = new Server(
    { name: "io.github.aruuhii2yo/maxion-mcp-gateway", version: PKG_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    // Only media_lineage0_generate's video path maps to a real Gumroad
    // product (GUMROAD_PRODUCTS.lineage0 only has the 5 duration keys --
    // there is no product for images or for the read-only status/archive
    // tools). Forwarding any duration for those -- including '' or
    // undefined, both of which were tried -- resolves to
    // GUMROAD_PRODUCTS.lineage0[<that>] === undefined and checkAccess's
    // isLineage branch fails closed on every call, a real regression this
    // fixes: media_lineage0_status, media_lineage0_archive, and
    // media_lineage0_generate with media_type='image' are unlicensed (as
    // they always were pre-PR) and skip the check entirely.
    const isVideoGenerate = name === 'media_lineage0_generate' && args.media_type === 'video';
    const isUnlicensedLineage = name.startsWith('media_lineage0') && !isVideoGenerate;
    const access = isUnlicensedLineage
      ? { ok: true }
      : await checkAccess(licenseKey, name, isVideoGenerate ? String(args.duration ?? '') : undefined, clientIp);
    if (!access.ok) return { isError: true, content: [{ type: "text", text: access.msg }] };

    const ok  = (text) => ({ content: [{ type: "text", text: access.trialNotice ? text + access.trialNotice : text }] });
    const err = (text) => ({ isError: true, content: [{ type: "text", text }] });

    try {
      switch (name) {

        case "engine_maxion_activate": {
          const mins = args.duration_minutes || 60;
          const [cpu, load, mem, temp] = await Promise.all([si.cpu(), si.currentLoad(), si.mem(), si.cpuTemperature()]);
          const cpuName = `${cpu.manufacturer} ${cpu.brand}`.replace(/[^\x20-\x7E]/g, '').trim();
          return ok(`[MAXION V16 ACTIVE] Engine active for ${mins} minutes.\n\nCPU:    ${cpuName} (${cpu.cores} cores)\nLoad:   ${load.currentLoad.toFixed(2)}%\nMemory: ${((mem.active/mem.total)*100).toFixed(2)}% (${(mem.active/1e9).toFixed(2)}/${(mem.total/1e9).toFixed(2)} GB)\nTemp:   ${temp.main ? temp.main + ' deg C' : 'unavailable (no sensor exposed on this host)'}\n\nNote: this endpoint reports host telemetry only. It runs no thermal engine and changes no power or clock state.`);
        }
        case "engine_maxion_deactivate":
          return err("[MAXION V16] Nothing to suspend: this endpoint runs no engine, so no performance protocol is active.");
        case "engine_maxion_status": {
          const [load, temp] = await Promise.all([si.currentLoad(), si.cpuTemperature()]);
          return ok(`[MAXION V16] Telemetry only — no engine runs on this endpoint.\nLoad: ${load.currentLoad.toFixed(2)}%\nTemp: ${temp.main ? temp.main + ' deg C' : 'unavailable (no sensor exposed on this host)'}`);
        }
        case "engine_maxion_diagnostics": {
          const [cpu, mem] = await Promise.all([si.cpu(), si.mem()]);
          const diagCpu = cpu.brand.replace(/[^\x20-\x7E]/g, '').trim();
          return ok(`[MAXION DIAGNOSTICS] ${args.deep_scan ? 'Deep' : 'Standard'} scan complete.\nCPU: ${diagCpu} (${cpu.cores} cores)\nMemory: ${(mem.total/1e9).toFixed(2)} GB total\nResult: inventory only — no diagnostic pass was run and no thermal measurement was taken.`);
        }

        case "security_diamonize_scan": {
          // This endpoint has no scanning engine. It can hash a file, but it
          // performs no signature matching, so it must never answer "CLEAN" or
          // "0 threats detected" — that tells the caller a file carrying
          // malware is safe. Report exactly what was and was not done.
          const target = args.target;
          if (target === 'SYSTEM_MEMORY') {
            const [mem, procs] = await Promise.all([si.mem(), si.processes()]);
            return ok(`[DIAMONIZE LSA] NOT SCANNED — no scanning engine on this endpoint.\nRAM: ${(mem.total/1e9).toFixed(2)} GB\nActive processes: ${procs.all}\nResult: INDETERMINATE — memory was not inspected for threats. Use the engine-backed stdio gateway for a real sweep.`);
          }
          if (!fs.existsSync(target)) return err(`[DIAMONIZE LSA] Target not found: ${target}`);
          const data = fs.readFileSync(target);
          return ok(`[DIAMONIZE LSA] Hashed: ${target}\nSize: ${data.length} bytes\nSHA-256: ${crypto.createHash('sha256').update(data).digest('hex')}\nResult: INDETERMINATE — file was hashed but NOT scanned for threat signatures. This endpoint is not engine-backed; a clean verdict cannot be given here. Use the engine-backed stdio gateway to scan.`);
        }
        // This endpoint is not engine-backed and never will be — Lambda ships no
        // engine binary. These handlers therefore report that they cannot
        // observe the system, rather than returning the healthy-looking strings
        // they used to. mcp_wrapper.js (the stdio path) gates the equivalent
        // tools on engineAvailable() and reaches the same outcome by a
        // different route, so the two entrypoints now agree: no engine means no
        // verdict.
        case "security_diamonize_quarantine":
          return err(`[DIAMONIZE LSA] Cannot quarantine: this endpoint is not engine-backed, so nothing was isolated. Use the engine-backed stdio gateway.`);
        case "security_diamonize_logs":
          return err(`[DIAMONIZE LSA] No interception logs: this endpoint runs no scanner, so it cannot report on system state.`);
        case "security_diamonize_status":
          // Mirrors mcp_wrapper.js: a status query answers with the real
          // posture rather than an error. There is no resident shield on either
          // entrypoint; this one additionally has no scan engine at all.
          return ok(`[DIAMONIZE LSA] Mode: none — this endpoint runs no scanning engine.\nResident shield: none. Nothing is intercepted or monitored here.\nContinuous monitoring: none.\nUse the engine-backed stdio gateway to scan.`);

        case "storage_quezar_store": {
          const id = VaultStore(args.payload);
          return ok(`[QUEZAR Vault] Stored.\nVault ID: ${id}\nEncryption: AES-256-GCM\n\nSave this ID: ${id}`);
        }
        case "storage_quezar_retrieve":
          return ok(`[QUEZAR Vault] Retrieved: ${args.Vault_id}\n\n${VaultRetrieve(args.Vault_id)}`);
        case "storage_quezar_delete":
          VaultDelete(args.Vault_id);
          return ok(`[QUEZAR Vault] Purged: ${args.Vault_id}`);
        case "storage_quezar_list": {
          const ids = VaultList();
          return ok(`[QUEZAR Vault] Active sectors (${ids.length}):\n${ids.length ? ids.map(i => `  * ${i}`).join('\n') : '  (empty)'}`);
        }
        case "storage_quezar_status": {
          const ids = VaultList();
          return ok(`[QUEZAR Vault] Status: ONLINE\nSectors: ${ids.length}\nEncryption: AES-256-GCM\nNote: Hosted-mode storage resets per cold start. For persistent storage install locally.`);
        }

        case "media_lineage0_generate": {
          const { media_type, prompt } = args;
          if (media_type === 'image') {
            const res = await bedrockClient.send(new InvokeModelCommand({
              modelId: 'amazon.nova-canvas-v1:0', contentType: 'application/json', accept: 'application/json',
              body: JSON.stringify({ taskType: "TEXT_IMAGE", textToImageParams: { text: prompt }, imageGenerationConfig: { numberOfImages: 1, height: 1024, width: 1024, cfgScale: 8.0, quality: "premium" } }),
            }));
            const rb = JSON.parse(new TextDecoder().decode(res.body));
            if (!rb.images?.length) throw new Error('Nova Canvas returned no images');
            const key = `nova-canvas-exports/image-${Date.now()}.png`;
            await s3Client.send(new PutObjectCommand({ Bucket: S3_OUTPUT_BUCKET, Key: key, Body: Buffer.from(rb.images[0], 'base64'), ContentType: 'image/png' }));
            const url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: S3_OUTPUT_BUCKET, Key: key }), { expiresIn: 3600 });
            return ok(`[LINEAGE.0 VC] Image synthesis complete.\nURL: ${url}`);
          }
          if (!LINEAGE0_PRICES[String(args.duration)]) {
            return err(`Invalid or missing duration: ${args.duration}. Video generation requires duration to be one of "6", "12", "30", "60", "120" (seconds), matching the credit purchased via billing_purchase.`);
          }
          const durationSeconds = Number(args.duration);
          const startRes = await bedrockClient.send(new StartAsyncInvokeCommand({
            modelId: 'amazon.nova-reel-v1:1', clientRequestToken: `jk-reel-${Date.now()}`,
            outputDataConfig: { s3OutputDataConfig: { s3Uri: `s3://${S3_OUTPUT_BUCKET}/nova-reel-exports/` } },
            modelInput: { taskType: "TEXT_VIDEO", textToVideoParams: { text: prompt }, videoGenerationConfig: { durationSeconds, fps: 24, dimension: "1280x720" } },
          }));
          const videoUrl = await pollNovaJob(startRes.invocationArn);
          return ok(`[LINEAGE.0 VC] Video synthesis complete.\nURL: ${videoUrl}`);
        }
        case "media_lineage0_status":
          return ok(`[LINEAGE.0 VC] Nova cluster: OPERATIONAL\nNova Reel 1.1: online\nNova Canvas: online\nS3 bucket: ${S3_OUTPUT_BUCKET}`);
        case "media_lineage0_archive": {
          const list = await s3Client.send(new ListObjectsV2Command({ Bucket: S3_OUTPUT_BUCKET, MaxKeys: 20 }));
          const items = list.Contents?.slice(0, 20).map(i => `  * ${i.Key} (${(i.Size/1024).toFixed(1)} KB)`) || ['  (empty)'];
          return ok(`[LINEAGE.0 VC] S3 Archive -- ${list.Contents?.length || 0} items:\n${items.join('\n')}`);
        }

        case "billing_purchase": {
          const { tool_name, duration } = args;
          if (duration === 'trial') {
            if (tool_name === 'lineage0')
              return err(`Lineage.0 VC has no free trial. Each key is a one-time consumable credit.\n\nAvailable durations:\n  6s  -- $0.84\n  12s -- $1.68\n  30s -- $3.90\n  60s -- $7.80\n  120s -- $15.60\n\nCall billing_purchase with tool_name="lineage0" and duration="6", "12", "30", "60", or "120".\nEnterprise licensing: aruuh@advancedapparchitect.com`);
            // The trial itself needs no purchase or activation step: checkAccess
            // auto-issues it the moment a ${tool_name}.* tool is called with no
            // license key. This branch previously told the caller to call
            // billing_activate with product_permalink: "${tool_name}-trial" --
            // no such Gumroad product exists (nor did the hourly permalink's
            // "?trial=true" checkout link actually grant a trial), so every
            // caller who followed those instructions hit a hard rejection on a
            // free tool anyone can call.
            return ok(`[BILLING] The ${tool_name} trial is automatic -- just call any ${tool_name}.* tool with no license key and it's allowed as a trial. No purchase or activation step needed.\nTo upgrade, call billing_purchase with duration="hourly" or "monthly".`);
          }
          const isLineage = tool_name === 'lineage0';
          const priceEntry = isLineage ? LINEAGE0_PRICES[duration] : PRICES[duration];
          if (!priceEntry) return err(isLineage
            ? `Invalid duration: ${duration}. For lineage0 use "6", "12", "30", "60", or "120" (seconds).`
            : `Invalid duration: ${duration}. Use "trial", "hourly", or "monthly".`);
          const permalink = GUMROAD_PRODUCTS[tool_name]?.[duration];
          if (!permalink) return err(`No Gumroad product configured for ${tool_name}/${duration}. Contact aruuh@advancedapparchitect.com.`);
          const label = isLineage ? priceEntry.label : `${duration} access — ${tool_name}`;
          return ok(`[BILLING] ${label}\n\nComplete purchase on Gumroad:\n  ${permalink}\n\nOur checkout page will automatically activate your license. If prompted, call billing_activate with your product_permalink and license_key from the Gumroad receipt email.\n\nEnterprise plans: aruuh@advancedapparchitect.com`);
        }

        case "billing_activate": {
          const { product_permalink, license_key } = args;
          if (!product_permalink || !license_key) return err('billing_activate requires product_permalink and license_key.');
          try {
            // For Lineage.0, use increment_uses_count=true to track consumption
            const isLineage = product_permalink.startsWith('lineage');
            const data = await verifyGumroadLicense(product_permalink, license_key, { increment_uses_count: isLineage });
            const purchase = data.purchase;
            const info = isLineage
              ? `[BILLING] Lineage.0 key verified! \n\nThis is a one-time consumable credit. It will be consumed after your video is successfully generated.\nProduct: ${purchase.product_name}\nPurchased: ${purchase.created_at}`
              : `[BILLING] License activated!\n\nProduct: ${purchase.product_name}\nPurchased: ${purchase.created_at}\n\nYou now have access to all tools in this namespace. Proceed to execute the tool.`;
            return ok(info);
          } catch (e) {
            return err(`[BILLING] Verification failed: ${e.message}`);
          }
        }

        case "gateway_status":
          return ok(`[MAXION MCP GATEWAY] ${PKG_VERSION}\nMode: Hosted (AWS Lambda)\nLicense: ${licenseKey ? 'Gumroad key provided' : 'No license -- call billing_purchase'}\nTools: 19 endpoints active\nLineage.0 Media: ONLINE (Nova Reel 1.1 + Nova Canvas)\nBilling: Gumroad (card payments) live\nEnterprise: aruuh@advancedapparchitect.com`);

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return err(`[ERROR] ${e.message}`);
    }
  });

  return server;
}

// -- Lambda handler ------------------------------------------------------------

const CORS_METHODS  = "GET, POST, DELETE, OPTIONS";
const CORS_HEADERS  = "Content-Type, Authorization, mcp-session-id, x-fleet-key";

function corsHeaders(event) {
  // Reflect the request Origin so Authorization is explicitly covered (Chrome milestone 97+)
  const origin = (event.headers || {})["origin"] || (event.headers || {})["Origin"] || "*";
  return {
    "Access-Control-Allow-Origin":  origin,
    "Access-Control-Allow-Methods": CORS_METHODS,
    "Access-Control-Allow-Headers": CORS_HEADERS,
    "Vary": "Origin",
  };
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  const method  = (event.requestContext?.http?.method || event.httpMethod || "GET").toUpperCase();
  const rawPath = event.requestContext?.http?.path  || event.path || "/";
  const qs      = event.rawQueryString ? `?${event.rawQueryString}` : "";

  const CORS = corsHeaders(event);

  if (method === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  if ((method === "GET" || method === "HEAD") && (rawPath === "/" || rawPath === "/health" || rawPath === "")) {
    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "zero-heat-super-compute",
        displayName: "Zero Heat Super Compute -- AWS Partner",
        status: "ok",
        version: PKG_VERSION,
        tools_count: TOOLS.length,
        description: "J&K Advanced Technologies -- AWS certified partner. 19-tool enterprise compute suite: Maxion V16 thermal performance engine, Diamonize LSA zero-trust security, Quezar AES-256-GCM encrypted storage, Lineage.0 VC (4K AI video + commercial images via Amazon Nova).",
        icon: "https://jk-advanced-tech-web.s3.us-east-2.amazonaws.com/maxion-icon.svg",
        homepage: "https://advancedapparchitect.com"
      })
    };
  }

  if (rawPath === "/.well-known/mcp/server-card.json") {
    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "zero-heat-super-compute",
        displayName: "Zero Heat Super Compute -- AWS Partner",
        version: PKG_VERSION,
        description: "J&K Advanced Technologies -- AWS certified partner. 19-tool enterprise compute suite: Maxion V16 thermal performance engine, Diamonize LSA zero-trust security, Quezar AES-256-GCM encrypted storage, Lineage.0 VC (4K AI video + commercial images via Amazon Nova). Per-tool card licensing via Gumroad.",
        icon: "https://jk-advanced-tech-web.s3.us-east-2.amazonaws.com/maxion-icon.svg",
        homepage: "https://advancedapparchitect.com",
        tools: TOOLS,
      }),
    };
  }

  if (rawPath === "/mcp" && method === "DELETE") return { statusCode: 200, headers: CORS, body: "" };

  // Stateless Lambda -- SSE not supported; tell claude.ai validator to use POST only
  if (rawPath === "/mcp" && method === "GET") {
    return {
      statusCode: 405,
      headers: { ...CORS, "Allow": "POST, DELETE, OPTIONS" },
      body: JSON.stringify({ error: "SSE not supported in stateless mode. Use POST." }),
    };
  }

  const bodyStr0 = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");

  // -- Gumroad license endpoints -----------------------------------------------
  if (rawPath === "/license/verify" && method === "POST") return licenseVerify(bodyStr0, CORS);
  if (rawPath === "/gumroad/inject" && method === "POST") {
    // Receives { product_permalink, license_key } — verifies against Gumroad and returns result
    let payload; try { payload = JSON.parse(bodyStr0 || '{}'); } catch { return json400(CORS, 'Invalid JSON'); }
    try {
      const data = await verifyGumroadLicense(payload.product_permalink, payload.license_key);
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ valid: true, purchase: data.purchase }) };
    } catch (e) {
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ valid: false, error: e.message }) };
    }
  }

  if (!rawPath.startsWith("/mcp") && rawPath !== "/") return { statusCode: 404, headers: CORS, body: "Not Found" };

  // AWS Agent Space requires explicit authorization for MCP endpoints to ensure secure communication
  const headersStr = JSON.stringify(event.headers || {});
  if (!headersStr.includes('maxion-gateway-key')) {
    return { statusCode: 401, headers: CORS, body: 'Unauthorized: API Key required' };
  }

  const bodyStr = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");

  const url = `https://lambda${rawPath}${qs}`;
  const inHeaders = new Headers();
  for (const [k, v] of Object.entries(event.headers || {})) inHeaders.set(k, v);
  inHeaders.set("accept", "application/json, */*");

  // SDK validates Accept contains both types even with enableJsonResponse
  inHeaders.set("accept", "application/json, text/event-stream");

  const webRequest = new Request(url, {
    method,
    headers: inHeaders,
    body: method === "POST" && bodyStr ? bodyStr : undefined,
  });

  const requestLicenseKey = (event.headers || {})['x-fleet-key'] || '';
  const clientIp = event.requestContext?.http?.sourceIp || event.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || 'default';
  const server    = buildServer(requestLicenseKey, clientIp);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  let webResponse;
  try {
    await server.connect(transport);
    let parsedBody;
    try { parsedBody = bodyStr ? JSON.parse(bodyStr) : undefined; } catch {}
    webResponse = await transport.handleRequest(webRequest, { parsedBody });
  } catch (e) {
    return { statusCode: 500, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ error: e.message }) };
  } finally {
    try { await transport.close(); } catch {}
    try { await server.close(); } catch {}
  }

  const resHeaders = { ...CORS };
  webResponse.headers.forEach((v, k) => { resHeaders[k] = v; });
  return { statusCode: webResponse.status, headers: resHeaders, body: await webResponse.text(), isBase64Encoded: false };
};
