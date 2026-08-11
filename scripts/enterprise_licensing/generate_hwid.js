/**
 * J&K Advanced Technologies — Enterprise Licensing Suite
 * HWID Fingerprint Generator
 * 
 * Computes a deterministic SHA-256 hardware identifier based on bare-metal host properties.
 */
const si = require('systeminformation');
const crypto = require('crypto');

async function getHardwareFingerprint() {
  const [cpu, system, baseboard, osInfo] = await Promise.all([
    si.cpu(),
    si.system(),
    si.baseboard(),
    si.osInfo()
  ]);

  const rawFingerprint = [
    cpu.brand || '',
    cpu.family || '',
    cpu.model || '',
    cpu.stepping || '',
    system.uuid || '',
    system.serial || '',
    baseboard.serial || '',
    baseboard.assetTag || '',
    osInfo.serial || ''
  ].join('::');

  const hwid = crypto.createHash('sha256').update(rawFingerprint).digest('hex');

  return {
    hwid: `JK-HWID-${hwid.slice(0, 8).toUpperCase()}-${hwid.slice(8, 16).toUpperCase()}-${hwid.slice(16, 24).toUpperCase()}-${hwid.slice(24, 32).toUpperCase()}`,
    fullHash: hwid,
    metadata: {
      cpu: cpu.brand,
      cores: cpu.cores,
      systemUuid: system.uuid,
      baseboardSerial: baseboard.serial,
      platform: process.platform,
      arch: process.arch
    }
  };
}

if (require.main === module) {
  getHardwareFingerprint().then(res => {
    console.log('====================================================');
    console.log('   J&K ENTERPRISE HARDWARE FINGERPRINT GENERATOR    ');
    console.log('====================================================');
    console.log(`\nClient HWID: ${res.hwid}`);
    console.log(`Full SHA-256: ${res.fullHash}`);
    console.log('\nHardware Metadata:');
    console.log(JSON.stringify(res.metadata, null, 2));
    console.log('\nSend the Client HWID to J&K Advanced Technologies to generate your signed .lic file.\n');
  }).catch(console.error);
}

module.exports = { getHardwareFingerprint };
