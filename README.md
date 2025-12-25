# Cloudflare Gmailer API

Dette projekt er en Cloudflare Worker, der fungerer som en simpel mail-service via Gmail API'et. Den håndterer OAuth2-flowet med Google og gør det muligt at sende emails fra den autentificerede brugers konto til dem selv.

## Swagger Dokumentation

Du kan finde den fulde API dokumentation og teste endpoints her:
[https://app.swaggerhub.com/apis/myself-2b6/cloudflare-gmail/1](https://app.swaggerhub.com/apis/myself-2b6/cloudflare-gmail/1)

## Sådan bruges API'et

API'et er bygget op omkring et `session_id`, som du selv genererer og styrer. Dette ID bruges til at koble en browser-session sammen med de gemte OAuth-tokens i Cloudflare KV.

### 1. Start Login (`/auth`)

For at kunne sende mails skal brugeren først godkende applikationen via Google.

- **Endpoint:** `GET /auth`
- **Query Param:** `session_id` (Påkrævet) - En unik streng du genererer.
- **Virkemåde:** Sender brugeren til Google's login-side. Efter login gemmes tokens sikkert i Cloudflare KV koblet til dit `session_id`.

Eksempel:
```
GET https://din-worker.workers.dev/auth?session_id=bruger_123
```

### 2. Tjek Status (`/status`)

Tjek om et givent `session_id` allerede er logget ind og har en gyldig token.

- **Endpoint:** `GET /status`
- **Query Param:** `session_id` (Påkrævet)
- **Response:** JSON `{ "loggedIn": true/false }`

Eksempel:
```
GET https://din-worker.workers.dev/status?session_id=bruger_123
```

### 3. Send Email (`/send`)

Sender en email fra den loggede ind brugers konto til dem selv.

- **Endpoint:** `POST /send`
- **Body (JSON):**
  ```json
  {
    "session_id": "bruger_123",
    "subject": "Test Email",
    "html": "<p>Dette er en test besked</p>",
    "source": "Min App" // Valgfri, default er "DBA Monitor"
  }
  ```

## Opsætning (For udviklere)

For at deploye denne worker skal du bruge:

1.  **Cloudflare Konto** med Workers aktiveret.
2.  **Google Cloud Project** med:
    - Gmail API aktiveret.
    - OAuth 2.0 Client ID og Secret oprettet.
    - Redirect URI sat til `https://din-worker.workers.dev/oauth2callback`.
3.  **Wrangler** installeret lokalt.

### Miljøvariabler (Secrets)

Følgende secrets skal sættes i din Cloudflare Worker (via `wrangler secret put` eller i dashboardet):

- `CLIENT_ID`: Dit Google OAuth Client ID.
- `CLIENT_SECRET`: Din Google OAuth Client Secret.
- `REDIRECT_URI`: Din fulde redirect URL (f.eks. `https://din-worker.workers.dev/oauth2callback`).

### KV Namespace

Projektet kræver et KV namespace bundet til navnet `MAIL_AUTH`.
Dette er konfigureret i `wrangler.jsonc`, men du skal sikre dig at ID'et matcher dit eget KV namespace.
