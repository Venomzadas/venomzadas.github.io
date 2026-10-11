// (No Supabase esta função está publicada com o nome "clever-processor".)
// Edge Function: copia os cargos do Discord da BLUE CASH para o app (nome, cor, ícone/emoji, ordem) e atualiza nome e foto.
//  - Sem corpo: sincroniza a PESSOA que chamou (identidade vem do login).
//  - Corpo {"all":true}: sincroniza TODOS os membros (só Diretoria/EGO).
// Segredos (Supabase → Edge Functions → Secrets): DISCORD_BOT_TOKEN, DISCORD_GUILD_ID.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const DC = "https://discord.com/api/v10";
const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const bot = Deno.env.get("DISCORD_BOT_TOKEN")!, guild = Deno.env.get("DISCORD_GUILD_ID")!;
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: { user } } = await admin.auth.getUser(jwt);           // identidade vem do login, não do cliente
    if (!user) return json({ error: "não autenticado" }, 401);
    let body: any = {}; try { body = await req.json(); } catch { /* sem corpo */ }
    const H = { Authorization: `Bot ${bot}` };

    // 1) espelha TODOS os cargos do servidor (menos @everyone e cargos de bots)
    const rr = await fetch(`${DC}/guilds/${guild}/roles`, { headers: H });
    if (!rr.ok) return json({ error: `discord roles ${rr.status}` }, 502);
    const all: any[] = await rr.json();
    const rows = all.filter((r) => r.id !== guild && !r.managed).map((r) => {
      const c1 = r.colors?.primary_color ?? r.color, c2 = r.colors?.secondary_color ?? null;
      return {
        key: `dc_${r.id}`, discord_role_id: r.id, name: r.name, priority: r.position,
        color: c1 ? hex(c1) : "#99AAB5", color2: c2 ? hex(c2) : null,
        icon_url: r.icon ? `https://cdn.discordapp.com/role-icons/${r.id}/${r.icon}.png?size=64` : null,
        emoji: r.unicode_emoji ?? null,
      };
    });
    if (rows.length) {
      const { error } = await admin.from("roles").upsert(rows, { onConflict: "discord_role_id" });
      if (error) return json({ error: error.message }, 500);
      await admin.from("roles").delete().not("discord_role_id", "is", null)
        .not("discord_role_id", "in", `(${rows.map((r) => r.discord_role_id).join(",")})`);
    }
    const { data: dRoles } = await admin.from("roles").select("id, discord_role_id").not("discord_role_id", "is", null);
    const idByDiscord = new Map((dRoles ?? []).map((r) => [r.discord_role_id, r.id]));
    const dIds = new Set((dRoles ?? []).map((r) => r.id));

    // 2) uma pessoa: cargos + nome + foto
    async function syncUser(uid: string, did: string, custom: boolean): Promise<string[]> {
      const mr = await fetch(`${DC}/guilds/${guild}/members/${did}`, { headers: H });
      if (mr.status !== 404 && !mr.ok) throw new Error(`discord ${mr.status}`);
      const member = mr.status === 404 ? null : await mr.json();
      const memberRoles: string[] = member?.roles ?? [];

      let du = member?.user;
      if (!du) { const ur = await fetch(`${DC}/users/${did}`, { headers: H }); if (ur.ok) du = await ur.json(); }
      if (du) {
        const name = member?.nick ?? du.global_name ?? du.username;
        const avatar = member?.avatar
          ? `https://cdn.discordapp.com/guilds/${guild}/users/${did}/avatars/${member.avatar}.png?size=256`
          : du.avatar ? `https://cdn.discordapp.com/avatars/${did}/${du.avatar}.png?size=256`
          : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(did) >> 22n) % 6n)}.png`;
        const patch: Record<string, string> = { display_name: String(name).slice(0, 40) };
        if (!custom) patch.avatar_url = avatar;               // foto própria do usuário é respeitada
        await admin.from("profiles").update(patch).eq("id", uid);
      }

      const want = new Set(memberRoles.map((id) => idByDiscord.get(id)).filter(Boolean) as string[]);
      const { data: have } = await admin.from("user_roles").select("role_id").eq("user_id", uid);
      const haveIds = new Set((have ?? []).map((x) => x.role_id));
      const remove = [...haveIds].filter((id) => dIds.has(id) && !want.has(id));
      const add = [...want].filter((id) => !haveIds.has(id));
      if (remove.length) await admin.from("user_roles").delete().eq("user_id", uid).in("role_id", remove);
      if (add.length) await admin.from("user_roles").insert(add.map((role_id) => ({ user_id: uid, role_id })));
      return all.filter((r) => memberRoles.includes(r.id)).map((r) => r.name);
    }

    // 3) todos os membros (Diretoria/EGO)
    if (body.all) {
      const { data: me } = await admin.from("profiles").select("role").eq("id", user.id).single();
      if (!me || !["director", "ego"].includes(me.role)) return json({ error: "somente a Diretoria" }, 403);
      const { data: ps } = await admin.from("profiles").select("id, discord_id, avatar_custom").not("discord_id", "is", null).limit(300);
      let ok = 0; const errors: string[] = [];
      for (const p of ps ?? []) {
        try { await syncUser(p.id, p.discord_id, !!p.avatar_custom); ok++; } catch (e) { errors.push(`${p.discord_id}: ${e}`); }
        await new Promise((r) => setTimeout(r, 150));          // respeita o limite de requisições do Discord
      }
      return json({ ok: true, synced: ok, errors });
    }

    // 4) só a pessoa que chamou
    const { data: prof } = await admin.from("profiles").select("discord_id, avatar_custom").eq("id", user.id).single();
    if (!prof?.discord_id) return json({ error: "perfil sem discord_id" }, 400);
    return json({ ok: true, roles: await syncUser(user.id, prof.discord_id, !!prof.avatar_custom) });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
