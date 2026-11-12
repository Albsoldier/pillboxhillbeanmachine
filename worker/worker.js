// Cloudflare Worker: receives orders, reviews and job applications from the website
// and posts them to Discord.
// Set these in the Worker's settings (Settings > Variables and Secrets):
//   DISCORD_WEBHOOK  (secret)  your Discord webhook URL
//   ALLOWED_ORIGIN   (text)    your site, e.g. https://yourname.github.io
//   PING             (text, optional) who to notify about orders, e.g. <@&123456789012345678> or @here
//   APP_PING         (text, optional) who to notify about job applications, e.g. your management role
//   APP_WEBHOOK      (secret, optional) a separate webhook for applications (e.g. a private
//                                       management channel). Falls back to DISCORD_WEBHOOK.

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    if (request.headers.get("Origin") !== env.ALLOWED_ORIGIN)
      return new Response("Forbidden", { status: 403 });

    let o;
    try { o = await request.json(); } catch { return new Response("Bad request", { status: 400, headers: cors }); }

    if (o.website) return new Response("ok", { headers: cors }); // honeypot: silently drop bots
    const clean = (s, max = 300) => String(s || "").replace(/[@`]/g, "").trim().slice(0, max);

    // Sends a message to Discord. The ping text only ever comes from your own settings,
    // never from customer input.
    const post = async (webhook, ping, embed) => {
      const r = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: ping || undefined,
          allowed_mentions: ping ? { parse: ["users", "roles", "everyone"] } : { parse: [] },
          embeds: [{ ...embed, timestamp: new Date().toISOString() }],
        }),
      });
      return r.ok;
    };

    // ---------- Reviews ----------
    if (o.type === "review") {
      const rating = Math.min(Math.max(parseInt(o.rating) || 0, 1), 5);
      const text = clean(o.comment, 400);
      if (!o.name || !text) return new Response("Bad request", { status: 400, headers: cors });
      const ok = await post(env.DISCORD_WEBHOOK, null, {
        title: `New review from ${clean(o.name)}`,
        color: 0xc48a5a,
        description: "★".repeat(rating) + "☆".repeat(5 - rating) + `  (${rating}/5)\n\n${text}`,
      });
      return new Response(ok ? "ok" : "Discord error", { status: ok ? 200 : 502, headers: cors });
    }

    // ---------- Job applications ----------
    if (o.type === "application") {
      const name = clean(o.name, 60), discord = clean(o.discord, 40), about = clean(o.about, 800);
      if (!name || !discord || !about) return new Response("Bad request", { status: 400, headers: cors });
      const ok = await post(env.APP_WEBHOOK || env.DISCORD_WEBHOOK, env.APP_PING, {
        title: `New job application: ${clean(o.role, 60) || "Any position"}`,
        color: 0x8da879,
        fields: [
          { name: "Character name", value: name, inline: true },
          { name: "Discord", value: discord, inline: true },
          { name: "Phone", value: clean(o.phone, 30) || "—", inline: true },
          { name: "Availability", value: clean(o.availability, 120) || "—" },
          { name: "About them", value: about },
        ],
      });
      return new Response(ok ? "ok" : "Discord error", { status: ok ? 200 : 502, headers: cors });
    }

    // ---------- Orders ----------
    if (!o.name || !Array.isArray(o.items) || !o.items.length || o.items.length > 30)
      return new Response("Bad request", { status: 400, headers: cors });

    // Use the website's order number if it looks right, otherwise make one here.
    const orderNumber = /^BM-\d{4}-[A-Z0-9]{3}$/.test(String(o.orderNumber || ""))
      ? o.orderNumber
      : "BM-" + new Date().toISOString().slice(5, 10).replace("-", "") + "-" +
        Math.random().toString(36).slice(2, 5).toUpperCase();

    let total = Math.min(Math.max(Number(o.delivery) || 0, 0), 100000);
    const lines = o.items.map(i => {
      const qty = Math.min(Math.max(parseInt(i.qty) || 1, 1), 50);
      const price = Number(i.price) || 0;
      total += qty * price;
      return `${qty} × ${clean(i.name)}`;
    });

    const ok = await post(env.DISCORD_WEBHOOK, env.PING, {
      title: `Order #${orderNumber} from ${clean(o.name)}`,
      color: 0x007a70,
      description: lines.join("\n"),
      fields: [
        { name: "Order number", value: `#${orderNumber}`, inline: true },
        { name: "Total", value: total.toFixed(2), inline: true },
        ...(Number(o.delivery) > 0 ? [{ name: "Delivery fee included", value: Number(o.delivery).toFixed(2), inline: true }] : []),
        ...(o.contact ? [{ name: "Contact", value: clean(o.contact), inline: true }] : []),
        ...(o.note ? [{ name: "Notes", value: clean(o.note) }] : []),
      ],
    });
    if (!ok) return new Response("Discord error", { status: 502, headers: cors });
    // The website shows this number to the customer.
    return new Response(JSON.stringify({ ok: true, orderNumber }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
