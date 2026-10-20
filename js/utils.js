export function localDate(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
export function addDays(iso, days) { const [year, month, day] = iso.split('-').map(Number); return localDate(new Date(year, month - 1, day + days, 12)); }
export function formatDate(iso) { return new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${iso}T12:00:00`)); }
export function ageAt(birth, now = localDate()) { const [y,m,d] = birth.split('-').map(Number); const [ny,nm,nd] = now.split('-').map(Number); return ny-y-(nm<m || (nm===m && nd<d) ? 1 : 0); }
export function escapeHTML(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
/** Decode locally, scale and remove metadata via canvas. Never upload the original. */
export async function compressImage(file, maxBytes = 150 * 1024) {
  if (!file.type.startsWith('image/')) throw new Error('Seleziona un file immagine.');
  if (file.size > 25 * 1024 * 1024) throw new Error('L’immagine supera 25 MB. Scegli un file più piccolo.');
  let image;
  try { image = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { throw new Error('Formato immagine non supportato dal browser. Usa JPEG, PNG o WebP.'); }
  try {
    let scale = Math.min(1, 1400 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    for (let round = 0; round < 10; round++) {
      canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(image,0,0,canvas.width,canvas.height);
      for (const quality of [.82,.65,.48,.32]) {
        let blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
        if (blob?.type !== 'image/webp') blob = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',quality));
        if (blob && blob.size <= maxBytes) return blob;
      }
      scale *= .7;
    }
    throw new Error('Impossibile comprimere questa immagine sotto 150 KB.');
  } finally { image.close(); }
}
