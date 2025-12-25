export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Session-Id", // Tillad Session-Id header
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- 1. START LOGIN ---
    // Frontend sender et unikt session_id med som parameter
    if (url.pathname === "/auth") {
      const sessionId = url.searchParams.get("session_id");
      
      if (!sessionId) {
        return new Response("Mangler session_id parameter", { status: 400 });
      }

      const scope = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.profile";
      
      // Vi sender sessionId med i "state" parameteren. Google sender den uændret tilbage til os efter login.
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${env.CLIENT_ID}&redirect_uri=${env.REDIRECT_URI}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${sessionId}`;
      
      return Response.redirect(authUrl, 302);
    }

    // --- 2. CALLBACK FRA GOOGLE ---
    if (url.pathname === "/oauth2callback") {
      const code = url.searchParams.get("code");
      const sessionId = url.searchParams.get("state"); // Her får vi ID'et tilbage

      if (!code || !sessionId) return new Response("Fejl: Mangler kode eller session ID", { status: 400 });

      // Byt kode til tokens
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

      if (tokens.error) return new Response("Google Fejl: " + JSON.stringify(tokens), { status: 400 });

      // GEM TOKENS SPECIFIKT TIL DENNE BRUGER (Prefix med session ID)
      await env.MAIL_AUTH.put(`${sessionId}_refresh`, tokens.refresh_token);
      
      if(tokens.access_token) {
        await env.MAIL_AUTH.put(`${sessionId}_access`, tokens.access_token, { expirationTtl: 3500 }); 
      }

      return new Response("<h1>Login Succes!</h1><p>Du er nu forbundet. Luk dette vindue.</p><script>window.close()</script>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // --- 3. STATUS TJEK ---
    // Frontend sender session_id for at tjekke om DENNE bruger er logget ind
    if (url.pathname === "/status") {
      const sessionId = url.searchParams.get("session_id");
      if (!sessionId) return new Response(JSON.stringify({ loggedIn: false }), { headers: corsHeaders });

      const token = await env.MAIL_AUTH.get(`${sessionId}_refresh`);
      return new Response(JSON.stringify({ loggedIn: !!token }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- 4. SEND MAIL ---
    if (url.pathname === "/send" && request.method === "POST") {
      try {
        const body = await request.json();
        const sessionId = body.session_id; // Frontend skal sende dette ID med

        if (!sessionId) return new Response(JSON.stringify({ error: "Mangler session_id" }), { status: 400, headers: corsHeaders });
        if (!body.subject || !body.html) return new Response(JSON.stringify({ error: "Mangler indhold" }), { status: 400, headers: corsHeaders });

        // Hent token for DENNE bruger
        const accessToken = await getValidAccessToken(env, sessionId);

        if (!accessToken) {
          return new Response(JSON.stringify({ error: "Login udløbet eller mangler" }), { status: 401, headers: corsHeaders });
        }

        // Hent brugerens email
        const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const userData = await userRes.json();
        const userEmail = userData.email;

        // Send mail
        const sourceApp = body.source || "DBA Monitor";
        const emailContent = [
          `From: "${sourceApp}" <${userEmail}>`,
          `To: <${userEmail}>`,
          `Subject: [${sourceApp}] ${body.subject}`,
          `Content-Type: text/html; charset=utf-8`,
          ``,
          body.html
        ].join("\n");

        const raw = btoa(unescape(encodeURIComponent(emailContent)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');

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

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

// Hjælper: Henter token baseret på Session ID
async function getValidAccessToken(env, sessionId) {
  // Prøv at finde access token først
  let accessToken = await env.MAIL_AUTH.get(`${sessionId}_access`);
  if (accessToken) return accessToken;

  // Hvis ikke, brug refresh token
  const refreshToken = await env.MAIL_AUTH.get(`${sessionId}_refresh`);
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
    // Gem ny access token
    await env.MAIL_AUTH.put(`${sessionId}_access`, data.access_token, { expirationTtl: 3500 });
    return data.access_token;
  }
  return null;
}