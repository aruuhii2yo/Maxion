/**
 * J&K Advanced Technologies — Enterprise Licensing Suite
 * Ed25519 Keypair Generator
 * 
 * Generates an asymmetric Ed25519 keypair for offline cryptographic license signing.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEYS_DIR = path.join(__dirname, 'keys');

function generateKeys() {
  if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const privPath = path.join(KEYS_DIR, 'ed25519_private.pem');
  const pubPath = path.join(KEYS_DIR, 'ed25519_public.pem');

  fs.writeFileSync(privPath, privateKey);
  fs.writeFileSync(pubPath, publicKey);

  console.log('====================================================');
  console.log('       J&K Ed25519 KEYPAIR GENERATION COMPLETE      ');
  console.log('====================================================');
  console.log(`Private Key (KEEP CONFIDENTIAL): ${privPath}`);
  console.log(`Public Key (Embed in engines):   ${pubPath}\n`);
}

if (require.main === module) {
  generateKeys();
}

module.exports = { generateKeys };
