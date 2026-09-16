import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { checkApiKey, escopo } from "@/lib/api-key";
import { createInstagramContext, getUserMedia } from "@/lib/instagram/provider";

/**
 * Os posts recentes da conta, pra outro sistema poder OFERECER a escolha do reel.
 *
 * Existe porque sem isto a automação só alcança o que o próprio sistema publicou: o reel que a
 * pessoa postou pelo celular fica de fora — e é justamente o que ela lembra de automatizar
 * depois que o vídeo performou.
 *
 * Funciona nos dois provedores (Meta direto e Zernio) porque getUserMedia já despacha por
 * `context.provider`. Com Zernio o próprio provedor limita a janela de posts recentes.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await checkApiKey(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const pedida = request.nextUrl.searchParams.get("instagramAccountId");
  const limit = Math.min(50, Math.max(1, Number(request.nextUrl.searchParams.get("limit")) || 25));

  // ⚠️ escopo() SEMPRE: com chave de workspace, pedir a conta de outro cliente tem que
  // devolver "não existe", senão esta rota vira um catálogo das contas alheias.
  const account = await prisma.instagramAccount.findFirst({
    where: { ...(pedida ? { id: pedida } : {}), ...escopo(auth.workspaceId) },
    orderBy: { connectedAt: "desc" },
  });
  if (!account) return NextResponse.json({ error: "No connected Instagram account for that target" }, { status: 404 });

  try {
    const context = await createInstagramContext(account);
    const posts = await getUserMedia({ context, limit });
    return NextResponse.json({
      conta: { id: account.id, username: account.username },
      posts: posts.map((p) => ({
        id: p.id,
        legenda: p.caption ?? "",
        permalink: p.permalink ?? null,
        thumb: p.thumbnail_url ?? null,
        tipo: p.media_type ?? null,
        // quem quiser oferecer só reels filtra por aqui — comentário→DM funciona em qualquer
        // post, mas é no reel que o volume acontece
        ehReel: p.media_product_type === "REELS",
        curtidas: p.like_count ?? null,
        comentarios: p.comments_count ?? null,
        em: p.timestamp ?? null,
      })),
    });
  } catch (e) {
    // erro do provedor não pode virar 500 de corpo vazio: quem chama precisa saber se é token
    // vencido, permissão faltando ou instabilidade
    const msg = String((e as Error)?.message || e);
    console.error("[api/v1/posts]", msg);
    return NextResponse.json({ error: msg.slice(0, 400) }, { status: 502 });
  }
}
