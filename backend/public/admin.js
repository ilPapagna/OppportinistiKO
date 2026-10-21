const $ = (s) => document.querySelector(s);
let csrf = "",
  users = [],
  after = "",
  search = "";
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function message(text) {
  $("#message").textContent = text;
}
async function api(path, method = "GET", body) {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message);
  return data;
}
async function run(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (e) {
    message(e.message);
  } finally {
    button.disabled = false;
  }
}
async function load() {
  users = await api(
    `/admin/users?search=${encodeURIComponent(search)}${after ? `&after=${after}` : ""}`,
  );
  $("#users").innerHTML =
    users
      .map(
        (u) =>
          `<tr><td><strong>${esc(u.first_name)} ${esc(u.last_name)}</strong><small>${esc(u.email)}</small></td><td>${esc(u.role)}</td><td>${u.balance}</td><td>${u.disabled ? "Sospeso" : u.email_verified_at ? "Attivo" : "Email da verificare"}<small>Consenso: ${u.parent_consent ? "presente" : "non presente"}</small></td><td><button data-user="${u.id}">Gestisci</button></td></tr>`,
      )
      .join("") || '<tr><td colspan="5">Nessun utente trovato.</td></tr>';
  $("#next").disabled = users.length < 50;
}
function details(id) {
  const u = users.find((u) => u.id === id);
  $("#detail-content").innerHTML =
    `<h2>${esc(u.first_name)} ${esc(u.last_name)}</h2><p>${esc(u.email)} · saldo ${u.balance} crediti</p><form id="credit-form"><fieldset><legend>Rettifica saldo</legend><label>Variazione crediti (es. 15 oppure -3)<input name="delta" type="number" min="-100000" max="100000" required></label><label>Motivazione<input name="reason" minlength="10" maxlength="500" required></label><button>Registra variazione</button></fieldset></form><form id="user-form"><fieldset><legend>Ruolo e accesso</legend><label>Ruolo<select name="role">${["STUDENT", "TUTOR", "ADMIN"].map((r) => `<option ${r === u.role ? "selected" : ""}>${r}</option>`).join("")}</select></label><label>ID utente Zoom (per tutor)<input name="zoomUserId" value="${esc(u.zoom_user_id)}" maxlength="200"></label><label class="check"><input name="disabled" type="checkbox" ${u.disabled ? "checked" : ""}>Sospendi accesso</label><label>Motivazione<input name="reason" minlength="10" maxlength="500" required></label><button>Salva modifiche</button></fieldset></form><form id="password-form"><fieldset><legend>Recupero password</legend><p>Invia un link alla persona e revoca le sessioni esistenti. Nessuno visualizza la sua password.</p><label>Motivazione<input name="reason" minlength="10" maxlength="500" required></label><button>Invia recupero password</button></fieldset></form><button id="consents" class="secondary">Consulta consensi legali</button><button id="transactions" class="secondary">Storico crediti</button><div id="history"></div>`;
  $("#details").showModal();
  $("#credit-form").onsubmit = (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.delta = Number(body.delta);
    if (!body.delta) {
      message("Inserisci una variazione diversa da zero.");
      return;
    }
    if (
      !confirm(
        `Confermi una variazione di ${body.delta} crediti per ${u.email}?`,
      )
    )
      return;
    run(e.submitter, async () => {
      const result = await api(`/admin/users/${id}/credits`, "POST", body);
      message(`Saldo aggiornato: ${result.balance} crediti.`);
      $("#details").close();
      await load();
    });
  };
  $("#user-form").onsubmit = (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.disabled = e.target.elements.disabled.checked;
    if (!body.zoomUserId) delete body.zoomUserId;
    if (!confirm("Confermi la modifica di ruolo e accesso?")) return;
    run(e.submitter, async () => {
      await api(`/admin/users/${id}`, "PATCH", body);
      message("Utente aggiornato.");
      $("#details").close();
      await load();
    });
  };
  $("#password-form").onsubmit = (e) => {
    e.preventDefault();
    run(e.submitter, async () => {
      await api(
        `/admin/users/${id}/password-reset`,
        "POST",
        Object.fromEntries(new FormData(e.target)),
      );
      message("Email di recupero accodata.");
      $("#details").close();
    });
  };
  $("#consents").onclick = (e) =>
    run(e.currentTarget, async () => {
      const rows = await api(`/admin/users/${id}/consents`);
      $("#history").innerHTML =
        "<h3>Consensi legali</h3>" +
        rows
          .map(
            (c) =>
              `<article class="panel"><strong>${esc(c.guardian.firstName)} ${esc(c.guardian.lastName)}</strong><p>Email: ${esc(c.guardian.email)}<br>CF: ${esc(c.guardian.taxCode)}<br>Confermato: ${esc(c.accepted_at)} (UTC)<br>Versione: ${esc(c.legal_version)}<br>IP: ${esc(c.ip)}<br>User-Agent: ${esc(c.user_agent)}</p><p>${esc(c.accepted_text)}</p></article>`,
          )
          .join("") +
        (rows.length ? "" : "<p>Nessun consenso registrato.</p>");
    });
  $("#transactions").onclick = (e) =>
    run(e.currentTarget, async () => {
      const rows = await api(`/admin/users/${id}/credits`);
      $("#history").innerHTML =
        "<h3>Ultimi movimenti</h3>" +
        rows
          .map(
            (t) =>
              `<p>${esc(t.created_at)} · ${esc(t.kind)} · ${t.delta} crediti · saldo ${t.balance_after}</p>`,
          )
          .join("");
    });
}
$("#users").onclick = (e) => {
  const b = e.target.closest("[data-user]");
  if (b) details(b.dataset.user);
};
$("#details .close").onclick = () => $("#details").close();
$("#search").onsubmit = (e) => {
  e.preventDefault();
  search = e.target.elements.search.value;
  after = "";
  run(e.submitter, load);
};
$("#next").onclick = (e) => {
  after = users.at(-1)?.id || "";
  run(e.currentTarget, load);
};
async function operations() {
  const data = await api("/admin/operations");
  $("#operations").innerHTML =
    `<p>${data.jobs.length} job falliti · ${data.bookings.length} prenotazioni da verificare</p>` +
    data.jobs
      .map(
        (j) =>
          `<div class="panel">${esc(j.kind)} · ${esc(j.id)} · ${j.attempts} tentativi <button data-retry="${j.id}">Riprova dopo verifica</button></div>`,
      )
      .join("") +
    data.bookings
      .map(
        (b) =>
          `<p class="warning">Prenotazione ${esc(b.id)}: verificare il meeting su Zoom prima di ripetere l’operazione.</p>`,
      )
      .join("");
}
$("#refresh-ops").onclick = (e) => run(e.currentTarget, operations);
$("#operations").onclick = (e) => {
  const button = e.target.closest("[data-retry]");
  if (!button) return;
  const reason = prompt("Descrivi la verifica svolta (almeno 10 caratteri):");
  if (!reason || reason.length < 10) return;
  run(button, async () => {
    await api(`/admin/jobs/${button.dataset.retry}/retry`, "POST", { reason });
    await operations();
  });
};
try {
  const session = await api("/auth/session");
  if (session.user.role !== "ADMIN")
    throw new Error("Questa area richiede il ruolo ADMIN.");
  csrf = session.csrfToken;
  $("#content").hidden = false;
  await load();
  await operations();
} catch (e) {
  message(`${e.message}. Usa “Account e accesso” per accedere.`);
}
