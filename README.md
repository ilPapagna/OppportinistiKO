# Radice
Interfaccia educativa responsive in HTML5, CSS3 e JavaScript ES modules, senza framework o build.

## Avvio
Dalla cartella del repository:
```sh
python3 -m http.server 8000 --bind 0.0.0.0
```
Aprire il sito tramite un server HTTP (i moduli non funzionano con `file://`).

## Architettura
- `index.html`: sezioni, form semantici e dialog.
- `styles.css`: design responsive, focus, riduzione movimento, lettura facilitata.
- `js/app.js`: interazioni e rendering; input testuali escapati.
- `js/api.js`: unico punto di accesso REST; adapter demo con persistenza locale.
- `js/utils.js`: date di calendario, età e compressione locale immagini ≤150 KiB.

La demo parte con 24 crediti e una call. OTP demo: **123456** (scadenza 10 minuti, massimo 5 tentativi). Nessuna email o transazione reale. I dati personali di registrazione non sono persistiti. Illustrazione SVG locale originale e font di sistema come fallback: nessuna risorsa esterna richiesta. I video didattici e le registrazioni reali devono essere forniti dal backend; la UI comunica esplicitamente la loro assenza. Le immagini non supportate dal decoder del browser vengono rifiutate; input massimo 25 MiB. Canvas rimuove i metadati, scala e codifica WebP/JPEG, verificando la dimensione prima del caricamento.

## Collegamento REST
Prima dello script module, impostare:
```html
<script>window.RADICE_CONFIG = { demo: false, baseUrl: '/api/v1', csrfToken: 'TOKEN_FORNITO_DAL_SERVER' };</script>
```
Usare cookie HttpOnly/Secure/SameSite, HTTPS e protezione CSRF server-side. `api.js` gestisce errori HTTP, JSON, multipart e timeout. Il server deve applicare autorizzazioni e consenso del tutore, validazione dei dati (compreso codice fiscale), invio OTP con rate limiting/scadenza, disponibilità tutor, proprietà dei video e operazioni atomiche/idempotenti sui crediti. Il frontend non è un confine di sicurezza. Autenticazione, pagamento, videochiamata e registrazione automatica richiedono servizi backend; questa implementazione ne fornisce l’interfaccia.

Contratti attesi (JSON salvo multipart):
| Metodo / endpoint | Dati / risposta |
| --- | --- |
| GET /me/dashboard | `{balance,reviews,associations,bookings,unlocked,purchases,calls}` |
| POST /reviews | `{subject,topic,date}` → `{id,subject,topic,date,done:[false,false,false,false]}` |
| PATCH /reviews/:id/steps/:index | `{done:boolean}` |
| POST /associations | FormData `number`, `word`, `image` compressa opzionale |
| GET /availability?tutor=…&date=… | Array stringhe `HH:mm`, fuso Europe/Rome |
| POST /bookings | `{tutor,date,time,timezone,recordingConsent}`; verifica diritto call e consenso |
| GET /recordings | `[{id,title,tutor,date,unlocked,videoUrl}]`; URL firmato solo se autorizzato |
| POST /recordings/:id/unlock | Addebito atomico 3 crediti, idempotente → `{videoUrl}` |
| POST /orders | `{product:'single'|'bundle',topic}`; prezzi server 8/15 crediti |
| POST /checkout | `{credits:15|30|50|100}` → `{checkoutUrl}` HTTPS; saldo aggiornato solo da webhook verificato |
| POST /registrations | Dati studente, eventuali dati tutore, `isMinor`, `parentConsent`, `consentText` → `{registrationId,requiresOtp}` |
| POST /registrations/:id/verify-parent | `{code}`; account minore attivato solo dopo verifica server |
| GET /lessons/introduction | `{videoUrl}` |

Date ripassi: +1, +7, +30, +90 giorni di calendario, senza sommare millisecondi (corretto attraverso cambi d’ora). Disponibilità demo simulata; stato condiviso fra dispositivi solo con backend.

Prima del rilascio sostituire prezzi demo e informativa provvisoria con testi approvati, fornire contenuti video accessibili (sottotitoli e trascrizioni), integrare autenticazione, tutela minori, provider call/registrazione e checkout. I contenuti di mantenimento cognitivo sono educativi, non clinici.
