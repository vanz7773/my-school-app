const axios = require('axios');
const Jimp = require('jimp');
const fs = require('fs/promises');
const path = require('path');

const cache = new Map();
const EMPTY = { logoBase64: null, grayLogoBase64: null };
const MAX_ENTRIES = 20;
const MAX_CACHE_BYTES = 12 * 1024 * 1024;

const trimCache = () => {
  let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (cache.size > MAX_ENTRIES || bytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    bytes -= cache.get(oldest).bytes;
    cache.delete(oldest);
  }
};

const getPayslipLogo = async (schoolInfo, schoolId) => {
  if (!schoolInfo?.logo) return EMPTY;
  const key = JSON.stringify([String(schoolId), schoolInfo.logo, schoolInfo.updatedAt || '']);
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.promise;
  cache.delete(key);
  const entry = { expires: Date.now() + 15 * 60 * 1000, bytes: 0 };
  // Cache the promise too, so simultaneous downloads share one logo fetch/conversion.
  entry.promise = (async () => {
    try {
      const buffer = /^https?:\/\//i.test(schoolInfo.logo)
        ? Buffer.from((await axios.get(schoolInfo.logo, {
          responseType: 'arraybuffer', timeout: 2000, maxContentLength: 3 * 1024 * 1024,
        })).data)
        : await fs.readFile(path.join(__dirname, '..', schoolInfo.logo));
      const image = await Jimp.read(buffer);
      if (image.bitmap.width > 512 || image.bitmap.height > 512) image.scaleToFit(512, 512);
      const [color, gray] = await Promise.all([
        image.getBufferAsync(Jimp.MIME_PNG),
        image.clone().greyscale().getBufferAsync(Jimp.MIME_PNG),
      ]);
      const assets = { logoBase64: `data:image/png;base64,${color.toString('base64')}`, grayLogoBase64: `data:image/png;base64,${gray.toString('base64')}` };
      entry.bytes = assets.logoBase64.length + assets.grayLogoBase64.length;
      trimCache();
      return assets;
    } catch (error) {
      // Optional branding should not hold up a salary download. Retry it after a short cooldown.
      entry.expires = Date.now() + 30 * 1000;
      console.warn('Payslip logo unavailable:', error.message);
      return EMPTY;
    }
  })();
  cache.set(key, entry);
  trimCache();
  return entry.promise;
};

module.exports = { getPayslipLogo };
