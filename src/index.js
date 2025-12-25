export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Generel CORS - Tillad adgang fra alle dine fremtidige projekter
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", 
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- 1. START LOGIN (Redirect til Google) ---
    if (url.pathname === "/auth") {
      // Vi beder om adgang til at sende mails OG se brugerens profil (for at finde din egen email)
      const scope = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.profile";
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${env.CLIENT_ID}&redirect_uri=${env.REDIRECT_URI}&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;
      return Response.redirect(authUrl, 302);
    }

    // --- 2. CALLBACK FRA GOOGLE (Gemmer tokens i den nye database) ---
    if (url.pathname === "/oauth2callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Ingen kode fundet", { status: 400 });

      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: code,
          client_id: env.CLIENT_ID,
          client_secret: env.CLIENT_SECRET,
          redirect_uri: env.REDIRECT_URI,
          grant_type: "authorization_code",
        }),
      });

      const tokens = await tokenResponse.json();

      if (tokens.error) return new Response("Fejl: " + JSON.stringify(tokens), { status: 400 });

      // Gem tokens i den nye "MAIL_AUTH" database
      await env.MAIL_AUTH.put("refresh_token", tokens.refresh_token);
      if(tokens.access_token) {
        await env.MAIL_AUTH.put("access_token", tokens.access_token, { expirationTtl: 3500 }); 
      }

      return new Response("<h1>Service Forbundet!</h1><p>Din mail-service er klar. Du kan lukke dette vindue.</p><script>window.close()</script>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // --- 3. STATUS TJEK ---
    if (url.pathname === "/status") {
      const token = await env.MAIL_AUTH.get("refresh_token");
      return new Response(JSON.stringify({ loggedIn: !!token }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- 4. GENEREL SEND MAIL (API) ---
    // Dette endpoint kan bruges af ALLE dine projekter
    // Forventer JSON: { "source": "App Navn", "subject": "Emne", "html": "<h1>Indhold</h1>" }
    if (url.pathname === "/send" && request.method === "POST") {
      try {
        const body = await request.json();
        
        // Validering
        if (!body.subject || !body.html) {
             return new Response(JSON.stringify({ error: "Mangler 'subject' eller 'html'" }), { status: 400, headers: corsHeaders });
        }

        const accessToken = await getValidAccessToken(env);
        if (!accessToken) {
          return new Response(JSON.stringify({ error: "Serveren mangler login. Besøg /auth" }), { status: 401, headers: corsHeaders });
        }

        // Hent din egen email adresse (så vi sender FRA dig TIL dig)
        const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const userData = await userRes.json();
        const userEmail = userData.email;

        // Bestem afsender navn
        const sourceApp = body.source || "Mail Service";
        
        // Konstruer email emne og indhold
        const emailSubject = `[${sourceApp}] ${body.subject}`;
        const emailContent = [
          `From: "${sourceApp}" <${userEmail}>`,
          `To: <${userEmail}>`,
          `Subject: ${emailSubject}`,
          `Content-Type: text/html; charset=utf-8`,
          ``,
          body.html
        ].join("\n");

        // Base64 encode til Gmail API
        const raw = btoa(unescape(encodeURIComponent(emailContent)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');

        // Send
        const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ raw: raw })
        });

        const sendData = await sendRes.json();
        if (sendData.error) throw new Error(JSON.stringify(sendData.error));

        return new Response(JSON.stringify({ success: true, id: sendData.id }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

// Hjælper: Håndterer Access Token fornyelse
async function getValidAccessToken(env) {
  let accessToken = await env.MAIL_AUTH.get("access_token");
  if (accessToken) return accessToken;

  const refreshToken = await env.MAIL_AUTH.get("refresh_token");
  if (!refreshToken) return null;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await response.json();
  if (data.access_token) {
    await env.MAIL_AUTH.put("access_token", data.access_token, { expirationTtl: 3500 });
    return data.access_token;
  }
  return null;
}