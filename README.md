# Radice · Il tuo modo di imparare

Piattaforma educativa con tre percorsi (Studenti, Dislessia/DSA e Mantenimento cognitivo), strumenti di studio, lezioni individuali e crediti.

- **Frontend:** HTML5, CSS3 e JavaScript modulare senza framework, layout responsive e lettura facilitata.
- **Backend:** Node.js/TypeScript, Fastify, PostgreSQL, Redis, worker asincrono, SMTP, Zoom, S3 e Stripe.
- **Amministrazione:** backoffice per utenti, ruoli, recupero password, rettifiche crediti e consensi legali.

## Prova della demo statica

Dalla radice del repository:

```sh
python3 -m http.server 8000
```

La demo usa dati locali al browser, 24 crediti iniziali, una call e OTP **123456**. Non invia email e non addebita denaro. I video reali non sono inclusi. L’illustrazione è locale; non sono necessari servizi grafici esterni.

**GitHub Pages pubblica questa versione dimostrativa. Non esegue il backend.**

## Piattaforma completa

Con Node.js 24 e Docker Compose:

```sh
node backend/scripts/init-env.mjs
docker compose -f backend/compose.yaml up --build -d
```

Il backend serve anche il frontend in modalità reale sulla porta **3000**, l’accesso su **/account** e l’amministrazione su **/admin**. Le email locali sono visibili in Mailpit, porta **8025**. L’OTP reale è casuale; non esistono utenti/password predefiniti.

Segui la [guida backend passo per passo](backend/README.md) per creare il primo admin, configurare tutor e Zoom, eseguire test e fare deploy su Render/Railway. Non caricare `.env` o credenziali su GitHub.

## Struttura

| Percorso | Contenuto |
| --- | --- |
| `index.html`, `styles.css` | Interfaccia e design responsive |
| `js/app.js`, `js/api.js`, `js/utils.js` | Interazioni, adapter demo/REST, date e compressione immagini |
| `assets/` | Illustrazione SVG locale |
| `backend/src/` | API, autenticazione, transazioni, servizi e worker |
| `backend/migrations/` | Schema PostgreSQL e vincoli di integrità |
| `backend/public/` | Account e backoffice |
| `backend/test/` | Test d’integrazione su PostgreSQL, Redis e S3 locale |
| `.github/workflows/backend.yml` | Verifica automatica predisposta per GitHub Actions |

[Architettura e schema dati](backend/ARCHITECTURE.md) · [API, sicurezza e deploy](backend/README.md)

La configurazione Zoom, i pagamenti, lo storage e l’email di produzione richiedono servizi e credenziali reali. Prima dell’apertura al pubblico completare il collaudo con i provider, caricare i contenuti video e approvare informativa, condizioni e retention dei dati.
