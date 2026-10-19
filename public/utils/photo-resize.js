/**
 * Modul: Photo resize
 * Zweck: Shrinks a camera photo in the browser before it is sent: the long
 *        edge to 1600px and JPEG at 82%, so a 4 MB phone photo travels as
 *        roughly 300-500 KB. Uses a data URL, not blob:, because the app's CSP
 *        allows data: images only.
 */

/** @returns {Promise<string>} the file as a data URL */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = src;
  });
}

/**
 * @param {File} file
 * @param {{maxSide?: number, quality?: number}} [opts]
 * @returns {Promise<string>} a JPEG data URL
 */
export async function photoToJpegDataUrl(file, { maxSide = 1600, quality = 0.82 } = {}) {
  const img = await loadImage(await readAsDataUrl(file));
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}
