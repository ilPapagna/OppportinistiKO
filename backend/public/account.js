const $ = (s) => document.querySelector(s);
let csrf = "",
  challenge = "",
  legalVersion = "";
const message = (text) => ($("#message").textContent = text);
async function call(path, body) {
  const response = await fetch(`/api/v1${path}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    headers: body
      ? { "Content-Type": "application/json", "X-CSRF-Token": csrf }
      : {},
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
async function session() {
  try {
    const data = await call("/auth/session");
    csrf = data.csrfToken;
    $("#identity").textContent = `${data.user.email} · ${data.user.role}`;
    $("#logged").hidden = false;
    $("#anonymous").hidden = true;
  } catch {
    $("#logged").hidden = true;
    $("#anonymous").hidden = false;
  }
}
document
  .querySelectorAll("[data-view]")
  .forEach(
    (b) =>
      (b.onclick = () =>
        document
          .querySelectorAll("#anonymous form")
          .forEach((f) => (f.hidden = f.id !== b.dataset.view))),
  );
$("#login").onsubmit = (e) => {
  e.preventDefault();
  run(e.submitter, async () => {
    const result = await call(
      "/auth/login",
      Object.fromEntries(new FormData(e.target)),
    );
    csrf = result.csrfToken;
    location.assign(result.user.role === "ADMIN" ? "/admin" : "/");
  });
};
for (const [id, endpoint] of [
  ["forgot", "/auth/forgot-password"],
  ["verify", "/auth/resend-verification"],
])
  $(`#${id}`).onsubmit = (e) => {
    e.preventDefault();
    run(e.submitter, async () => {
      await call(endpoint, Object.fromEntries(new FormData(e.target)));
      message(
        "Se l’account è presente e richiede questa operazione, riceverai un’email.",
      );
    });
  };
const params = new URLSearchParams(location.hash.slice(1));
let resetToken = params.get("reset"),
  verifyToken = params.get("verify");
if (resetToken || verifyToken) {
  history.replaceState(null, "", "/account");
  $("#anonymous").hidden = true;
  $("#reset").hidden = !resetToken;
  $("#verify-link").hidden = !verifyToken;
} else session();
$("#confirm-email").onclick = (e) =>
  run(e.currentTarget, async () => {
    await call("/auth/verify-email", { token: verifyToken });
    verifyToken = null;
    $("#verify-link").hidden = true;
    $("#anonymous").hidden = false;
    message("Email verificata. Ora puoi accedere.");
  });
$("#reset").onsubmit = (e) => {
  e.preventDefault();
  run(e.submitter, async () => {
    await call("/auth/reset-password", {
      token: resetToken,
      password: e.target.elements.password.value,
    });
    resetToken = null;
    e.target.reset();
    e.target.hidden = true;
    $("#anonymous").hidden = false;
    message(
      "Password aggiornata. Tutte le sessioni precedenti sono state revocate.",
    );
  });
};
$("#logout").onclick = (e) =>
  run(e.currentTarget, async () => {
    await call("/auth/logout", {});
    csrf = "";
    await session();
    message("Disconnessione completata.");
  });
$("#request-consent").onclick = (e) =>
  run(e.currentTarget, async () => {
    const legal = await call("/legal/parent");
    legalVersion = legal.version;
    $("#legal-text").textContent = legal.body;
    $("#guardian").hidden = false;
  });
$("#guardian").onsubmit = (e) => {
  e.preventDefault();
  run(e.submitter, async () => {
    const result = await call("/consents/request", {
      guardian: Object.fromEntries(new FormData(e.target)),
      accepted: true,
      legalVersion,
    });
    challenge = result.registrationId;
    e.target.reset();
    e.target.hidden = true;
    $("#otp").hidden = false;
    message("Codice inviato al genitore. Scade fra 10 minuti.");
  });
};
$("#otp").onsubmit = (e) => {
  e.preventDefault();
  run(e.submitter, async () => {
    await call(`/registrations/${challenge}/verify-parent`, {
      code: e.target.elements.code.value,
    });
    e.target.hidden = true;
    e.target.reset();
    message("Consenso verificato e registrato.");
  });
};
