import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { checkApiKey, escopo } from "@/lib/api-key";
import { buildTrackedUrl } from "@/lib/tracking/message";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";

/**
 * Read, change and delete one campaign from another system.
 *
 * Exists so the tool that CREATED the campaign can also run it: pause it, fix a
 * typo in the message, swap the link. Without this the external side is a
 * one-way door — it can start automations it can never correct, and the person
 * has to come to this dashboard for every edit.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Espelha o que o POST aceita. Antes daqui, metade do que o MOTOR já executa não tinha como ser
// corrigido depois de criada a campanha: quem ligava "só entrega o link depois de seguir" ficava
// com o texto padrão em inglês pra sempre, e follow-up/DM de abertura nem existiam pela API.
const patchSchema = z.object({
  keywords: z.array(z.string().min(1).max(50)).max(10).optional(),
  matchAnyWord: z.boolean().optional(),
  matchAnyPost: z.boolean().optional(),
  dmMessage: z.string().min(1).max(1000).optional(),
  goal: z.string().min(1).max(120).optional().nullable(),
  linkUrl: z.union([z.string().url(), z.literal("")]).optional().nullable(),
  linkLabel: z.string().max(20).optional().nullable(),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  publicReplyMessages: z.array(z.string().max(1000)).max(10).optional(),
  requireFollow: z.boolean().optional(),
  followPromptMessage: z.string().max(1000).optional().nullable(),
  followPromptButtonLabel: z.string().max(20).optional().nullable(),
  openingDmEnabled: z.boolean().optional(),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: z.string().max(64).optional().nullable(),
  followUpEnabled: z.boolean().optional(),
  followUpMessage: z.string().max(1000).optional().nullable(),
  followUpDelayMinutes: z.number().int().min(0).max(1440).optional(),
  dmTriggerEnabled: z.boolean().optional(),
  isActive: z.boolean().optional(),
  wholeWordMatch: z.boolean().optional(),
  reportShareEnabled: z.boolean().optional(),
  name: z.string().min(1).max(100).optional(),
});

// ⚠️ findFirst com o escopo da chave, NUNCA findUnique só por id: com uma chave de
// workspace, procurar campanha alheia tem que devolver "não existe" — senão esta rota
// vira leitura, edição e exclusão das campanhas de todos os outros clientes.
async function achar(id: string, workspaceId: string | null) {
  return prisma.automation.findFirst({
    where: { id, ...escopo(workspaceId) },
    include: { trackedLinks: true, instagramAccount: { select: { id: true, username: true } } },
  });
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await checkApiKey(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const a = await achar(id, auth.workspaceId);
  if (!a) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

  return NextResponse.json({
    id: a.id,
    name: a.name,
    keywords: a.keywords,
    dmMessage: a.dmMessage,
    linkLabel: a.linkButtonLabel,
    publicReplyMessage: a.publicReplyMessage,
    requireFollow: a.requireFollow,
    isActive: a.isActive,
    postId: a.postId,
    postUrl: a.postUrl,
    pendingNextReel: a.pendingNextReel,
    bindCaption: a.bindCaption,
    account: a.instagramAccount,
    goal: a.goal,
    matchAnyWord: a.matchAnyWord,
    matchAnyPost: a.matchAnyPost,
    dmTriggerEnabled: a.dmTriggerEnabled,
    wholeWordMatch: a.wholeWordMatch,
    followPromptMessage: a.followPromptMessage,
    followPromptButtonLabel: a.followPromptButtonLabel,
    openingDmEnabled: a.openingDmEnabled,
    openingDmMessage: a.openingDmMessage,
    openingDmButtonLabel: a.openingDmButtonLabel,
    followUpEnabled: a.followUpEnabled,
    followUpMessage: a.followUpMessage,
    followUpDelayMinutes: a.followUpDelayMinutes,
    publicReplyMessages: a.publicReplyMessages,
    trackedUrls: a.trackedLinks.map((l) => buildTrackedUrl(l.slug)),
    // o link RASTREADO ("/r/abc123") não diz nada pra quem configurou. Devolvendo o destino real,
    // a tela mostra o wa.me que a pessoa digitou — que é o que ela reconhece ao editar.
    links: a.trackedLinks.map((l) => ({
      trackedUrl: buildTrackedUrl(l.slug),
      destinationUrl: l.destinationUrl,
      label: l.label,
    })),
  });
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await checkApiKey(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const atual = await achar(id, auth.workspaceId);
  if (!atual) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const d = parsed.data;

  // Swapping the link means a NEW tracked link: rewriting the destination of the
  // old one would silently re-point clicks already counted (and already sent in
  // someone's DM) at a different place.
  const trocaLink = d.linkUrl !== undefined;
  const publicReply = d.publicReplyMessage?.trim();

  const atualizada = await prisma.$transaction(async (tx) => {
    if (trocaLink) {
      await tx.trackedLink.deleteMany({ where: { automationId: id, workspaceId: atual.workspaceId } });
    }
    return tx.automation.update({
      where: { id: atual.id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.goal !== undefined ? { goal: d.goal || null } : {}),
        ...(d.keywords !== undefined ? { keywords: d.keywords } : {}),
        ...(d.matchAnyWord !== undefined ? { matchAnyWord: d.matchAnyWord } : {}),
        ...(d.matchAnyPost !== undefined ? { matchAnyPost: d.matchAnyPost } : {}),
        ...(d.dmMessage !== undefined ? { dmMessage: d.dmMessage } : {}),
        ...(d.linkLabel !== undefined ? { linkButtonLabel: d.linkLabel || null } : {}),
        ...(d.requireFollow !== undefined ? { requireFollow: d.requireFollow } : {}),
        ...(d.followPromptMessage !== undefined ? { followPromptMessage: d.followPromptMessage || null } : {}),
        ...(d.followPromptButtonLabel !== undefined ? { followPromptButtonLabel: d.followPromptButtonLabel || null } : {}),
        ...(d.openingDmEnabled !== undefined ? { openingDmEnabled: d.openingDmEnabled } : {}),
        ...(d.openingDmMessage !== undefined ? { openingDmMessage: d.openingDmMessage || null } : {}),
        ...(d.openingDmButtonLabel !== undefined ? { openingDmButtonLabel: d.openingDmButtonLabel || null } : {}),
        ...(d.followUpEnabled !== undefined ? { followUpEnabled: d.followUpEnabled } : {}),
        ...(d.followUpMessage !== undefined ? { followUpMessage: d.followUpMessage || null } : {}),
        ...(d.followUpDelayMinutes !== undefined ? { followUpDelayMinutes: d.followUpDelayMinutes } : {}),
        ...(d.dmTriggerEnabled !== undefined ? { dmTriggerEnabled: d.dmTriggerEnabled } : {}),
        ...(d.publicReplyMessages !== undefined
          ? {
              publicReplyMessages: d.publicReplyMessages.map((m) => m.trim()).filter(Boolean),
              publicReplyEnabled: d.publicReplyMessages.some((m) => m.trim()),
              publicReplyMessage: d.publicReplyMessages.map((m) => m.trim()).filter(Boolean)[0] || null,
            }
          : {}),
        ...(d.reportShareEnabled !== undefined ? { reportShareEnabled: d.reportShareEnabled } : {}),
        ...(d.isActive !== undefined ? { isActive: d.isActive } : {}),
        ...(d.wholeWordMatch !== undefined ? { wholeWordMatch: d.wholeWordMatch } : {}),
        // a lista (publicReplyMessages) tem precedência: mandar as duas coisas e deixar a frase
        // única apagar o rodízio seria surpresa silenciosa
        ...(publicReply !== undefined && d.publicReplyMessages === undefined
          ? {
              publicReplyEnabled: Boolean(publicReply),
              publicReplyMessage: publicReply || null,
              publicReplyMessages: publicReply ? [publicReply] : [],
            }
          : {}),
        ...(trocaLink && d.linkUrl
          ? {
              trackedLinks: {
                create: [
                  {
                    workspaceId: atual.workspaceId,
                    slug: generateTrackedLinkSlug(),
                    label: "Primary campaign link",
                    destinationUrl: d.linkUrl,
                  },
                ],
              },
            }
          : {}),
      },
      include: { trackedLinks: true },
    });
  });

  return NextResponse.json({
    id: atualizada.id,
    isActive: atualizada.isActive,
    keywords: atualizada.keywords,
    trackedUrls: atualizada.trackedLinks.map((l) => buildTrackedUrl(l.slug)),
  });
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await checkApiKey(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  // deleteMany com escopo: apagar campanha de outro workspace devolve 404, não apaga
  const r = await prisma.automation.deleteMany({ where: { id, ...escopo(auth.workspaceId) } });
  if (!r.count) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  return NextResponse.json({ ok: true, id });
}
