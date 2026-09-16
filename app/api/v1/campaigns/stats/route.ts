import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { checkApiKey, escopo } from "@/lib/api-key";

/**
 * Numbers per campaign, for a dashboard that lives in another system.
 *
 * Counts DMs actually sent and link clicks — the two figures that tell the
 * caller whether the clip it published is producing conversations.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await checkApiKey(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const ids = (new URL(request.url).searchParams.get("ids") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
  if (!ids.length) return NextResponse.json({ stats: {} });

  const campanhasPermitidas = await prisma.automation.findMany({
    where: { id: { in: ids }, ...escopo(auth.workspaceId) },
    select: { id: true },
  });
  const permitidos = campanhasPermitidas.map((c) => c.id);
  if (!permitidos.length) return NextResponse.json({ stats: {} });

  const [dms, cliques, campanhas] = await Promise.all([
    prisma.dmLog.groupBy({
      by: ["automationId"],
      where: { automationId: { in: permitidos }, status: "SENT" },
      _count: { _all: true },
    }),
    prisma.linkClick.groupBy({
      by: ["automationId"],
      where: { automationId: { in: permitidos } },
      _count: { _all: true },
    }),
    prisma.automation.findMany({
      // o escopo entra AQUI: os group-by abaixo só somam o que sobrar desta lista
      where: { id: { in: permitidos } },
      select: { id: true, postId: true, pendingNextReel: true, isActive: true },
    }),
  ]);

  // ⚠️ `ativa` funde DUAS coisas (ligada E já casada com o reel), então quem lê de fora não
  // consegue distinguir "pausada" de "esperando o reel" — e o botão de RETOMAR, que depende
  // dessa distinção, ficava inalcançável pra campanha pausada antes de casar.
  const stats: Record<string, { dms: number; cliques: number; ativa: boolean; ligada: boolean; esperandoReel: boolean; postId: string | null }> = {};
  for (const c of campanhas) {
    stats[c.id] = { dms: 0, cliques: 0, ativa: c.isActive && !c.pendingNextReel, ligada: c.isActive, esperandoReel: c.pendingNextReel, postId: c.postId };
  }
  for (const r of dms) if (stats[r.automationId]) stats[r.automationId].dms = r._count._all;
  for (const r of cliques) if (stats[r.automationId]) stats[r.automationId].cliques = r._count._all;

  return NextResponse.json({ stats });
}
