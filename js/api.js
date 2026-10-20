/** Set window.RADICE_CONFIG before importing app.js to use a real backend.
 * Backend must enforce authentication, parental consent, entitlements and atomic credit transactions.
 */
const config = window.RADICE_CONFIG ?? {};
export const DEMO = config.demo !== false;
const KEY = 'radice.demo.v1';
const initial = () => ({ balance: 24, reviews: [], associations: [], bookings: [], unlocked: [], purchases: [], calls: 1 });
let state;
try { state = JSON.parse(localStorage.getItem(KEY)) || initial(); } catch { state = initial(); }
let pendingRegistration = null;
function save() { localStorage.setItem(KEY, JSON.stringify(state)); }
const id = () => crypto.randomUUID();
async function request(path, { method = 'GET', body } = {}) {
  const multipart = body instanceof FormData;
  const response = await fetch(`${config.baseUrl || '/api/v1'}${path}`, {
    method, credentials: 'include', headers: { ...(!multipart && body ? { 'Content-Type': 'application/json' } : {}), ...(config.csrfToken ? { 'X-CSRF-Token': config.csrfToken } : {}) },
    body: body ? multipart ? body : JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.message || `Richiesta non riuscita (${response.status}).`); }
  return response.status === 204 ? null : response.json();
}
export const api = {
  async dashboard() { return DEMO ? structuredClone(state) : request('/me/dashboard'); },
  async createReview(data) { if (!DEMO) return request('/reviews', { method: 'POST', body: data }); const review = { ...data, id: id(), done: [false,false,false,false] }; state.reviews.unshift(review); save(); return review; },
  async toggleReview(reviewId, index, done) { if (!DEMO) return request(`/reviews/${reviewId}/steps/${index}`, { method: 'PATCH', body: { done } }); state.reviews.find(r => r.id === reviewId).done[index] = done; save(); },
  async association(data, blob) { if (!DEMO) { const body = new FormData(); body.append('number', data.number); body.append('word', data.word); if (blob) body.append('image', blob, `memory.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`); return request('/associations', { method: 'POST', body }); } const image = blob ? await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); }) : null; state.associations.unshift({ ...data, image, id: id() }); try { save(); } catch { state.associations.shift(); throw new Error('Spazio locale esaurito. Prova senza immagine.'); } },
  async slots(tutor, date) { return DEMO ? ['09:00','11:00','15:00','17:00'].filter(time => !state.bookings.some(b => b.date === date && b.time === time && b.tutor === tutor)) : request(`/availability?tutor=${encodeURIComponent(tutor)}&date=${encodeURIComponent(date)}`); },
  async book(data) { if (!DEMO) return request('/bookings', { method: 'POST', body: data }); if (state.calls < 1) throw new Error('Non hai call disponibili. Acquista un Pacchetto Completo nello shop.'); if (!(await this.slots(data.tutor, data.date)).includes(data.time)) throw new Error('Questo orario è già occupato. Scegline un altro.'); state.calls--; state.bookings.push({ ...data, id: id() }); save(); },
  async recordings() { return DEMO ? [{ id: 'lesson-1', title: 'Il tuo primo palazzo della memoria', tutor: 'Elena Rossi', date: '2026-10-12', unlocked: state.unlocked.includes('lesson-1'), videoUrl: null }] : request('/recordings'); },
  async unlock(recordingId) { if (!DEMO) return request(`/recordings/${recordingId}/unlock`, { method: 'POST' }); if (!state.unlocked.includes(recordingId)) { if (state.balance < 3) throw new Error('Crediti insufficienti. Ricarica il tuo saldo.'); state.balance -= 3; state.unlocked.push(recordingId); save(); } return { videoUrl: null }; },
  async buy(product, topic) { if (!DEMO) return request('/orders', { method: 'POST', body: { product, topic } }); const price = product === 'single' ? 8 : 15; if (state.balance < price) throw new Error('Crediti insufficienti. Scegli una ricarica.'); state.balance -= price; if (product === 'bundle') state.calls++; state.purchases.push({ product, topic, id: id() }); save(); return { success: true }; },
  async topup(credits) { if (!DEMO) return request('/checkout', { method: 'POST', body: { credits } }); state.balance += credits; save(); return { demo: true }; },
  async register(data) { if (!DEMO) return request('/registrations', { method: 'POST', body: data }); pendingRegistration = { id: id(), needsOtp: data.isMinor, expires: Date.now() + 600000, attempts: 0 }; return { registrationId: pendingRegistration.id, requiresOtp: data.isMinor }; },
  async verify(registrationId, code) { if (!DEMO) return request(`/registrations/${registrationId}/verify-parent`, { method: 'POST', body: { code } }); if (!pendingRegistration || pendingRegistration.id !== registrationId || Date.now() > pendingRegistration.expires) throw new Error('Codice scaduto. Ripeti la registrazione.'); if (++pendingRegistration.attempts > 5) throw new Error('Troppi tentativi. Ripeti la registrazione.'); if (code !== '123456') throw new Error('Codice errato. Nella demo usa 123456.'); pendingRegistration = null; return { verified: true }; },
  async intro() { return DEMO ? { videoUrl: null } : request('/lessons/introduction'); }
};
