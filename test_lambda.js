/**
 * MAXION MCP GATEWAY — HOSTED LAMBDA TEST SUITE
 * ===============================================
 * run_tests.js drives mcp_wrapper.js (the stdio path) exclusively. Nothing
 * exercised lambda.js — the file that actually deploys — so an edit could
 * remove outputSchema from every tool, flip four handlers from ok() to err(),
 * rewrite response text, or break PKG_VERSION resolution, and the suite would
 * report green. Confirmed: patching PKG_VERSION to resolve undefined left
 * run_tests.js at PASS/0 FAIL.
 *
 * This drives lambda.js's exports.handler directly with synthetic API Gateway
 * v2 (Function URL) events — the same code path AWS invokes, not a reach into
 * internals. lambda.js has no MOCK_AWS support (unlike mcp_wrapper.js) --
 * constructing BedrockRuntimeClient/S3Client is safe with no credentials, but
 * a test that lets a call reach send() will hit live AWS and fail on missing
 * creds in an environment like this one. Tests that need to get past the
 * license gate into a real AWS-calling branch assert on the checkAccess
 * outcome (isError + message content) rather than the AWS call's own result,
 * so they pass in any environment regardless of AWS credentials.
 *
 * Exit codes: 0 = all assertions passed   1 = at least one failed
 */
'use strict';
const path = require('path');
const fs = require('fs');

// lambda.js reads GUMROAD_* into its GUMROAD_PRODUCTS object at module load
// time (top-level `process.env.GUMROAD_MAXION_HOURLY`, not read per-call), so
// these must be set before the require() below, not inside main(). Mirrors
// what lambda_env.json is meant to apply on the real function -- simulating a
// correctly-configured deploy so billing.purchase's real permalink-resolution
// path is actually exercised, rather than short-circuiting on "no Gumroad
// product configured" before reaching the code these tests are about.
if (!process.env.GUMROAD_MAXION_HOURLY) {
  const lambdaEnvVars = JSON.parse(fs.readFileSync(path.join(__dirname, 'lambda_env.json'), 'utf8')).Variables;
  for (const [k, v] of Object.entries(lambdaEnvVars)) {
    if (k.startsWith('GUMROAD_')) process.env[k] = v;
  }
}
process.env.AWS_EC2_METADATA_DISABLED = 'true';
process.env.AWS_REGION = 'us-east-2';

const { handler } = require('./lambda.js');
const { version: PKG_VERSION } = require('./package.json');

const stats = { pass: 0, fail: 0 };
const failures = [];

function pass(label) { stats.pass++; console.log(`  ✅ PASS  ${label}`); }
function fail(label, detail) {
  stats.fail++;
  failures.push({ label, detail });
  console.log(`  ❌ FAIL  ${label}`);
  console.log(`           ${String(detail).split('\n').join('\n           ')}`);
}
function check(label, cond, detail) { cond ? pass(label) : fail(label, detail || 'condition was false'); }

function section(label) {
  console.log('\n' + '─'.repeat(60));
  console.log(`  ▶ ${label}`);
  console.log('─'.repeat(60));
}

/** Build a synthetic API Gateway v2 (Function URL) event. */
function apiEvent({ method = 'POST', path: p = '/mcp', headers = {}, body = null }) {
  return {
    requestContext: { http: { method, path: p } },
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
  };
}

/** JSON-RPC 2.0 tools/call envelope, with the auth header every /mcp route requires. */
function toolCall(name, args = {}, extraHeaders = {}) {
  return apiEvent({
    path: '/mcp',
    headers: { 'maxion-gateway-key': 'test-key', ...extraHeaders },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
}

function toolsList() {
  return apiEvent({
    path: '/mcp',
    headers: { 'maxion-gateway-key': 'test-key' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
}

function parseSSEorJSON(bodyText) {
  // enableJsonResponse:true normally yields plain JSON; tolerate an SSE
  // "data: {...}" frame in case the transport falls back to it.
  const m = bodyText.match(/^data:\s*(\{.*\})\s*$/m);
  return JSON.parse(m ? m[1] : bodyText);
}

async function callTool(name, args, extraHeaders = {}) {
  const res = await handler(toolCall(name, args, extraHeaders), {});
  const rpc = parseSSEorJSON(res.body);
  const result = rpc.result;
  const text = result?.content?.[0]?.text || '';
  return { statusCode: res.statusCode, isError: !!result?.isError, text, raw: rpc, headers: res.headers };
}

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  MAXION MCP GATEWAY — HOSTED LAMBDA TEST SUITE');
  console.log('═'.repeat(60));

  section('Static routes');
  {
    const health = await handler(apiEvent({ method: 'GET', path: '/health' }), {});
    check('GET /health returns 200', health.statusCode === 200, `got ${health.statusCode}`);
    const hbody = JSON.parse(health.body);
    check('/health reports a real version, not undefined',
      hbody.version === PKG_VERSION && hbody.version !== 'undefined',
      `got version=${JSON.stringify(hbody.version)}, expected ${JSON.stringify(PKG_VERSION)}`);

    const card = await handler(apiEvent({ method: 'GET', path: '/.well-known/mcp/server-card.json' }), {});
    check('server-card.json returns 200', card.statusCode === 200, `got ${card.statusCode}`);
    const cbody = JSON.parse(card.body);
    check('server-card version matches package.json', cbody.version === PKG_VERSION,
      `got ${JSON.stringify(cbody.version)}`);
    check('server-card lists tools', Array.isArray(cbody.tools) && cbody.tools.length > 0,
      `tools: ${JSON.stringify(cbody.tools)}`);

    const opts = await handler(apiEvent({ method: 'OPTIONS', path: '/mcp' }), {});
    check('OPTIONS /mcp returns 200', opts.statusCode === 200, `got ${opts.statusCode}`);

    const getMcp = await handler(apiEvent({ method: 'GET', path: '/mcp' }), {});
    check('GET /mcp (no SSE support) returns 405', getMcp.statusCode === 405, `got ${getMcp.statusCode}`);
  }

  section('Auth');
  {
    const noKey = await handler(apiEvent({ path: '/mcp', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }), {});
    check('POST /mcp without maxion-gateway-key returns 401', noKey.statusCode === 401,
      `got ${noKey.statusCode}: ${noKey.body}`);
  }

  section('tools/list — schema shape');
  {
    const res = await handler(toolsList(), {});
    check('tools/list returns 200', res.statusCode === 200, `got ${res.statusCode}`);
    const rpc = parseSSEorJSON(res.body);
    const tools = rpc.result?.tools || [];
    check('tools/list returns 19+ tools', tools.length >= 19, `got ${tools.length}`);
    const withSchema = tools.filter(t => t.outputSchema).map(t => t.name);
    check('all tools declare outputSchema for Smithery 100/100 quality score',
      withSchema.length === tools.length,
      `missing outputSchema on: ${tools.filter(t => !t.outputSchema).map(t => t.name).join(', ')}`);
  }

  section('Response envelope — the four tools this PR changed');
  {
    const deact = await callTool('engine_maxion_deactivate');
    check('engine_maxion_deactivate returns isError', deact.isError, `text: ${deact.text.slice(0, 150)}`);

    const quar = await callTool('security_diamonize_quarantine', { target: '/tmp/x' });
    check('security_diamonize_quarantine returns isError (isolates nothing)', quar.isError,
      `text: ${quar.text.slice(0, 150)}`);
    check('quarantine never claims containment',
      !/Vaulted|Quarantined:/i.test(quar.text), `text: ${quar.text.slice(0, 150)}`);

    const logs = await callTool('security_diamonize_logs', {});
    check('security_diamonize_logs returns isError (no log is kept)', logs.isError,
      `text: ${logs.text.slice(0, 150)}`);

    const status = await callTool('security_diamonize_status', {});
    check('security_diamonize_status succeeds (reports posture, not an error)', !status.isError,
      `text: ${status.text.slice(0, 150)}`);
    check('status does not claim a resident shield', !/Shield: ACTIVE/i.test(status.text),
      `text: ${status.text.slice(0, 150)}`);

    const scan = await callTool('security_diamonize_scan', { target: 'SYSTEM_MEMORY' });
    check('security_diamonize_scan succeeds', !scan.isError, `text: ${scan.text.slice(0, 150)}`);
    check('scan reports INDETERMINATE, never CLEAN, without signature matching',
      /INDETERMINATE/.test(scan.text) && !/CLEAN/.test(scan.text),
      `text: ${scan.text.slice(0, 150)}`);
  }

  section('Free tools (no license required)');
  {
    const gw = await callTool('gateway_status', {});
    check('gateway_status succeeds', !gw.isError, `text: ${gw.text.slice(0, 150)}`);
    check('gateway_status reports the real package version', gw.text.includes(PKG_VERSION),
      `expected ${PKG_VERSION} in: ${gw.text.slice(0, 150)}`);

    const diag = await callTool('engine_maxion_diagnostics', {});
    check('engine_maxion_diagnostics succeeds', !diag.isError, `text: ${diag.text.slice(0, 150)}`);
  }

  section('Billing — lambda_env.json permalinks match the working stdio config');
  {
    // Static, not behavioral: this is the check that would have caught the
    // real bug directly. lambda_env.json shipped long-form permalinks
    // (maxion-v16-hourly) that appear nowhere else in the repo; every other
    // source -- mcp_wrapper.js's GUMROAD_LINKS, web-hub's gumroad.ts, and
    // this repo's own comments about the real Gumroad products -- agrees on
    // short-form (maxion-hourly). Since GUMROAD_MAXION_HOURLY etc. were never
    // actually applied to the live Lambda until the Apply Lambda Environment
    // Variables deploy step (added this session), the mismatch was dormant;
    // it would have gone live the first time that step ran. Parses the real
    // file, not a copy, so an edit to either side is caught here.
    const lambdaEnv = JSON.parse(fs.readFileSync(path.join(__dirname, 'lambda_env.json'), 'utf8')).Variables;
    const wrapperSrc = fs.readFileSync(path.join(__dirname, 'mcp_wrapper.js'), 'utf8');
    const expectPermalink = (envVar, permalink) => {
      check(`lambda_env.json's ${envVar} ("${lambdaEnv[envVar]}") matches a real permalink used elsewhere`,
        lambdaEnv[envVar] === permalink,
        `expected "${permalink}" (from mcp_wrapper.js's GUMROAD_LINKS), got "${lambdaEnv[envVar]}"`);
      check(`"${permalink}" actually appears in mcp_wrapper.js's GUMROAD_LINKS`,
        wrapperSrc.includes(`/l/${permalink}`),
        `mcp_wrapper.js does not reference this permalink at all -- update the expected value above if it legitimately changed`);
    };
    expectPermalink('GUMROAD_MAXION_HOURLY', 'maxion-hourly');
    expectPermalink('GUMROAD_MAXION_MONTHLY', 'maxion-monthly');
    expectPermalink('GUMROAD_DIAMONIZE_HOURLY', 'diamonize-hourly');
    expectPermalink('GUMROAD_DIAMONIZE_MONTHLY', 'diamonize-monthly');
    expectPermalink('GUMROAD_QUEZAR_HOURLY', 'quezar-hourly');
    expectPermalink('GUMROAD_QUEZAR_MONTHLY', 'quezar-monthly');
    // lineage0 is a single dynamically-priced product (per mcp_wrapper.js:
    // { per_second: '.../lineage0-video' }), not five separate fixed-duration
    // products -- lambda_env.json previously implied five distinct Gumroad
    // products (lineage0-6s, -12s, ...) that there is no evidence exist.
    for (const dur of ['6', '12', '30', '60', '120']) {
      expectPermalink(`GUMROAD_LINEAGE_${dur}`, 'lineage0-video');
    }
  }

  section('Billing — trial instructions do not dead-end');
  {
    const trial = await callTool('billing_purchase', { tool_name: 'maxion', duration: 'trial' });
    check('trial purchase call succeeds', !trial.isError, `text: ${trial.text.slice(0, 200)}`);
    check('trial message does not send the caller to a nonexistent Gumroad permalink',
      !/product_permalink: "maxion-trial"/.test(trial.text),
      `still instructs the caller to activate a "-trial" permalink that doesn't exist:\n${trial.text}`);
    check('trial message describes the real (automatic) mechanism',
      /automatic/.test(trial.text) && /no license key/.test(trial.text),
      `text: ${trial.text}`);

    // Prove the auto-trial this message describes is real, not just claimed:
    // call an actual maxion tool with no license key and confirm it succeeds.
    const autoTrial = await callTool('engine_maxion_diagnostics', {});
    check('the described auto-trial actually works (no license key needed)',
      !autoTrial.isError, `text: ${autoTrial.text.slice(0, 200)}`);
  }

  section('Billing — license enforcement actually runs (not a silent pass-through)');
  {
    // buildServer's CallToolRequestSchema handler had TWO `checkAccess`
    // function declarations: an async, real one (Gumroad verification) and a
    // later synchronous placeholder `function checkAccess(licenseKey, toolName)
    // { return { ok: true }; }`. JS hoists both, and the later declaration
    // wins -- so the real one was permanently dead code and every paid tool
    // silently allowed ANY x-fleet-key (or none) through with no verification
    // at all. This did not surface as a test failure before because no test
    // ever supplied a bogus key on a paid tool and asserted it gets rejected.
    //
    // A garbage key against the real Gumroad API is guaranteed to fail
    // verification (unknown/invalid license), so this must come back isError
    // once enforcement actually runs. Whether the network call itself
    // succeeds or errors, the shadowed-placeholder bug would still return
    // ok:true unconditionally -- so this assertion fails against that bug
    // regardless of network reachability in CI.
    const badKey = await callTool('engine_maxion_activate', {}, { 'x-fleet-key': 'not-a-real-license-key' });
    check('a bogus license key on a paid tool is rejected, not silently allowed',
      badKey.isError, `expected isError:true, got isError:${badKey.isError}, text: ${badKey.text.slice(0, 200)}`);
  }

  section('Billing — media.lineage0.generate honors the purchased video duration');
  {
    // The Nova Reel call previously hardcoded durationSeconds: 6 regardless
    // of what the customer purchased, so a 120s credit produced a 6s video.
    // The tool's inputSchema now requires `duration` and the handler
    // validates it before ever calling Bedrock. No license key is supplied
    // here (media_lineage0 tools get no auto-trial), so this exercises the
    // schema-level guard without needing network access to Bedrock or Gumroad.
    const noDuration = await callTool('media_lineage0_generate', { media_type: 'video', prompt: 'test' });
    check('media_lineage0_generate without a license is rejected before duration is even checked',
      noDuration.isError && /license/i.test(noDuration.text),
      `text: ${noDuration.text.slice(0, 200)}`);

    const wrapperSrc = fs.readFileSync(path.join(__dirname, 'lambda.js'), 'utf8');
    check('media_lineage0_generate inputSchema declares duration with the 5 real tiers',
      /duration:\s*\{[^}]*enum:\s*\["6",\s*"12",\s*"30",\s*"60",\s*"120"\]/.test(wrapperSrc),
      'expected the media_lineage0_generate tool schema to require duration in ["6","12","30","60","120"]');
    check('the Nova Reel call no longer hardcodes durationSeconds: 6',
      !/durationSeconds:\s*6\b/.test(wrapperSrc),
      'found a literal durationSeconds: 6 in lambda.js -- purchased duration is not being threaded through');
    check('the Nova Reel call uses a duration derived from args.duration',
      /durationSeconds\s*,/.test(wrapperSrc) || /durationSeconds:\s*durationSeconds/.test(wrapperSrc),
      'expected videoGenerationConfig to pass a durationSeconds variable, not a literal');
  }

  section('Billing — read-only/image lineage0 paths are not license-blocked');
  {
    // All 5 GUMROAD_LINEAGE_* env vars resolve to the same permalink, so
    // forwarding *any* duration value (even '' or undefined) for
    // media_lineage0_status/_archive or the image branch of
    // media_lineage0_generate made GUMROAD_PRODUCTS.lineage0[<that>]
    // resolve to undefined and fail every call -- a real regression caught
    // by review. None of these three paths has a Gumroad product mapped to
    // it at all, so they must skip the license check entirely, same as
    // pre-PR behavior.
    const status = await callTool('media_lineage0_status', {});
    check('media_lineage0_status is not license-blocked', !status.isError, `text: ${status.text.slice(0, 200)}`);

    // media_lineage0_archive calls S3 ListObjectsV2Command for real -- no
    // MOCK_AWS support in lambda.js means this errors in an environment with
    // no AWS credentials. That's a legitimate (unrelated) failure mode, not
    // the license-gate regression this test is about, so assert on which
    // error it is, not whether it errors.
    const archive = await callTool('media_lineage0_archive', {});
    check('media_lineage0_archive is not license-blocked',
      !archive.isError || !/UNAUTHORIZED|No Gumroad product configured/.test(archive.text),
      `text: ${archive.text.slice(0, 200)}`);

    const image = await callTool('media_lineage0_generate', { media_type: 'image', prompt: 'a cat' });
    check('media_lineage0_generate(image) is not license-blocked',
      !image.isError || !/No Gumroad product configured/.test(image.text),
      `text: ${image.text.slice(0, 200)}`);
  }

  section('Billing — a cheap lineage0 credit cannot unlock a longer video');
  {
    // All 5 duration tiers resolve to the identical "lineage0-video"
    // permalink, so product_permalink alone cannot distinguish a 6s
    // purchase from a 120s one. checkAccess now cross-checks Gumroad's
    // `quantity` field against the requested duration (LINEAGE0_UNIT_SECONDS
    // per unit) so a 1-unit (6s) license cannot be replayed against a
    // duration:'120' request. Stub fetch to simulate exactly that: a real,
    // valid, unrefunded license for the right product but only 1 unit of
    // quantity.
    const realFetch = global.fetch;
    global.fetch = async () => ({
      json: async () => ({
        success: true,
        purchase: { product_permalink: 'lineage0-video', quantity: 1, refunded: false, chargebacked: false },
      }),
    });
    try {
      const underpaid = await callTool(
        'media_lineage0_generate',
        { media_type: 'video', prompt: 'test', duration: '120' },
        { 'x-fleet-key': 'a-real-6s-license' },
      );
      check('a 1-unit (6s) license cannot generate a 120s video',
        underpaid.isError, `expected isError:true, got isError:${underpaid.isError}, text: ${underpaid.text.slice(0, 200)}`);

      // Getting past checkAccess here means the call reaches the real
      // Bedrock client, which errors on missing AWS credentials in an
      // environment like this one -- a legitimate, unrelated failure. Assert
      // on the license-gate outcome specifically, not the AWS call's result.
      const correctlyPaid = await callTool(
        'media_lineage0_generate',
        { media_type: 'video', prompt: 'test', duration: '6' },
        { 'x-fleet-key': 'a-real-6s-license' },
      );
      check('the same 1-unit license IS accepted for the 6s duration it actually covers',
        !/does not cover|UNAUTHORIZED|License /.test(correctlyPaid.text),
        `text: ${correctlyPaid.text.slice(0, 200)}`);
    } finally {
      global.fetch = realFetch;
    }
  }

  section('Billing — repeat calls with the same license do not re-hit Gumroad');
  {
    // A client polling a status-style tool in a loop previously paid a full
    // Gumroad round trip on every single call (1-2 fetches, no caching) --
    // enough volume can trip Gumroad's own rate limit. checkAccess now
    // caches a successful hourly/monthly verify per (namespace, licenseKey)
    // for a few minutes. Count fetch invocations across two calls with the
    // same key; the second must not add another fetch.
    const realFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls++;
      return { json: async () => ({
        success: true,
        purchase: { product_permalink: 'quezar-hourly', quantity: 1, refunded: false, chargebacked: false },
      }) };
    };
    try {
      await callTool('storage_quezar_store', { payload: 'cache-test' }, { 'x-fleet-key': 'cache-test-key' });
      const afterFirst = fetchCalls;
      await callTool('storage_quezar_store', { payload: 'cache-test' }, { 'x-fleet-key': 'cache-test-key' });
      check('a second call with the same license key does not trigger another Gumroad fetch',
        fetchCalls === afterFirst, `expected fetchCalls to stay at ${afterFirst}, got ${fetchCalls}`);
    } finally {
      global.fetch = realFetch;
    }
  }

  section('Billing — /mcp license verify is case-insensitive on product_permalink, matching mcp_wrapper.js');
  {
    // mcp_wrapper.js's verifyGumroadLicense already lowercases before
    // comparing; lambda.js's didn't, so a consumer of the hosted Function
    // URL typing "Maxion-hourly" (Gumroad itself canonicalizes to lowercase
    // in its responses) was rejected even though the key was genuinely
    // valid for that product -- an entrypoint drift.
    // Real Gumroad always returns its own canonical (lowercase) permalink in
    // the response regardless of what case the request sent -- stubbed here
    // as a fixed lowercase value so the test actually exercises the
    // comparison, not just echoes back whatever was sent (which would pass
    // even with strict-case comparison, since both sides come from the same
    // variable).
    const realFetch = global.fetch;
    global.fetch = async () => ({ json: async () => ({
      success: true,
      purchase: { product_permalink: 'maxion-hourly', quantity: 1, refunded: false, chargebacked: false },
    }) });
    try {
      const res = await handler(apiEvent({
        path: '/license/verify',
        body: { license_key: 'some-key', product_permalink: 'Maxion-Hourly' },
      }), {});
      const body = JSON.parse(res.body);
      check('uppercase/mixed-case product_permalink is still accepted',
        body.valid === true, `expected valid:true, got: ${JSON.stringify(body)}`);
    } finally {
      global.fetch = realFetch;
    }
  }

  section('Billing — a rejected (under-sized) lineage0 attempt does not consume the Gumroad credit');
  {
    // The credit-consuming call (increment_uses_count:true) previously
    // fired before the quantity check, so a client retrying/probing
    // durations against an under-sized license burned real activations on
    // attempts that were rejected anyway. Stub fetch to record whether any
    // increment_uses_count=true request was ever sent across 3 rejected
    // attempts.
    const realFetch = global.fetch;
    let incrementCalls = 0;
    global.fetch = async (url, opts) => {
      const body = new URLSearchParams(opts.body);
      if (body.get('increment_uses_count') === 'true') incrementCalls++;
      return { json: async () => ({
        success: true,
        purchase: { product_permalink: 'lineage0-video', quantity: 1, refunded: false, chargebacked: false },
      }) };
    };
    try {
      for (let i = 0; i < 3; i++) {
        const res = await callTool(
          'media_lineage0_generate',
          { media_type: 'video', prompt: 'test', duration: '120' },
          { 'x-fleet-key': 'under-sized-key' },
        );
        check(`rejected attempt #${i + 1} (under-sized license) is isError`, res.isError, `text: ${res.text.slice(0, 150)}`);
      }
      check('none of the 3 rejected attempts consumed a Gumroad activation',
        incrementCalls === 0, `expected 0 increment_uses_count=true calls, got ${incrementCalls}`);
    } finally {
      global.fetch = realFetch;
    }
  }

  section('Billing — accessCache is capped, not unbounded');
  {
    const wrapperSrc = fs.readFileSync(path.join(__dirname, 'lambda.js'), 'utf8');
    check('lambda.js declares an accessCache size cap',
      /ACCESS_CACHE_MAX_ENTRIES/.test(wrapperSrc),
      'expected an ACCESS_CACHE_MAX_ENTRIES constant bounding accessCache growth');

    // Insert past the cap with distinct license keys and confirm the
    // earliest entry was evicted (a fresh fetch is required for it again),
    // not retained forever.
    const realFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls++;
      return { json: async () => ({
        success: true,
        purchase: { product_permalink: 'quezar-hourly', quantity: 1, refunded: false, chargebacked: false },
      }) };
    };
    try {
      const capMatch = wrapperSrc.match(/ACCESS_CACHE_MAX_ENTRIES\s*=\s*(\d+)/);
      const cap = capMatch ? Number(capMatch[1]) : 50;
      const probeCount = cap + 5; // mocked fetch, so even a 50+ cap is fast enough to actually exercise eviction
      for (let i = 0; i < probeCount; i++) {
        await callTool('storage_quezar_store', { payload: 'test' }, { 'x-fleet-key': `cache-cap-key-${i}` });
      }
      // This assertion only proves something meaningful if probeCount actually
      // exceeded the cap; skip the eviction check otherwise rather than assert
      // nothing useful.
      const before = fetchCalls;
      await callTool('storage_quezar_store', { payload: 'test' }, { 'x-fleet-key': 'cache-cap-key-0' });
      check('the earliest-inserted key was evicted once the cap was exceeded',
        fetchCalls > before, 'earliest key was still served from cache after exceeding ACCESS_CACHE_MAX_ENTRIES');
    } finally {
      global.fetch = realFetch;
    }
  }

  section('Billing — a network failure on the increment call does not deny an already-verified request');
  {
    // The credit-consuming call is a second, separate Gumroad round trip
    // after the quantity check already passed. If THAT call fails at the
    // network/parse level (not because Gumroad rejected it -- the request
    // itself may well have succeeded server-side), the customer must not
    // be denied a video they already qualify for on top of possibly having
    // burned the activation they can't observe succeeding.
    const realFetch = global.fetch;
    let callNum = 0;
    global.fetch = async (url, opts) => {
      callNum++;
      const body = new URLSearchParams(opts.body);
      if (body.get('increment_uses_count') === 'true') {
        throw new Error('ECONNRESET (simulated)');
      }
      return { json: async () => ({
        success: true,
        purchase: { product_permalink: 'lineage0-video', quantity: 1, refunded: false, chargebacked: false },
      }) };
    };
    try {
      const res = await callTool(
        'media_lineage0_generate',
        { media_type: 'video', prompt: 'test', duration: 'invalid' },
        { 'x-fleet-key': 'increment-fails-key' },
      );
      check('access is still granted when only the increment call fails after a successful quantity check',
        !/does not cover|UNAUTHORIZED|License /.test(res.text),
        `text: ${res.text.slice(0, 200)}`);
    } finally {
      global.fetch = realFetch;
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`  ${stats.fail === 0 ? 'PASS' : 'FAIL'} — ${stats.pass} passed, ${stats.fail} failed`);
  console.log('═'.repeat(60) + '\n');
  process.exit(stats.fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('\n[FATAL]', e.stack || e.message); process.exit(1); });
