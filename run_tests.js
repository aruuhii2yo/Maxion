/**
 * MAXION MCP GATEWAY — BLACK-BOX TEST SUITE
 * ==========================================
 * Tests each engine via MCP tool calls only.
 * No internal engine logic is accessed or referenced.
 *
 * Every check asserts. A failing check fails the run and the process exits
 * non-zero, so CI and humans see a red result instead of a wall of text that
 * ends in "COMPLETE" regardless of outcome.
 *
 * Engine-backed tools require their Rust binary. When a binary is absent those
 * checks are reported SKIP (not PASS) and the summary says so — an unbuilt
 * engine is an untested engine, never a passing one.
 *
 * Usage:
 *   node run_tests.js              # all suites
 *   node run_tests.js quezar       # one suite
 *
 * Exit codes:  0 = all assertions passed   1 = at least one failed
 */

"use strict";
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const cp   = require('child_process');

// Redirect license + vault state into a throwaway directory BEFORE loading the
// gateway, which reads these at require time. The suite grants trials, and
// <tool>_trial_used is one-way — without this, running `npm test` on a machine
// that also runs the gateway would permanently burn its free trials and leave
// entries in the real vault.
// Guarded: requiring this file (from a larger runner, or a tool inspecting it)
// must not rewrite the host process's license/vault paths or delete its fleet
// key. Those mutations belong to a CLI run only.
const IS_CLI = require.main === module;
const TEST_STATE_DIR = IS_CLI ? fs.mkdtempSync(path.join(os.tmpdir(), 'maxion-test-')) : null;
if (IS_CLI) {
  process.env.MAXION_LICENSE_FILE = path.join(TEST_STATE_DIR, 'licenses.json');
  process.env.MAXION_VAULT_DIR    = path.join(TEST_STATE_DIR, 'vault');
  process.env.DIAMONIZE_QUARANTINE_DIR = path.join(TEST_STATE_DIR, 'quarantine_vault');
  process.env.DIAMONIZE_AUDIT_LOG      = path.join(TEST_STATE_DIR, 'diamonize_audit.jsonl');
  // Keeps the tracked quezar-app/public/state.json out of the working tree.
  process.env.MAXION_DASHBOARD_STATE_DIR = path.join(TEST_STATE_DIR, 'dashboard');
  process.on('exit', () => {
    try { fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true }); } catch {}
  });
}

// hasLicense() short-circuits on MAXION_FLEET_KEY, captured at require time.
// A developer machine or runner with it exported would defeat every
// license-gate assertion below, so strip it for the duration of the run.
if (IS_CLI) delete process.env.MAXION_FLEET_KEY;

// Captured before the gateway loads, so the "real state untouched" check can
// tell a pre-existing file apart from one this run wrote.

const SUITE_START = Date.now();
// Baseline the real files by their own mtime. Comparing against a module-load
// timestamp fires spuriously whenever a pre-existing file happens to be newer
// (clock skew, a recent legitimate edit, a concurrent writer).
const REAL_LICENSE = path.join(os.homedir(), '.maxion_licenses.json');
const REAL_VAULT   = path.join(os.homedir(), '.quezar_vault');
const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };
const REAL_LICENSE_MTIME = mtimeOf(REAL_LICENSE);
const REAL_VAULT_MTIME   = mtimeOf(REAL_VAULT);

const {
  handleCallTool,
  grantTrial,
  hasLicense,
  getLicenses,
  saveLicenses,
  engineAvailable,
  engineCandidates,
  resolveEngine,
  ENGINE_NAMES,
  EXE_SUFFIX,
  LICENSE_FILE,
  TOOLS,
} = require('./mcp_wrapper.js');

// A run killed mid-test may leave engine binaries stashed. Restoration merges
// back each file engines/ is missing, rather than bailing out whenever engines/
// merely exists, so a partially-recreated directory still gets topped up.
const ENGINES_DIR   = path.join(__dirname, 'engines');
// Beside engines/, not in os.tmpdir(): /tmp is frequently a separate mount
// (tmpfs, macOS $TMPDIR, containers) and renameSync across filesystems throws
// EXDEV. Per-PID, because a fixed host-wide path lets two concurrent runs
// silently clobber each other's binaries.
const ENGINES_STASH = path.join(__dirname, `.engines-stash-${process.pid}`);
const STASH_GLOB    = /^\.engines-stash-(\d+)$/;
// Only ever restore the three known engine filenames. Without this, anything
// dropped into a stash directory would be moved into engines/ at module load —
// and the deploy step zips engines/ straight into the Lambda package.
const STASHABLE = new Set(Object.values(ENGINE_NAMES).map(n => n + EXE_SUFFIX));

/**
 * @param stashDir      directory to restore from
 * @param authoritative true when this run created the stash. Our own stash holds
 *   the exact binaries we moved aside, so it wins over whatever is in engines/ —
 *   anything there now is a remnant (a partial `aws s3 sync`, a half-written
 *   file) and keeping it would resolve the wrong binary while orphaning the good
 *   one. A dead run's stash is NOT authoritative: engines/ may since have been
 *   re-fetched, and overwriting would regress to older binaries.
 */
function restoreFrom(stashDir, authoritative) {
  try {
    if (!fs.existsSync(stashDir)) return;
    fs.mkdirSync(ENGINES_DIR, { recursive: true });
    for (const f of fs.readdirSync(stashDir)) {
      if (!STASHABLE.has(f)) continue;               // refuse foreign files
      const dst = path.join(ENGINES_DIR, f);
      if (fs.existsSync(dst)) {
        if (!authoritative) continue;                // leave the newer file alone
        fs.rmSync(dst, { force: true });
      }
      fs.renameSync(path.join(stashDir, f), dst);
    }
    if (fs.readdirSync(stashDir).length === 0) fs.rmdirSync(stashDir);
  } catch (e) {
    // CI has a separate post-suite check that catches a bad restore; a local
    // `npm test` has no such guard, so a silently swallowed failure here would
    // leave the real binary stuck in the stash with the run reporting success.
    console.error(`[run_tests] failed to restore engine binaries from ${stashDir}:`, e.message);
  }
}

/** True when a process with this pid is still running. */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }       // signal 0 = existence check
  catch (e) { return e.code === 'EPERM'; }          // EPERM: alive, not ours
}

// On a long-lived host, PID reuse is guaranteed — treating "pid is alive" as
// permanent proof of ownership means a reused PID (trivially PID 1 / init,
// always alive) permanently strands a dead run's stash: the sweep skips it
// forever, and the suite quietly shifts to all-skip on engine-backed checks.
// A single test run has never taken remotely close to this long, so age is a
// second, independent signal: past it, reclaim regardless of pid liveness.
const STASH_STALE_MS = 10 * 60 * 1000;

function restoreStash() {
  restoreFrom(ENGINES_STASH, true);   // ours: authoritative

  // Foreign-stash healing is a local-dev convenience only: it exists so a
  // stash orphaned by a run you Ctrl-C'd yesterday doesn't sit there forever.
  // On CI that convenience is a liability instead. restoreFrom populates an
  // ABSENT destination unconditionally, authoritative or not — so on a runner
  // that reuses a workspace (self-hosted, or any future move off fresh-VM
  // GitHub-hosted runners), a stash left by a dead job on a different git ref
  // could populate this run's empty engines/ with stale binaries, and the
  // deploy preflight's `-s`/`-x` checks would accept them without noticing
  // they're wrong. GitHub-hosted `ubuntu-latest` runners are fresh VMs today,
  // so no stash can predate the current checkout — but skip the sweep
  // whenever CI is set (GitHub Actions sets it automatically) rather than
  // depend on that staying true.
  if (process.env.CI === 'true') return;

  // Heal stashes orphaned by runs that were killed outright — but only those.
  // Sweeping every matching directory would let a second concurrent run merge a
  // live run's in-flight stash back into engines/ mid-test, which is exactly the
  // clobbering the per-PID naming exists to prevent.
  try {
    for (const d of fs.readdirSync(__dirname)) {
      const m = STASH_GLOB.exec(d);
      if (!m) continue;
      const pid = Number(m[1]);
      const full = path.join(__dirname, d);
      const isStale = (() => {
        try { return Date.now() - fs.statSync(full).mtimeMs > STASH_STALE_MS; }
        catch { return false; }
      })();
      if (isStale) { restoreFrom(full, false); continue; }
      if (pid !== process.pid && pidAlive(pid)) continue;   // another run owns it
      restoreFrom(full, false);  // someone else's: defer
    }
  } catch {}
}
// These install process-level handlers and force host exit on error — CLI-run
// behavior only. A future importer (test runner, introspection tool) that
// require()s this file must not inherit exit-on-uncaught-exception semantics or
// have stale engine binaries silently resurrected into engines/.
if (IS_CLI) {
  restoreStash();                        // heal a previous abnormal exit
  process.on('exit', restoreStash);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(sig, () => { restoreStash(); process.exit(sig === 'SIGINT' ? 130 : 143); });
  }
  // Node terminates on these by default without running finally blocks.
  for (const ev of ['uncaughtException', 'unhandledRejection']) {
    process.on(ev, (e) => { restoreStash(); console.error(`[${ev}]`, e); process.exit(1); });
  }
}

const SEP  = '═'.repeat(60);
const SEP2 = '─'.repeat(60);

// ── Assertion framework ───────────────────────────────────────────────────
const stats = { pass: 0, fail: 0, skip: 0 };
const failures = [];
const skips = [];
let currentSuite = '(none)';

function banner(title) {
  console.log('\n' + SEP);
  console.log(`  ${title}`);
  console.log(SEP);
}

function section(label) {
  console.log('\n' + SEP2);
  console.log(`  ▶ ${label}`);
  console.log(SEP2);
}

function pass(label) {
  stats.pass++;
  console.log(`  ✅ PASS  ${label}`);
}

function fail(label, detail) {
  stats.fail++;
  failures.push({ suite: currentSuite, label, detail });
  console.log(`  ❌ FAIL  ${label}`);
  console.log(`           ${String(detail).split('\n').join('\n           ')}`);
}

// When MAXION_REQUIRE_ENGINES=1, a check skipped for want of an engine binary
// is a failure rather than a shrug. The deploy pipeline sets this so a release
// cannot ship with the engine, security, and vault surface unverified.
const REQUIRE_ENGINES = process.env.MAXION_REQUIRE_ENGINES === '1';

/**
 * Record a check that did not run.
 * `opts.engine` marks it as skipped because an engine binary was missing —
 * those are the ones REQUIRE_ENGINES promotes to failures. Skips for other
 * reasons (e.g. no lineage0 license) are never promoted.
 */
function skip(label, reason, opts = {}) {
  if (opts.engine && REQUIRE_ENGINES) {
    fail(label, `${reason} (MAXION_REQUIRE_ENGINES=1 — engine coverage is required)`);
    return;
  }
  stats.skip++;
  skips.push({ suite: currentSuite, label, reason });
  console.log(`  ⏭️  SKIP  ${label}`);
  console.log(`           ${reason}`);
}

/** Assert a condition holds. */
function check(label, condition, detail) {
  if (condition) pass(label);
  else fail(label, detail || 'condition was false');
}

/** Assert `text` contains `needle`. */
function checkContains(label, text, needle) {
  if (typeof text === 'string' && text.includes(needle)) pass(label);
  else fail(label, `expected output to contain ${JSON.stringify(needle)}\ngot: ${truncate(text)}`);
}

/**
 * A binary that resolves and is executable can still be the wrong architecture
 * or a corrupted download. engineAvailable() cannot tell — it only stats the
 * file — so the suite takes the success-expecting branch and the failure reads
 * like a test bug. Recognise the signature and name the real cause.
 */
function brokenEngineHint(text) {
  return /Engine for \S+ (exited|failed to start|returned malformed output)/.test(text)
    ? '\n           ^ the engine binary resolved but could not run: likely a corrupted ' +
      'download or a build for the wrong architecture. Check engines/ and the server log.'
    : '';
}

/** Assert the call did not return an error result. */
function checkOk(label, res) {
  if (res.isError) {
    fail(label, `tool returned an error: ${truncate(res.text)}${brokenEngineHint(res.text)}`);
    return false;
  }
  pass(label);
  return true;
}

/** Assert the call DID return an error (for negative tests). */
function checkIsError(label, res, needle) {
  if (!res.isError) {
    fail(label, `expected an error result, got success: ${truncate(res.text)}`);
    return false;
  }
  if (needle && !res.text.includes(needle)) {
    fail(label, `error did not mention ${JSON.stringify(needle)}\ngot: ${truncate(res.text)}`);
    return false;
  }
  pass(label);
  return true;
}

function truncate(s, n = 300) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + ' …' : str;
}

/**
 * Invoke a tool. Returns { text, isError } — errors are surfaced as a flag,
 * never flattened into an indistinguishable string.
 */
async function call(name, args = {}) {
  try {
    const r = await handleCallTool({ params: { name, arguments: args } });
    return {
      text: r.content?.[0]?.text ?? '',
      isError: !!r.isError,
    };
  } catch (e) {
    return { text: `threw: ${e.message}`, isError: true };
  }
}

async function ensureLicensed(tool) {
  if (!hasLicense(tool)) grantTrial(tool);
}

/** Run a suite body, catching an unexpected throw as a failure rather than a crash. */
async function suite(name, fn) {
  currentSuite = name;
  try {
    await fn();
  } catch (e) {
    fail(`${name} — suite aborted`, e.stack || e.message);
  }
}

// ──────────────────────────────────────────────────────────
// TEST 1 — MAXION V16
// ──────────────────────────────────────────────────────────
async function testMaxion() {
  banner('TEST 1 — MAXION V16  (hardware telemetry + stress benchmark)');
  await ensureLicensed('maxion');

  const haveEngine = engineAvailable('maxion-app');

  section('Activate');
  const act = await call('engine.maxion.activate', { duration_minutes: 0.5 });
  if (!haveEngine) {
    checkIsError('activate reports the engine is unavailable', act, 'Engine binary not found');
    check('activate does not claim cooling is engaged',
      !/cooling|Thermal degradation prevented/i.test(act.text),
      `activate claimed a thermal effect with no engine running:\n${truncate(act.text)}`);
  } else if (checkOk('activate succeeds', act)) {
    checkContains('activate reports engine ACTIVE', act.text, 'ACTIVE');
  }

  section('Deactivate');
  // The engine implements get_telemetry and run_benchmark only — there is no
  // deactivate command — so this must refuse whether or not a binary is present.
  const deact = await call('engine.maxion.deactivate');
  checkIsError('deactivate reports it is not implemented', deact, 'not implemented');
  check('deactivate never claims a power state changed',
    !/cooling protocols suspended|Power state reduced|OFFLINE/i.test(deact.text),
    `deactivate claimed an effect it cannot produce:\n${truncate(deact.text)}`);

  section('Live telemetry');
  const tel = await call('engine.maxion.status');
  if (!haveEngine) {
    checkIsError('status reports the engine is unavailable', tel, 'Engine binary not found');
    skip('telemetry values', 'maxion-app binary not built — no telemetry to verify', { engine: true });
  } else if (checkOk('status succeeds', tel)) {
    checkContains('telemetry includes CPU', tel.text, 'CPU:');
    checkContains('telemetry includes memory', tel.text, 'Memory:');
  }

  section('Diagnostics — prime-sieve stress benchmark');
  if (!haveEngine) {
    const diag = await call('engine.maxion.diagnostics', { deep_scan: true });
    checkIsError('diagnostics reports the engine is unavailable', diag, 'Engine binary not found');
    skip('benchmark thermal figures', 'maxion-app binary not built — no benchmark was run', { engine: true });
  } else {
    console.log('  (Running... ~30 seconds)');
    const t0 = Date.now();
    const diag = await call('engine.maxion.diagnostics', { deep_scan: true });
    console.log(`  Elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (checkOk('diagnostics succeeds', diag)) {
      checkContains('benchmark reports throughput', diag.text, 'primes/sec');
      checkContains('benchmark states its methodology', diag.text, 'Methodology:');
    }
  }
}

// ──────────────────────────────────────────────────────────
// TEST 2 — DIAMONIZE LSA
// ──────────────────────────────────────────────────────────
async function testDiamonize() {
  banner('TEST 2 — DIAMONIZE LSA  (zero-trust security engine)');
  await ensureLicensed('diamonize');

  const haveEngine = engineAvailable('diamonize-app');

  section('Scan — EICAR test signature (must be detected)');
  // Write EICAR to a real file. The tool contract says `target` is a path, and
  // passing the signature string inline made the engine fall through to a
  // SYSTEM_MEMORY sweep — which reports its own compiled-in signature table as
  // threats. The old assertion matched those self-detections, so it passed
  // without ever scanning EICAR.
  const eicarPath = path.join(TEST_STATE_DIR, 'eicar.txt');
  fs.writeFileSync(eicarPath,
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
  const eicar = await call('security.diamonize.scan', { target: eicarPath });
  if (!haveEngine) {
    checkIsError('scan reports the engine is unavailable', eicar, 'Engine binary not found');
    skip('EICAR detection', 'diamonize-app binary not built — no scanner to exercise', { engine: true });
  } else if (checkOk('EICAR scan succeeds', eicar)) {
    check('scan targeted the file, not a memory sweep',
      eicar.text.includes(eicarPath) && !/SYSTEM_MEMORY/.test(eicar.text),
      `scan did not read the given path — a fallback sweep cannot demonstrate ` +
      `EICAR detection:\n${truncate(eicar.text)}`);
    if (/FILE READ ERROR/i.test(eicar.text)) {
      skip('EICAR signature is flagged as a threat',
        'host antivirus (e.g. Windows Defender) intercepted and locked the EICAR test string on disk before Diamonize could read it');
    } else {
      checkContains('EICAR scan returns a SHA-256', eicar.text, 'SHA256:');
      check('EICAR signature is flagged as a threat',
        /EICAR/i.test(eicar.text) && /THREAT/i.test(eicar.text),
        `scanner did not flag the EICAR test string — a scanner that misses EICAR ` +
        `is not working:\n${truncate(eicar.text)}`);
    }

    // Control: without this, "always reports a threat" would pass the above.
    const cleanPath = path.join(TEST_STATE_DIR, 'clean.txt');
    fs.writeFileSync(cleanPath, 'ordinary log line, nothing of interest\n');
    const clean = await call('security.diamonize.scan', { target: cleanPath });
    if (checkOk('clean-file scan succeeds', clean)) {
      check('a clean file is reported CLEAN',
        /CLEAN/i.test(clean.text) && !/THREAT/i.test(clean.text),
        `scanner flagged a benign file — detection is not discriminating:\n${truncate(clean.text)}`);
    }
  }

  section('Scan — SYSTEM_MEMORY sweep');
  const mem = await call('security.diamonize.scan', { target: 'SYSTEM_MEMORY' });
  if (!haveEngine) {
    checkIsError('memory scan reports the engine is unavailable', mem, 'Engine binary not found');
  } else if (checkOk('memory scan succeeds', mem)) {
    checkContains('memory scan reports bytes scanned', mem.text, 'Bytes scanned:');
  }

  section('Scan — nonexistent path must error, not fall back to memory');
  // The engine's scan_target treats anything that is neither a file nor a
  // directory as SYSTEM_MEMORY — including a typo'd path. Without a guard, a
  // caller asking about one file silently gets a verdict about system memory
  // instead, reported as success. This must be caught before the engine ever
  // sees the target, so it applies regardless of engine availability.
  const typo = await call('security.diamonize.scan', { target: '/definitely/does/not/exist/' + Date.now() });
  checkIsError('nonexistent target is rejected', typo, 'Target not found');
  // Check for scan-result markers, not the word SYSTEM_MEMORY — the rejection
  // message itself names that fallback path when explaining why it refused.
  check('rejection does not silently report on system memory',
    !/Scan Complete on|Bytes scanned:|Patterns checked:/i.test(typo.text),
    `a nonexistent target produced a scan result instead of an error:\n${truncate(typo.text)}`);

  section('Quarantine');
  // Nonexistent target is rejected
  const typoQ = await call('security.diamonize.quarantine', { target: 'EICAR_Test_Payload_Nonexistent' });
  checkIsError('quarantine on nonexistent target is rejected', typoQ, 'Target file not found');

  // Real threat file quarantine
  const qSamplePath = path.join(TEST_STATE_DIR, 'threat_to_quarantine.ps1');
  fs.writeFileSync(qSamplePath, 'vssadmin delete shadows /all /quiet\n');
  const qReal = await call('security.diamonize.quarantine', { target: qSamplePath, reason: 'Ransomware.ShadowCopyDeletion' });
  if (checkOk('quarantine on real threat file succeeds', qReal)) {
    checkContains('quarantine returns a Quarantine ID', qReal.text, 'Quarantine ID: QVAL-');
    checkContains('quarantine confirms payload status is neutralized', qReal.text, 'NEUTRALIZED');
    check('original threat file is removed from disk', !fs.existsSync(qSamplePath), 'original threat file still exists on disk');
  }

  section('Shield status');
  const st = await call('security.diamonize.status');
  if (checkOk('status succeeds', st)) {
    checkContains('status reports zero-trust posture', st.text, 'ZERO-TRUST');
    checkContains('status reports quarantine vault state', st.text, 'Quarantine Vault:');
    checkContains('status reports threat audit log state', st.text, 'Threat Audit Log:');
  }

  section('Threat logs');
  const logs = await call('security.diamonize.logs', { count: 10 });
  if (checkOk('logs call succeeds', logs)) {
    checkContains('logs return audit entries', logs.text, 'Threat Audit Logs');
    checkContains('logs record quarantine event', logs.text, 'EVENT: QUARANTINE');
  }
}

// ──────────────────────────────────────────────────────────
// TEST 3 — QUEZAR VAULT
// ──────────────────────────────────────────────────────────
async function testQuezar() {
  banner('TEST 3 — QUEZAR VAULT  (AES-256-GCM encrypt / compress / retrieve)');
  await ensureLicensed('quezar');

  const haveEngine = engineAvailable('quezar-app');

  const testPayload = `QUEZAR REAL TEST PAYLOAD — ${new Date().toISOString()}\n` +
    'The quick brown fox jumps over the lazy dog. '.repeat(200);

  section(`Store — ${(testPayload.length / 1024).toFixed(1)} KB payload`);
  const store = await call('storage.quezar.store', { payload: testPayload });

  if (!haveEngine) {
    checkIsError('store reports the engine is unavailable', store, 'Engine binary not found');
    skip('round-trip data integrity', 'quezar-app binary not built — nothing was stored to retrieve', { engine: true });
    skip('delete', 'quezar-app binary not built — nothing was stored to delete', { engine: true });
  } else if (checkOk('store succeeds', store)) {
    // The engine emits "<base64>:<base64>" with no "quezar:" prefix — matching
    // on that prefix silently found nothing and reported a missing key.
    const vaultKey = store.text.match(/Vault Key: (\S+)/)?.[1];
    check('store returns a vault key', !!vaultKey, `no "Vault Key:" in output:\n${truncate(store.text)}`);

    if (vaultKey) {
      section(`Retrieve — decrypt and verify "${vaultKey}"`);
      const got = await call('storage.quezar.retrieve', { Vault_id: vaultKey });
      if (checkOk('retrieve succeeds', got)) {
        // The point of the vault: what comes out must equal what went in.
        check('round-trip data integrity — retrieved payload matches original',
          got.text.includes(testPayload.slice(0, 200)),
          `decrypted payload does not match what was stored\ngot: ${truncate(got.text)}`);
      }

      section('Retrieve must fail closed, never fabricate content');
      // VaultRetrieve previously fell back to decoding the raw ciphertext
      // bytes as if they were plaintext (or the literal "decrypted_content")
      // whenever the engine failed — a success envelope containing content
      // that was never actually decrypted. Corrupt the stored file so the
      // engine genuinely cannot decrypt it, and assert the tool refuses
      // rather than returning something that looks like an answer.
      {
        const vaultFile = path.join(TEST_STATE_DIR, 'vault',
          vaultKey.replace(/:/g, '_').replace(/\//g, '-').replace(/\+/g, '.') + '.enc');
        const original = fs.readFileSync(vaultFile, 'utf8');
        fs.writeFileSync(vaultFile, Buffer.from('NOT REAL CIPHERTEXT — fabrication regression probe').toString('base64'));
        const corrupted = await call('storage.quezar.retrieve', { Vault_id: vaultKey });
        checkIsError('retrieve on undecryptable data refuses rather than fabricating', corrupted);
        check('refusal does not echo the corrupted bytes back as content',
          !/fabrication regression probe|decrypted_content/i.test(corrupted.text),
          `retrieve returned attacker/corruption-controlled bytes as if decrypted:\n${truncate(corrupted.text)}`);
        fs.writeFileSync(vaultFile, original);   // restore for delete below
      }

      section(`Delete — purge "${vaultKey}"`);
      const del = await call('storage.quezar.delete', { Vault_id: vaultKey });
      checkOk('delete succeeds', del);

      const after = await call('storage.quezar.list');
      check('deleted key no longer listed',
        !after.text.includes(vaultKey),
        `vault still lists ${vaultKey} after delete:\n${truncate(after.text)}`);
    }
  }

  section('List / status (vault bookkeeping — no engine required)');
  const list = await call('storage.quezar.list');
  if (checkOk('list succeeds', list)) {
    checkContains('list reports sector count', list.text, 'Active sectors');
  }
  const vst = await call('storage.quezar.status');
  if (checkOk('status succeeds', vst)) {
    checkContains('status reports encryption mode', vst.text, 'AES-256-GCM');
  }
}

// ──────────────────────────────────────────────────────────
// TEST 3b — HMAC VAULT (go_green_suite)
// ──────────────────────────────────────────────────────────
async function testHmacVault() {
  banner('TEST 3b — HMAC VAULT  (HMAC-SHA256 verification via go_green_suite)');

  const haveEngine = engineAvailable('hmac-vault-app');
  const savedKey = process.env.MAXION_DEPLOY_KEY;

  section('License gate — vault.hmac bills under the quezar namespace');
  // Asserted before any trial is granted below: NS_LICENSE has no 'vault.*'
  // key of its own, so a mapping regression here would silently un-gate the
  // tool rather than fail loudly.
  {
    const saved = getLicenses();
    saveLicenses({});
    const unlicensed = await call('vault.hmac.verify', { payload: 'x' });
    checkIsError('unlicensed verify is refused', unlicensed, 'UNAUTHORIZED');
    checkContains('refusal names the quezar license, not a nonexistent "vault" one',
      unlicensed.text, "tool_name='quezar'");
    saveLicenses(saved);
  }

  await ensureLicensed('quezar');

  section('No MAXION_DEPLOY_KEY — must refuse, never verify insecurely');
  delete process.env.MAXION_DEPLOY_KEY;
  const noKey = await call('vault.hmac.verify', { payload: 'anything', hash: 'x'.repeat(64) });
  checkIsError('verify refuses when no deploy key is configured', noKey, 'MAXION_DEPLOY_KEY');
  check('refusal does not claim a successful verification',
    !/HMAC MATCH/.test(noKey.text),
    `refusal reported a match:\n${truncate(noKey.text)}`);

  process.env.MAXION_DEPLOY_KEY = 'run-tests-deploy-key';

  section('With a deploy key — real verification');
  const DEPLOY_KEY = 'run-tests-deploy-key';
  const payload = 'test payload';
  const goodHash = require('crypto').createHmac('sha256', DEPLOY_KEY).update(payload, 'utf8').digest('hex');
  const wrongHash = require('crypto').createHmac('sha256', 'a-different-key').update(payload, 'utf8').digest('hex');

  if (!haveEngine) {
    const res = await call('vault.hmac.verify', { payload, hash: goodHash });
    checkIsError('verify reports the engine is unavailable', res, 'Engine binary not found');
    skip('HMAC match on a correctly signed payload', 'go_green_suite binary not built', { engine: true });
    skip('HMAC mismatch on a wrongly signed payload', 'go_green_suite binary not built', { engine: true });
    skip('no durable-storage claim in output', 'go_green_suite binary not built', { engine: true });
  } else {
    // The failure mode must be reachable through the tool's own schema. This
    // handler previously derived the hash from the payload with the same key
    // the engine verifies against, so it compared the deploy secret to itself:
    // every input returned "HMAC MATCH", and no argument could ever produce a
    // mismatch. A verifier whose negative case is unreachable verifies nothing.
    const bad = await call('vault.hmac.verify', { payload, hash: wrongHash });
    checkIsError('a hash signed with the wrong key is rejected', bad);
    checkContains('rejection says the signature did not match', bad.text, 'HMAC MISMATCH');
    check('rejection does not also claim a match', !/HMAC MATCH/.test(bad.text),
      `both outcomes reported at once:\n${truncate(bad.text)}`);

    const tampered = await call('vault.hmac.verify', { payload: payload + ' tampered', hash: goodHash });
    checkIsError('a valid hash for different content is rejected', tampered, 'HMAC MISMATCH');

    // Confirmed against the real engine directly: it compares hex strings
    // with exact byte/case equality, so an uppercase-but-correct hash was
    // rejected as a MISMATCH -- a caller who naturally produced uppercase hex
    // (common in the wild) would be told to debug the secret or payload for
    // what was actually a case mismatch. Gateway normalizes before
    // forwarding; these confirm both the normalization and that malformed
    // input gets a distinct error rather than being sent to the engine at all.
    const upperCase = await call('vault.hmac.verify', { payload, hash: goodHash.toUpperCase() });
    checkOk('an uppercase-but-correct hash still verifies', upperCase);
    checkContains('uppercase hash reports a real match, not a mismatch', upperCase.text, 'HMAC MATCH');

    const mixedCase = await call('vault.hmac.verify', { payload, hash: goodHash.slice(0, 32).toUpperCase() + goodHash.slice(32) });
    checkOk('a mixed-case-but-correct hash still verifies', mixedCase);

    const tooShort = await call('vault.hmac.verify', { payload, hash: 'abc123' });
    checkIsError('a malformed (too-short) hash is refused before reaching the engine', tooShort, 'Invalid hash format');

    const badChars = await call('vault.hmac.verify', { payload, hash: 'z'.repeat(64) });
    checkIsError('a malformed (non-hex) hash is refused with a distinct message', badChars, 'Invalid hash format');
    check('malformed-hash error is distinguishable from a real mismatch',
      !/HMAC MISMATCH/.test(badChars.text),
      `encoding error read as a signature failure:\n${truncate(badChars.text)}`);

    // This block, together with the wrong-key and tampered-content checks
    // above, pins go_green_suite's real wire contract — not just this
    // handler's own output. mcp_wrapper.js classifies a match on the engine's
    // structured `verified: true|false` field (ENGINE_RESPONSE_FIELDS
    // requires it, so a build that stops emitting it fails closed via
    // validateEngineResponse rather than falling back to guessing from
    // prose). This suite is black-box by design (file header: MCP tool calls
    // only, no internal engine logic referenced) so it cannot assert on the
    // raw field directly — but if the engine ever stopped setting `verified`
    // correctly, 'verify succeeds on a correctly signed payload' below would
    // fail. That failure is the pin: a real signature would read as a
    // forgery, caught here instead of by a caller. Only exercised when the
    // engine is actually present, which is exactly this branch.
    const res = await call('vault.hmac.verify', { payload, hash: goodHash });
    if (checkOk('verify succeeds on a correctly signed payload', res)) {
      checkContains('reports an HMAC match', res.text, 'HMAC MATCH');
      // The engine's own success string says the payload was "ingested into
      // secured memory state". invokeRustEngine spawns a fresh process per
      // call, so that buffer is gone the moment the call returns — surfacing
      // that wording to a caller would promise storage this tool does not
      // provide. Assert the gateway states the opposite, explicitly.
      check('output does not claim the payload was retained',
        !/ingested into secured memory state/i.test(res.text) && /Nothing was retained/i.test(res.text),
        `output implies durable storage:\n${truncate(res.text)}`);
    }
  }

  if (savedKey === undefined) delete process.env.MAXION_DEPLOY_KEY;
  else process.env.MAXION_DEPLOY_KEY = savedKey;

  section('Classifier is not fooled by a stub engine (runs with no real binary)');
  // Direct reproduction of a real reviewed finding, not the real engine: a
  // fake binary whose 'result' string starts with "VERIFIED" but never
  // actually checked anything. The old classifier (/^VERIFIED/.test(result))
  // would have accepted this — a silent authentication bypass, since any
  // engine build emitting a prefix match passed regardless of what it
  // checked. Runs unconditionally, independent of go_green_suite being
  // built, so it exercises on every PR rather than only once ENGINES_S3_URI
  // is populated.
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'maxion-hmac-stub-'));
    const prevDir = process.env.MAXION_ENGINE_DIR;
    const prevKey = process.env.MAXION_DEPLOY_KEY;
    try {
      // On Windows the engine filename ends with .exe, so a bash script
      // cannot work — it would be named go_green_suite.exe and Windows
      // would try to run it as a PE binary. Use a Node.js helper script
      // instead: write a .js file and a tiny .cmd/.sh wrapper that
      // invokes it with `node`. This is cross-platform.
      const stubJs = path.join(d, 'go_green_suite_stub.js');
      const stubBin = path.join(d, 'go_green_suite' + EXE_SUFFIX);
      const writeStub = (jsonLine) => {
        if (process.platform === 'win32') {
          const csFile = path.join(d, 'stub.cs');
          const escaped = jsonLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          fs.writeFileSync(csFile,
            `using System; class P { static void Main() { Console.Write("${escaped}"); } }`);
          cp.spawnSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
            ['/nologo', '/out:' + stubBin, csFile]);
        } else {
          fs.writeFileSync(stubJs,
            `process.stdin.resume();` +
            `process.stdin.on('end',()=>{` +
            `process.stdout.write(JSON.stringify(${jsonLine}));` +
            `process.exit(0);});`);
          fs.writeFileSync(stubBin,
            `#!/bin/sh\nnode "${stubJs}" "$@"\n`);
          fs.chmodSync(stubBin, 0o755);
        }
      };

      // Stub 1: verified:false — prefix-match regression probe
      writeStub('{"jsonrpc":"2.0","result":"VERIFIED_STUB - no real check performed","verified":false,"id":1}');
      process.env.MAXION_ENGINE_DIR = d;
      process.env.MAXION_DEPLOY_KEY = 'stub-test-key';

      // On Windows, a .cmd file named .exe does not execute through
      // spawnSync without shell:true (which invokeRustEngine does not
      // use). The first stub test happened to pass because
      // "Engine binary not found" is still isError, but the intent is to
      // test the classifier against a running stub — only valid when the
      // stub can actually execute.
      if (resolveEngine('hmac-vault-app')) {
        const stubbed = await call('vault.hmac.verify', { payload: 'x', hash: 'a'.repeat(64) });
        checkIsError('a stub whose text starts with VERIFIED but verified:false is rejected', stubbed);
        check('rejection is not fooled by the VERIFIED-prefixed text',
          !/^\[HMAC VAULT\] HMAC MATCH/.test(stubbed.text),
          `stub's prefixed wording was accepted as a match:\n${truncate(stubbed.text)}`);

        // The complementary case: a build that stops emitting `verified`
        // entirely must fail closed via ENGINE_RESPONSE_FIELDS, not silently
        // fall back to parsing `result`.
        writeStub('{"jsonrpc":"2.0","result":"VERIFIED: totally legit","id":1}');
        const noField = await call('vault.hmac.verify', { payload: 'x', hash: 'a'.repeat(64) });
        checkIsError('a response missing the verified field is refused', noField, 'missing verified');
      } else {
        skip('a stub whose text starts with VERIFIED but verified:false is rejected',
          `stub engine cannot execute on ${process.platform} (engine path did not resolve) — ` +
          `this check exercises the classifier against a running fake binary, which requires ` +
          `a platform-native executable`, { engine: true });
        skip('a response missing the verified field is refused',
          `stub engine cannot execute on ${process.platform} — see above`, { engine: true });
      }
    } finally {
      if (prevDir === undefined) delete process.env.MAXION_ENGINE_DIR;
      else process.env.MAXION_ENGINE_DIR = prevDir;
      if (prevKey === undefined) delete process.env.MAXION_DEPLOY_KEY;
      else process.env.MAXION_DEPLOY_KEY = prevKey;
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
}

// ──────────────────────────────────────────────────────────
// TEST 4 — LINEAGE.0 VC (status only — no generation charge)
// ──────────────────────────────────────────────────────────
async function testLineage() {
  banner('TEST 4 — LINEAGE.0 VC  (cluster status + S3 archive)');

  // lineage0 has no free trial; unlicensed is the expected default state.
  const licensed = hasLicense('lineage0');

  section('Nova cluster status');
  const st = await call('media.lineage0.status');
  if (!licensed) {
    checkIsError('unlicensed status call is refused', st, 'UNAUTHORIZED');
    skip('cluster reachability', 'no lineage0 license — cannot exercise AWS connectivity');
  } else if (checkOk('status succeeds', st)) {
    check('status returns content', st.text.length > 0, 'empty response');
  }

  section('S3 archive');
  const ar = await call('media.lineage0.archive');
  if (!licensed) {
    checkIsError('unlicensed archive call is refused', ar, 'UNAUTHORIZED');
  } else {
    checkOk('archive succeeds', ar);
  }
}

// ──────────────────────────────────────────────────────────
// TEST 5 — GATEWAY / LICENSE GATE
// ──────────────────────────────────────────────────────────
async function testGateway() {
  banner('TEST 5 — GATEWAY  (health + license gate)');

  section('billing.purchase — rejects a tool_name with no billable product');
  {
    // inputSchema declares an enum for tool_name, but the MCP SDK does not
    // enforce it -- any string reaches the handler. "vault" is a realistic
    // guess (NS_LICENSE maps the vault.hmac namespace to a "quezar" license,
    // but "vault" itself is not a billable product) rather than an arbitrary
    // fuzz string.
    const trial = await call('billing.purchase', { tool_name: 'vault', duration: 'trial' });
    checkIsError('an unmappable tool_name is refused on the trial path', trial);
    check('refusal does not leak grantTrial\'s internal error text',
      !/grantTrial|hasLicense\(\) would never read/.test(trial.text),
      `internal error text reached the MCP client:\n${truncate(trial.text)}`);

    const hourly = await call('billing.purchase', { tool_name: 'vault', duration: 'hourly' });
    checkIsError('an unmappable tool_name is refused on the paid path, not handed a dead checkout link', hourly);
    check('no checkout URL for a nonexistent product was returned',
      !/gumroad\.com\/l\/vault/.test(hourly.text),
      `handed out a checkout link for a product that doesn't exist:\n${truncate(hourly.text)}`);
  }

  section('billing.activate — permalink handling');
  {
    const savedFetch = global.fetch;
    const savedLic = getLicenses();
    // Stub the Gumroad call: these assertions are about what the gateway does
    // with a permalink once the key has been accepted, not about Gumroad.
    global.fetch = async () => ({ json: async () => ({ success: true }) });
    try {
      // Gumroad validated the key for this product, so a permalink differing
      // only in case is a real purchase. Refusing it would turn a paying
      // customer away over capitalization.
      const cased = await call('billing.activate', { product_permalink: 'Maxion-hourly', license_key: 'k' });
      if (checkOk('a case-variant permalink still activates', cased)) {
        checkContains('activates under the lowercased namespace', cased.text, 'for maxion');
      }

      // Reachable by an ordinary typo — the real product is lineage0-video.
      const typo = await call('billing.activate', { product_permalink: 'lineage-video', license_key: 'k' });
      checkIsError('an unmappable permalink is refused', typo);
      check('refusal is written for the caller, not an internal write failure',
        /not a product this gateway licenses/.test(typo.text),
        `expected an actionable message, got:\n${truncate(typo.text)}`);
      check('refusal does not leak internal function names or the allowlist verbatim',
        !/grantLicense|refusing to write license key/.test(typo.text),
        `internal error text reached the MCP client:\n${truncate(typo.text)}`);
    } finally {
      global.fetch = savedFetch;
      saveLicenses(savedLic);
    }
  }

  section('billing.purchase — lineage0 duration must match the hosted Lambda\'s real 5 tiers');
  {
    // The hosted Lambda's GUMROAD_PRODUCTS.lineage0 and media_lineage0_generate
    // inputSchema only accept 6/12/30/60/120. This used to accept any multiple
    // of 6 up to 120 (20 values) -- a customer who paid Gumroad for one of the
    // other 15 (e.g. duration='18') would get a real license key that the
    // hosted gateway then rejects with "No Gumroad product configured",
    // already-paid and stuck at support. Assert both that the 5 real tiers
    // still work and that an out-of-set value is refused before ever hitting
    // Gumroad (no checkout link for a duration the hosted side can't serve).
    for (const secs of ['6', '12', '30', '60', '120']) {
      const res = await call('billing.purchase', { tool_name: 'lineage0', duration: secs });
      checkOk(`duration='${secs}' is accepted`, res);
    }
    const rejected = await call('billing.purchase', { tool_name: 'lineage0', duration: '18' });
    checkIsError('duration=\'18\' (not one of the 5 real tiers) is refused', rejected);
    check('the rejection does not hand out a checkout link for an unservable duration',
      !/gumroad\.com\/l\/lineage0/.test(rejected.text),
      `handed out a checkout link for a duration the hosted gateway can't serve:\n${truncate(rejected.text)}`);
    check('the pricing message only lists the 5 real tiers, not "18, 24... up to 120"',
      !/18, 24/.test(rejected.text),
      `pricing message still advertises durations the hosted gateway rejects:\n${truncate(rejected.text)}`);
  }

  section('gateway.status');
  const gw = await call('gateway.status');
  if (checkOk('gateway.status succeeds', gw)) {
    checkContains('reports gateway online', gw.text, 'ONLINE');
    checkContains('lists module licenses', gw.text, 'Module Licenses');

    // The "Tools: N endpoints active" line is meant to read TOOLS.length
    // directly rather than carry its own hardcoded number -- this asserts
    // that's actually true, rather than trusting the comment next to it. A
    // manual count already drifted twice this way: README/package.json/
    // server-card.json all said 19, then 20, while the array was 22 the
    // whole time -- gateway.restart and gateway.agent_instructions were
    // never in anyone's count, including a prior pass through this exact
    // file. If gateway.status's text ever goes back to a literal number,
    // this catches it the moment TOOLS grows again.
    checkContains(`reports the true tool count (${TOOLS.length}), not a stale literal`,
      gw.text, `Tools: ${TOOLS.length} endpoints active.`);
  }

  section('Unknown tool is rejected');
  const bogus = await call('does.not.exist');
  checkIsError('unknown tool returns an error', bogus, 'Unknown tool');

  section('Test run does not touch real license/vault state');
  // Guards the isolation set up at the top of this file. Without it, a local
  // `npm test` permanently burns the developer's free trials.
  check('license writes are redirected away from $HOME',
    LICENSE_FILE.startsWith(TEST_STATE_DIR),
    `gateway is writing licenses to ${LICENSE_FILE} — expected a path under ${TEST_STATE_DIR}`);
  check('real ~/.maxion_licenses.json is untouched by this run',
    mtimeOf(REAL_LICENSE) === REAL_LICENSE_MTIME,
    `${REAL_LICENSE} was modified during the test run`);
  check('real ~/.quezar_vault is untouched by this run',
    mtimeOf(REAL_VAULT) === REAL_VAULT_MTIME,
    `${REAL_VAULT} was modified during the test run`);

  section('Unlicensed engine call is refused by the middleware');
  // engine.maxion.activate is gated: an unlicensed caller is rejected before
  // the handler runs, so it cannot grant itself a trial. Trials come from
  // billing.purchase.
  const licSnapshot = getLicenses();
  try {
    const stripped = { ...licSnapshot };
    for (const k of ['maxion', 'maxion_trial_used']) delete stripped[k];
    saveLicenses(stripped);
    const unlic = await call('engine.maxion.activate', { duration_minutes: 30 });
    checkIsError('unlicensed activate returns UNAUTHORIZED', unlic, 'UNAUTHORIZED');
    check('unlicensed activate does not self-grant a license',
      !hasLicense('maxion'),
      'activate granted itself a license despite being gated');
  } finally {
    saveLicenses(licSnapshot);
  }

  section('Trial grant lands under the key the license gate reads');
  // Regression: the trial was written under "engine.maxion" while NS_LICENSE
  // maps engine.maxion -> "maxion", so the grant was invisible to hasLicense().
  // This drives the real handler end-to-end. Asserting on a direct
  // grantTrial('maxion') round-trip instead would pass no matter what the
  // handler writes — that is not a regression test.
  //
  // billing.purchase is the path that issues trials: it is ungated, whereas
  // every engine.*/security.*/storage.* handler sits behind the authorization
  // middleware and is rejected before it could grant anything to itself.
  const licBefore = getLicenses();
  try {
    const cleared = { ...licBefore };
    for (const k of ['maxion', 'maxion_trial_used', 'engine.maxion', 'engine.maxion_trial_used']) {
      delete cleared[k];
    }
    saveLicenses(cleared);
    check('precondition: no maxion license before purchase', !hasLicense('maxion'),
      'could not clear the maxion license — the assertion below would be vacuous');

    const trial = await call('billing.purchase', { tool_name: 'maxion', duration: 'trial' });
    checkOk('billing.purchase issues a trial', trial);
    check('granted trial is visible to the license gate',
      hasLicense('maxion'),
      'trial was granted but hasLicense("maxion") is false — the trial key does not match the key the gate reads');

    // The gate must actually honour it: a licensed namespace call should get
    // past the middleware rather than come back UNAUTHORIZED.
    const gated = await call('engine.maxion.status');
    check('licensed call is no longer rejected as UNAUTHORIZED',
      !gated.text.includes('UNAUTHORIZED'),
      `middleware still refused a licensed call: ${truncate(gated.text)}`);

    // Drive the handler that carried the original bug. Asserting only on
    // billing.purchase's side effects would pass no matter what activate
    // writes, so run activate itself — licensed, so the middleware lets it
    // through — and assert it writes nothing under the wrong namespace.
    // Static guard — runs everywhere, including engine-less PR CI.
    //
    // The behavioural check below needs an engine (activate short-circuits on a
    // missing binary before any license write), so on the PR gate it skips —
    // which is exactly how the original bug would slip back in behind a green
    // tick. This reads the source instead: every literal key passed to
    // grantTrial/grantLicense must be one the license gate actually reads.
    // `grantTrial("engine.maxion")` — the original bug — fails here with no
    // engine present.
    {
      const src = fs.readFileSync(path.join(__dirname, 'mcp_wrapper.js'), 'utf8');
      const NS_KEYS = new Set(['maxion', 'diamonize', 'quezar', 'lineage0']);
      const literals = [...src.matchAll(/grant(?:Trial|License)\(\s*['"]([^'"]+)['"]/g)]
        .map(m => m[1]);
      const bad = literals.filter(k => !NS_KEYS.has(k));
      check('every literal license key matches one the gate reads',
        bad.length === 0,
        `grantTrial/grantLicense called with ${bad.map(k => JSON.stringify(k)).join(', ')} — ` +
        `the gate reads only ${[...NS_KEYS].join(', ')}, so such a grant is written ` +
        `and never read. That is the original trial-key bug.`);
    }

    // The scan above only sees quoted literals, and both production callsites
    // pass variables — grantTrial(tool_name), grantLicense(data.tool_name, ...)
    // — so it inspects nothing where the bug would actually land. Worse,
    // billing.activate derives tool_name from a caller-supplied
    // product_permalink (split on '-'), a value no static check can know.
    // grantTrial/grantLicense therefore assert at the write; verify that guard
    // is live, including for the shapes the regex cannot see.
    {
      const shapes = {
        'plain literal':         'engine.maxion',
        'template-built key':    `engine.${'maxion'}`,
        'concat-built key':      'maxion' + '.engine',
        'permalink-derived key': 'hmacvault-monthly'.split('-')[0],
      };
      for (const [label, key] of Object.entries(shapes)) {
        let threw = false;
        try { grantTrial(key); } catch { threw = true; }
        check(`grantTrial refuses a ${label} the gate never reads`, threw,
          `grantTrial("${key}") was written — hasLicense() never reads that key, ` +
          `so the caller is told they are licensed and the next call is still UNAUTHORIZED.`);
      }
      let ok = true;
      try { grantTrial('quezar'); } catch { ok = false; }
      check('grantTrial still accepts a real namespace', ok,
        'the guard rejected "quezar", which NS_LICENSE does map — grants are now broken');
    }

    // activate throws on a missing binary before reaching any license write, so
    // without an engine this assertion holds no matter what the handler does.
    // Skip rather than pass: a vacuous guard is how the original bug would slip
    // back in through a green PR check.
    if (!engineAvailable('maxion-app')) {
      skip('activate writes no license key under "engine.maxion"',
        'maxion-app binary not built — activate short-circuits before any license write',
        { engine: true });
    } else {
      await call('engine.maxion.activate', { duration_minutes: 1 });
      const keys = Object.keys(getLicenses());
      check('activate writes no license key under "engine.maxion"',
        !keys.some(k => k.startsWith('engine.maxion')),
        `activate wrote ${keys.filter(k => k.startsWith('engine.maxion')).join(', ')} — ` +
        `a key the license gate never reads, which is the original bug`);
    }
  } finally {
    saveLicenses(licBefore);
  }
}

// ──────────────────────────────────────────────────────────
// TEST 6 — ENGINE PATH RESOLUTION
// ──────────────────────────────────────────────────────────
async function testEnginePaths() {
  banner('TEST 6 — ENGINE PATH RESOLUTION');
  // This suite asserts on security.diamonize.status output, which the
  // authorization middleware would otherwise turn into UNAUTHORIZED. Licensing
  // here keeps the suite runnable on its own: relying on testDiamonize having
  // run first makes `node run_tests.js paths` fail for a reason that has
  // nothing to do with path resolution.
  await ensureLicensed('diamonize');

  section('Executable suffix matches the host platform');
  // Regression: paths were hardcoded to ".exe", so lookup could never succeed
  // on the Linux deploy target regardless of whether a binary was present.
  const expected = process.platform === 'win32' ? '.exe' : '';
  check(`EXE_SUFFIX is ${JSON.stringify(expected)} on ${process.platform}`,
    EXE_SUFFIX === expected,
    `got ${JSON.stringify(EXE_SUFFIX)} — a .exe suffix on a non-Windows host can never resolve`);

  for (const app of Object.keys(ENGINE_NAMES)) {
    const cands = engineCandidates(app);
    check(`${app}: candidate paths are non-empty`, cands.length > 0, 'no candidates produced');
    if (process.platform !== 'win32') {
      check(`${app}: no candidate ends in .exe`,
        cands.every(p => !p.endsWith('.exe')),
        `Windows-only paths on ${process.platform}:\n${cands.join('\n')}`);
    }
    check(`${app}: candidates end with the engine filename`,
      cands.every(p => path.basename(p) === ENGINE_NAMES[app] + EXE_SUFFIX),
      `unexpected basenames:\n${cands.join('\n')}`);
  }

  section('MAXION_ENGINE_DIR override takes priority');
  const prev = process.env.MAXION_ENGINE_DIR;
  try {
    process.env.MAXION_ENGINE_DIR = '/opt/maxion-engines';
    const first = engineCandidates('maxion-app')[0];
    check('override directory is searched first',
      first === path.join('/opt/maxion-engines', 'Maxion V16' + EXE_SUFFIX),
      `expected the override dir first, got: ${first}`);
  } finally {
    if (prev === undefined) delete process.env.MAXION_ENGINE_DIR;
    else process.env.MAXION_ENGINE_DIR = prev;
  }

  section('Unavailable-engine message does not leak filesystem paths');
  // Tool results go back to the caller; the searched absolute paths carry the
  // install location and often the local username. They belong in the server
  // log, not the response.
  // Gate on the engine backing the tool actually called below, not on "any
  // engine missing" — with a partial build (say diamonize present, maxion not)
  // the old precondition entered this block and then asserted against a real
  // healthy response.
  if (engineAvailable('diamonize-app')) {
    skip('engine-unavailable message hygiene', 'diamonize-app is present — no unavailable message to inspect');
  } else {
    // Use a tool that actually spawns the engine: status now reports posture
    // rather than raising engineUnavailableError, so it no longer exercises the
    // message this section is checking.
    const msg = (await call('security.diamonize.scan', { target: 'SYSTEM_MEMORY' })).text;
    check('message contains no absolute path',
      !/(^|\s)\/[^\s]*\//.test(msg) && !/[A-Za-z]:\\/.test(msg),
      `absolute path leaked into tool output:\n${truncate(msg)}`);
    check('message still tells the caller how to fix it',
      msg.includes('MAXION_ENGINE_DIR'),
      `message dropped the actionable hint:\n${truncate(msg)}`);
  }

  section('A present-but-unusable binary is not treated as an engine');
  // Zip/S3 round-trips routinely drop the exec bit. A file that cannot be
  // spawned must not satisfy engineAvailable(), or the gated handlers return
  // their healthy text with nothing actually running.
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'maxion-badengine-'));
    const prevDir = process.env.MAXION_ENGINE_DIR;
    try {
      const bad = path.join(d, 'diamonize-lsa' + EXE_SUFFIX);
      fs.writeFileSync(bad, 'not-executable');
      fs.chmodSync(bad, 0o644);
      process.env.MAXION_ENGINE_DIR = d;

      // Assert on identity: resolveEngine walks several candidates, so "is
      // anything available" would be satisfied by a real binary further down
      // the list and prove nothing about this file.
      if (process.platform !== 'win32') {
        check('a non-executable file is never selected as the engine',
          resolveEngine('diamonize-app') !== bad,
          'resolveEngine chose a chmod 644 file — a lost exec bit bypasses the gate');
      }

      // Move real binaries to the out-of-tree stash so the bad one is the only
      // candidate; restoreStash() puts them back on every exit path.
      if (fs.existsSync(ENGINES_DIR)) {
        fs.mkdirSync(ENGINES_STASH, { recursive: true });
        // Stash only what restoreFrom() will put back. Moving foreign files
        // (checksums, VERSION, a provenance manifest fetched alongside the
        // binaries) would orphan them in the stash, and the deploy zips
        // engines/ straight into the Lambda package.
        for (const f of fs.readdirSync(ENGINES_DIR)) {
          if (!STASHABLE.has(f)) continue;
          fs.renameSync(path.join(ENGINES_DIR, f), path.join(ENGINES_STASH, f));
        }
      }

      if (process.platform !== 'win32') {
        check('with only a non-executable binary, no engine is available',
          !engineAvailable('diamonize-app'),
          'engineAvailable() accepted an unusable file');

        await ensureLicensed('diamonize');
        const st = await call('security.diamonize.status');
        check('status reports the scan engine as unavailable',
          /NOT AVAILABLE/i.test(st.text),
          `status did not flag the unusable engine:\n${truncate(st.text)}`);
        check('unusable binary does not yield "Shield: ACTIVE"',
          !/Shield: ACTIVE/i.test(st.text),
          `fake-healthy text returned for an unusable engine:\n${truncate(st.text)}`);
      }

      // scan does spawn the engine, so it still must fail closed.
      const sc = await call('security.diamonize.scan', { target: 'SYSTEM_MEMORY' });
      checkIsError('scan refuses when the only binary is unusable', sc);

      // Executable but not a valid program: this reaches spawn, exercising the
      // spawn-error path rather than the availability gate.
      fs.chmodSync(bad, 0o755);
      const scan = await call('security.diamonize.scan', { target: 'SYSTEM_MEMORY' });
      checkIsError('an unspawnable binary surfaces an error', scan);
      check('spawn failure does not leak the engine path',
        !/(^|\s)\/[^\s]*\//.test(scan.text) && !/[A-Za-z]:\\/.test(scan.text),
        `absolute path leaked from the spawn-error path:\n${truncate(scan.text)}`);
    } finally {
      restoreStash();
      if (prevDir === undefined) delete process.env.MAXION_ENGINE_DIR;
      else process.env.MAXION_ENGINE_DIR = prevDir;
      fs.rmSync(d, { recursive: true, force: true });
    }
  }

  section('Unknown engine resolves to nothing rather than throwing');
  check('unknown app yields no candidates', engineCandidates('nope-app').length === 0, 'expected []');
  check('unknown app is not reported available', !engineAvailable('nope-app'), 'expected false');
}

// ──────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2];

  banner('MAXION MCP GATEWAY — TEST SUITE');
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`  Mode: ${arg || 'all'}`);
  if (REQUIRE_ENGINES) {
    console.log('  MAXION_REQUIRE_ENGINES=1 — missing engines will FAIL, not skip');
  }
  console.log('  Engine binaries:');
  for (const app of ['maxion-app', 'diamonize-app', 'quezar-app', 'hmac-vault-app']) {
    console.log(`    ${app.padEnd(16)} ${engineAvailable(app) ? 'present' : 'NOT BUILT — dependent checks will SKIP'}`);
  }

  if (!arg || arg === 'maxion')    await suite('maxion',    testMaxion);
  if (!arg || arg === 'diamonize') await suite('diamonize', testDiamonize);
  if (!arg || arg === 'quezar')    await suite('quezar',    testQuezar);
  if (!arg || arg === 'hmac')      await suite('hmac',      testHmacVault);
  if (!arg || arg === 'lineage')   await suite('lineage',   testLineage);
  if (!arg || arg === 'gateway')   await suite('gateway',   testGateway);
  if (!arg || arg === 'paths')     await suite('paths',     testEnginePaths);

  // ── Summary ──────────────────────────────────────────────
  banner('SUMMARY');
  console.log(`  Passed:  ${stats.pass}`);
  console.log(`  Failed:  ${stats.fail}`);
  console.log(`  Skipped: ${stats.skip}`);

  if (skips.length) {
    console.log('\n  Skipped checks (NOT passes — these went unverified):');
    for (const s of skips) console.log(`    - [${s.suite}] ${s.label}: ${s.reason}`);

    // On GitHub, a green check is all most reviewers see. Skipped assertions are
    // exactly the ones that would catch a regression (EICAR detection, the vault
    // round-trip, the license-key guard), so surface them as annotations and in
    // the job summary rather than leaving them buried in log output.
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::warning title=Incomplete coverage::${skips.length} check(s) did not run: ` +
        skips.map(s => s.label).join('; '));
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        try {
          fs.appendFileSync(summary,
            `### ⚠️ ${skips.length} check(s) skipped — this run did not verify them\n\n` +
            `| Suite | Check | Why |\n|---|---|---|\n` +
            skips.map(s => `| ${s.suite} | ${s.label} | ${s.reason} |`).join('\n') +
            `\n\n${stats.pass} passed, ${stats.fail} failed. A green result here means the ` +
            `assertions that ran passed — not that the engine surface is covered.\n\n`);
        } catch {}
      }
    }
  }

  if (failures.length) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    - [${f.suite}] ${f.label}\n      ${f.detail.split('\n')[0]}`);
  }

  const ok = stats.fail === 0;
  console.log('\n' + SEP);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${stats.pass} passed, ${stats.fail} failed, ${stats.skip} skipped`);
  if (ok && stats.skip > 0) {
    console.log('  NOTE: assertions passed, but coverage is incomplete — see skipped checks above.');
  }
  console.log(SEP + '\n');

  process.exit(ok ? 0 : 1);
}

if (IS_CLI) {
  main().catch(err => {
    console.error('\n[FATAL]', err.stack || err.message);
    process.exit(1);
  });
}
