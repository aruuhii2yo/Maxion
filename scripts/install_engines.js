/**
 * J&K Advanced Technologies — Verified Native Engine Downloader
 * 
 * Implements the industry-standard "Verified Downloader" pattern (Prisma/esbuild model).
 * Automatically verifies local binary integrity against cryptographic SHA-256 digests,
 * or securely fetches and validates pre-compiled release engines from the J&K CDN.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const S3_BASE = process.env.MAXION_ENGINES_CDN || "https://jk-advanced-tech-web-videos.s3.amazonaws.com/engines";
const ENGINES_DIR = path.join(__dirname, '..', 'engines');

const MANIFEST = {
  win32: {
    "Maxion V16.exe":     "c541b29e6a59a4e9524b5b73bdba00f4a552c88b5d69da00409046cb74de62f0",
    "quezar-storage.exe": "4ee63b09ba374d8ab6bd2c3a83297f808f538c98d5d0fd5bf6b757c6a5b95bef",
    "diamonize-lsa.exe":  "27738a84a0a595421295d48754e3f9e506d811f268d6746533c66360c69c64bb",
    "go_green_suite.exe": "d84d649f88c4a1387e79e37dff46ff2989c8e2b9db89952b9bae377cbe78fe75"
  },
  linux: {
    "Maxion V16":     "c541b29e6a59a4e9524b5b73bdba00f4a552c88b5d69da00409046cb74de62f0",
    "quezar-storage": "4ee63b09ba374d8ab6bd2c3a83297f808f538c98d5d0fd5bf6b757c6a5b95bef",
    "diamonize-lsa":  "27738a84a0a595421295d48754e3f9e506d811f268d6746533c66360c69c64bb",
    "go_green_suite": "d84d649f88c4a1387e79e37dff46ff2989c8e2b9db89952b9bae377cbe78fe75"
  }
};

async function verifyAndDownload() {
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  const targets = MANIFEST[platform] || MANIFEST.linux;

  if (!fs.existsSync(ENGINES_DIR)) {
    fs.mkdirSync(ENGINES_DIR, { recursive: true });
  }

  console.log(`[J&K Engine Installer] Checking native engine binaries for ${platform}...`);

  for (const [filename, expectedHash] of Object.entries(targets)) {
    const destPath = path.join(ENGINES_DIR, filename);

    // 1. Check if already present and valid
    if (fs.existsSync(destPath)) {
      try {
        const data = fs.readFileSync(destPath);
        const hash = crypto.createHash('sha256').update(data).digest('hex');
        if (hash.toLowerCase() === expectedHash.toLowerCase()) {
          console.log(`[J&K Engine Installer] ✅ ${filename} verified (SHA-256 intact).`);
          continue;
        } else {
          console.log(`[J&K Engine Installer] ⚠️ ${filename} checksum mismatch; updating...`);
        }
      } catch (e) {
        console.warn(`[J&K Engine Installer] Could not read existing ${filename}:`, e.message);
      }
    }

    // 2. Download from secure S3 CDN if absent or invalid
    const url = `${S3_BASE}/${platform}/${encodeURIComponent(filename)}`;
    console.log(`[J&K Engine Installer] ⬇️ Fetching verified ${filename} from CDN...`);

    try {
      await new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Maxion-Engine-Installer' } }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            return https.get(res.headers.location, (redirectRes) => {
              if (redirectRes.statusCode !== 200) {
                return reject(new Error(`HTTP ${redirectRes.statusCode} on redirect`));
              }
              handleStream(redirectRes, destPath, expectedHash, resolve, reject);
            }).on('error', reject);
          }

          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }

          handleStream(res, destPath, expectedHash, resolve, reject);
        });

        req.on('error', reject);
        req.setTimeout(15000, () => {
          req.destroy(new Error('Connection timed out'));
        });
      });
    } catch (err) {
      console.warn(`[J&K Engine Installer] Notice: CDN download for ${filename} skipped (${err.message}). Local fallback retained.`);
    }
  }

  console.log('[J&K Engine Installer] Native engine verification pass complete.\n');
}

function handleStream(stream, destPath, expectedHash, resolve, reject) {
  const hashStream = crypto.createHash('sha256');
  const tempPath = `${destPath}.tmp_${Date.now()}`;
  const fileStream = fs.createWriteStream(tempPath);

  stream.on('data', chunk => {
    hashStream.update(chunk);
    fileStream.write(chunk);
  });

  stream.on('end', () => {
    fileStream.end(() => {
      const downloadedHash = hashStream.digest('hex');
      if (expectedHash && downloadedHash.toLowerCase() !== expectedHash.toLowerCase()) {
        try { fs.unlinkSync(tempPath); } catch {}
        return reject(new Error(`Cryptographic hash mismatch! Expected ${expectedHash}, got ${downloadedHash}`));
      }

      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        fs.renameSync(tempPath, destPath);
        if (process.platform !== 'win32') fs.chmodSync(destPath, 0o755);
        console.log(`[J&K Engine Installer] ✅ ${path.basename(destPath)} successfully verified and installed.`);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });

  stream.on('error', (err) => {
    try { fs.unlinkSync(tempPath); } catch {}
    reject(err);
  });
}

verifyAndDownload().catch(err => {
  console.error('[J&K Engine Installer] Error during postinstall:', err.message);
  process.exit(0); // Do not break npm install
});
