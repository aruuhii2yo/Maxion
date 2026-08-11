/**
 * J&K Advanced Technologies — Enterprise Licensing Suite
 * Ed25519 License Issuer
 * 
 * Cryptographically binds and signs an enterprise customer license against their host HWID.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEYS_DIR = path.join(__dirname, 'keys');
const PRIV_KEY_PATH = path.join(KEYS_DIR, 'ed25519_private.pem');

function issueLicense({ hwid, customerName, tier = 'enterprise', modules = ['maxion', 'diamonize', 'quezar', 'zenon'], durationDays = 365, outputFile }) {
  if (!fs.existsSync(PRIV_KEY_PATH)) {
    throw new Error(`Private key not found at ${PRIV_KEY_PATH}. Run keygen.js first.`);
  }

  const privateKey = fs.readFileSync(PRIV_KEY_PATH, 'utf8');

  const now = Date.now();
  const expiresAt = durationDays === 0 ? 0 : now + (durationDays * 24 * 60 * 60 * 1000);

  const payload = {
    issuer: "J&K Advanced Technologies LLC",
    customer: customerName,
    hwid: hwid,
    tier: tier,
    modules: modules,
    issued_at: new Date(now).toISOString(),
    expires_at: expiresAt === 0 ? "LIFETIME / PERPETUAL" : new Date(expiresAt).toISOString(),
    expires_timestamp: expiresAt,
    serial: `JK-LIC-${crypto.randomBytes(6).toString('hex').toUpperCase()}`
  };

  const payloadString = JSON.stringify(payload, Object.keys(payload).sort(), 2);
  
  // Sign payload with Ed25519 Private Key
  const signature = crypto.sign(null, Buffer.from(payloadString, 'utf8'), privateKey);
  const signatureHex = signature.toString('hex');

  const licenseObject = {
    license_data: payload,
    signature: signatureHex,
    algorithm: "Ed25519"
  };

  const targetPath = outputFile || path.join(__dirname, `${customerName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_zenon.lic`);
  fs.writeFileSync(targetPath, JSON.stringify(licenseObject, null, 2));

  console.log('====================================================');
  console.log('     J&K ENTERPRISE LICENSE ISSUED SUCCESSFULLY     ');
  console.log('====================================================');
  console.log(`Customer:     ${customerName}`);
  console.log(`Node HWID:    ${hwid}`);
  console.log(`Tier:         ${tier.toUpperCase()}`);
  console.log(`Modules:      ${modules.join(', ')}`);
  console.log(`Expiration:   ${payload.expires_at}`);
  console.log(`License File: ${targetPath}\n`);

  return { licenseObject, targetPath };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const customer = args[0] || "Acme Sovereign Defense";
  const hwid = args[1] || "JK-HWID-DEMO-NODE-LOCK-88AA";
  issueLicense({ customerName: customer, hwid });
}

module.exports = { issueLicense };
