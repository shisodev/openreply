import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { checkApiKey, escopo } from "@/lib/api-key";

/**
 * Connection test for an external system.
 *
 * It exists so the other side can say "connected ✓" honestly: a key that only
 * gets checked when the first real campaign is created fails at the worst
 * moment — after a reel is already published.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // O try cobre TAMBÉM a checagem da chave: um erro ali (banco fora do ar, coluna faltando numa
  // migração pendente) virava 500 de corpo vazio, que não diz nada a quem está ligando o serviço.
  try {
    const auth = await checkApiKey(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    // chave de workspace enxerga só as contas DELE; a chave da instância enxerga todas
    const accounts = await prisma.instagramAccount.findMany({
      where: escopo(auth.workspaceId),
      select: {
        id: true, instagramId: true, username: true, workspaceId: true,
        // Saúde da conexão. Sem isto o ping respondia "ok" com o token do Instagram prestes a
        // vencer — e quando vence, TODA campanha para em silêncio, sem nada na tela de fora.
        provider: true, tokenExpiresAt: true, webhookSubscribed: true, connectedAt: true,
      },
      orderBy: { connectedAt: "desc" },
      take: 25,
    });

    const agora = Date.now();
    return NextResponse.json({
      ok: true,
      accounts: accounts.map((a) => ({
        id: a.id,
        username: a.username,
        instagramId: a.instagramId,
        workspaceId: a.workspaceId,
        provider: a.provider,
        webhookSubscribed: a.webhookSubscribed,
        tokenExpiresAt: a.tokenExpiresAt,
        // dias que faltam pro token vencer (null quando o provedor cuida da renovação e não
        // informa validade — é o caso do Zernio). Negativo = já venceu.
        tokenDiasRestantes:
          a.tokenExpiresAt == null
            ? null
            : Math.floor((a.tokenExpiresAt.getTime() - agora) / 86400000),
      })),
    });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    console.error("[api/v1/ping]", msg);
    return NextResponse.json({ error: msg.slice(0, 400) }, { status: 500 });
  }
}
