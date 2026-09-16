import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { checkApiKey, escopo } from "@/lib/api-key";
import { DmStatus } from "@/app/generated/prisma/client";

/**
 * Quem recebeu o direct, quem não recebeu, e por quê — para outro sistema, sem sessão.
 *
 * Existe porque sem isto o número é um beco sem saída: o painel de fora mostra "12 directs"
 * e não tem como responder "e o fulano recebeu?" nem "por que aquele falhou?". O erro de
 * ENTREGA (fora da janela de 24h, permissão retirada, token vencido) vive só aqui — a rota
 * de campanha só conhece erro de CRIAÇÃO.
 *
 * Espelha app/api/logs/route.ts, trocando a sessão do navegador pela chave de API e
 * aplicando `escopo()` — com uma chave de workspace, log de outro cliente não existe.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await checkApiKey(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const q = request.nextUrl.searchParams;
  const page = Math.max(1, Number.parseInt(q.get("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(q.get("limit") ?? "50", 10) || 50));
  const status = q.get("status");
  const campaignId = q.get("campaignId");
  const instagramAccountId = q.get("instagramAccountId");

  const statusValido =
    status && (Object.values(DmStatus) as string[]).includes(status)
      ? (status as DmStatus)
      : null;

  const where = {
    ...escopo(auth.workspaceId),
    ...(statusValido ? { status: statusValido } : {}),
    ...(campaignId ? { automationId: campaignId } : {}),
    ...(instagramAccountId && instagramAccountId !== "all" ? { instagramAccountId } : {}),
  };

  const [logs, total] = await Promise.all([
    prisma.dmLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        automationId: true,
        commenterName: true,
        commentText: true,
        matchedKeyword: true,
        status: true,
        attempts: true,
        dmSentAt: true,
        errorMessage: true,
        // "não confirmado" não é sucesso nem falha: a Meta respondeu de forma ambígua e o
        // robô se recusa a reenviar sozinho pra não mandar duas vezes. Quem lê o log precisa
        // saber disso, senão conta como entregue.
        dmDeliveryUnconfirmed: true,
        publicReplySentAt: true,
        publicReplyError: true,
        createdAt: true,
        automation: { select: { name: true } },
        instagramAccount: { select: { username: true } },
      },
    }),
    prisma.dmLog.count({ where }),
  ]);

  return NextResponse.json({
    logs: logs.map((l) => ({
      id: l.id,
      campaignId: l.automationId,
      campanha: l.automation?.name ?? null,
      conta: l.instagramAccount?.username ?? null,
      quem: l.commenterName,
      comentario: l.commentText,
      palavra: l.matchedKeyword,
      status: l.status,
      tentativas: l.attempts,
      enviadoEm: l.dmSentAt,
      erro: l.errorMessage,
      naoConfirmado: l.dmDeliveryUnconfirmed,
      respostaPublicaEm: l.publicReplySentAt,
      respostaPublicaErro: l.publicReplyError,
      criadoEm: l.createdAt,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}
