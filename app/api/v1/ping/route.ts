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
  const auth = await checkApiKey(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // O chamador JÁ passou pela chave, então devolver o motivo da falha aqui é diagnóstico, não
  // vazamento — e um 500 mudo num ping é exatamente o que faz alguém perder uma tarde.
  try {
    // chave de workspace enxerga só as contas DELE; a chave da instância enxerga todas
    const accounts = await prisma.instagramAccount.findMany({
      where: escopo(auth.workspaceId),
      select: { id: true, instagramId: true, username: true, workspaceId: true },
      orderBy: { connectedAt: "desc" },
      take: 25,
    });

    return NextResponse.json({
      ok: true,
      accounts: accounts.map((a) => ({
        id: a.id,
        username: a.username,
        instagramId: a.instagramId,
        workspaceId: a.workspaceId,
      })),
    });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    console.error("[api/v1/ping]", msg);
    return NextResponse.json({ error: msg.slice(0, 400) }, { status: 500 });
  }
}
