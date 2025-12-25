export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Session-Id",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- 1. START LOGIN ---
    if (url.pathname === "/auth") {
      const sessionId = url.searchParams.get("session_id");
      if (!sessionId) return new Response("Mangler session_id", { status: 400 });

      // RETTELSE HER: Tilføjet 'userinfo.email' så vi kan se din adresse
      const scope = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email";
      
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${env.CLIENT_ID}&redirect_uri=${env.REDIRECT_URI}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${sessionId}`;
      
      return Response.redirect(authUrl, 302);
    }

    // --- 2. CALLBACK ---
    if (url.pathname === "/oauth2callback") {
      const code = url.searchParams.get("code");
      const sessionId = url.searchParams.get("state");

      if (!code || !sessionId) return new Response("Fejl: Mangler data", { status: 400 });

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

      await env.MAIL_AUTH.put(`${sessionId}_refresh`, tokens.refresh_token);
      if(tokens.access_token) {
        await env.MAIL_AUTH.put(`${sessionId}_access`, tokens.access_token, { expirationTtl: 3500 }); 
      }

      return new Response("<h1>Login Succes!</h1><p>Luk dette vindue og prøv igen.</p><script>window.close()</script>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // --- 3. STATUS ---
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
        const sessionId = body.session_id;

        if (!sessionId) return new Response(JSON.stringify({ error: "Mangler session_id" }), { status: 400, headers: corsHeaders });

        const accessToken = await getValidAccessToken(env, sessionId);
        if (!accessToken) return new Response(JSON.stringify({ error: "Login udløbet" }), { status: 401, headers: corsHeaders });

        // Hent brugerens email
        const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        
        if (!userRes.ok) throw new Error("Kunne ikke hente brugerinfo fra Google");
        
        const userData = await userRes.json();
        const userEmail = userData.email; // Denne var 'undefined' før!

        if (!userEmail) throw new Error("Kunne ikke finde din email-adresse i Google profilen");

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

async function getValidAccessToken(env, sessionId) {
  let accessToken = await env.MAIL_AUTH.get(`${sessionId}_access`);
  if (accessToken) return accessToken;

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
    await env.MAIL_AUTH.put(`${sessionId}_access`, data.access_token, { expirationTtl: 3500 });
    return data.access_token;
  }
  return null;
}