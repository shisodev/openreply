import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { checkApiKey, escopo } from "@/lib/api-key";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { buildReportUrl, generateReportShareSlug } from "@/lib/reports/share";
import { buildTrackedUrl } from "@/lib/tracking/message";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";

/**
 * Create a campaign from another system, without a browser session.
 *
 * Written for the publish-then-automate flow: a video tool hands a reel to its
 * scheduler and, in the same breath, asks for the comment-to-DM campaign that
 * should run on it. The reel is not on Instagram yet at that moment, so the
 * caller sends the CAPTION it used and the campaign waits for the reel that
 * carries it (see lib/automation/attach-next-reel.ts).
 *
 * The payload names its target — by workspace or by connected account, whose row
 * carries the workspace it belongs to. Naming nothing is allowed only while
 * there is exactly ONE connected account in the instance, where there is nothing
 * to guess; with two it answers 409 instead of filing the campaign under
 * someone else's workspace.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    // alvo: qualquer um destes, ou nenhum se a instância tiver uma conta só
    workspaceId: z.string().min(1).optional().nullable(),
    instagramAccountId: z.string().min(1).optional().nullable(),
    instagramId: z.string().min(1).optional().nullable(),
    instagramUsername: z.string().min(1).optional().nullable(),

    name: z.string().min(1).max(100).optional(),
    goal: z.string().min(1).max(120).optional().nullable(),
    // `min(1)` saiu: com `matchAnyWord` a campanha responde a QUALQUER comentário e não há
    // palavra-chave pra exigir. O refine no fim garante que uma das duas coisas exista.
    keywords: z.array(z.string().min(1).max(50)).max(10).optional().default([]),
    matchAnyWord: z.boolean().optional().default(false),
    matchAnyPost: z.boolean().optional().default(false),
    dmMessage: z.string().min(1).max(1000),
    // Which reel: an id if the caller already knows it, otherwise the caption
    // it published with, otherwise plain "my next reel".
    postId: z.string().min(1).optional().nullable(),
    bindCaption: z.string().min(1).max(2200).optional().nullable(),

    linkUrl: z.union([z.string().url(), z.literal("")]).optional().nullable(),
    linkLabel: z.string().max(20).optional().nullable(),
    // segundo link, que vira um segundo botão no direct
    secondaryLinkUrl: z.union([z.string().url(), z.literal("")]).optional().nullable(),
    secondaryLinkLabel: z.string().max(20).optional().nullable(),
    publicReplyMessage: z.string().max(1000).optional().nullable(),
    // Várias respostas públicas em RODÍZIO. Repetir a mesma frase embaixo de todo comentário é
    // o que o Instagram lê como spam — o motor já sabe alternar, só não havia como mandar a lista.
    publicReplyMessages: z.array(z.string().max(1000)).max(10).optional().default([]),
    requireFollow: z.boolean().optional().default(false),
    followPromptMessage: z.string().max(1000).optional().nullable(),
    followPromptButtonLabel: z.string().max(20).optional().nullable(),
    // DM de abertura: a primeira mensagem, com botão, antes de entregar o link
    openingDmEnabled: z.boolean().optional().default(false),
    openingDmMessage: z.string().max(1000).optional().nullable(),
    openingDmButtonLabel: z.string().max(64).optional().nullable(),
    // segunda mensagem, minutos depois. Teto de 24h porque é a janela da Meta.
    followUpEnabled: z.boolean().optional().default(false),
    followUpMessage: z.string().max(1000).optional().nullable(),
    followUpDelayMinutes: z.number().int().min(0).max(1440).optional().default(0),
    dmTriggerEnabled: z.boolean().optional().default(false),
    wholeWordMatch: z.boolean().optional().default(true),
    isActive: z.boolean().optional().default(true),
  })
  .refine((d) => d.matchAnyWord || d.keywords.length >= 1, {
    message: "Mande ao menos uma palavra-chave, ou ligue matchAnyWord",
    path: ["keywords"],
  })
  .refine(
    (d) => !d.openingDmEnabled || (Boolean(d.openingDmMessage?.trim()) && Boolean(d.openingDmButtonLabel?.trim())),
    { message: "A DM de abertura precisa de mensagem E rótulo de botão", path: ["openingDmMessage"] }
  )
  .refine((d) => !d.followUpEnabled || Boolean(d.followUpMessage?.trim()), {
    message: "O follow-up precisa de mensagem", path: ["followUpMessage"],
  });

export async function POST(request: NextRequest) {
  const auth = await checkApiKey(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const d = parsed.data;

  // ---- resolve the Instagram account (and through it, the workspace) ----
  let account = null as Awaited<ReturnType<typeof getWorkspaceInstagramAccount>>;
  const trava = escopo(auth.workspaceId);   // chave de workspace nunca enxerga fora dele
  if (d.instagramAccountId) {
    account = await prisma.instagramAccount.findFirst({ where: { id: d.instagramAccountId, ...trava } });
  } else if (d.instagramId) {
    account = await prisma.instagramAccount.findFirst({ where: { instagramId: d.instagramId, ...trava } });
  } else if (d.instagramUsername) {
    // username is not unique in the schema — two matches is ambiguous, not a guess to make
    const hits = await prisma.instagramAccount.findMany({
      where: { username: d.instagramUsername, ...trava },
      take: 2,
    });
    if (hits.length > 1) {
      return NextResponse.json(
        { error: "More than one account with that username — send instagramAccountId" },
        { status: 409 }
      );
    }
    account = hits[0] ?? null;
  } else if (d.workspaceId) {
    // com chave de workspace, pedir OUTRO workspace no corpo não vale
    if (auth.workspaceId && auth.workspaceId !== d.workspaceId) {
      return NextResponse.json({ error: "No connected Instagram account for that target" }, { status: 404 });
    }
    account = await getWorkspaceInstagramAccount(d.workspaceId, null);
  } else if (auth.workspaceId) {
    account = await getWorkspaceInstagramAccount(auth.workspaceId, null);
  } else {
    // Sem alvo no payload: só resolve quando NÃO HÁ o que adivinhar — exatamente uma
    // conta conectada na instância inteira. Com duas, responde 409 pedindo o alvo, em
    // vez de arquivar a campanha na conta de outro workspace.
    const todas = await prisma.instagramAccount.findMany({ take: 2 });
    if (todas.length > 1) {
      return NextResponse.json(
        { error: "More than one connected account — send instagramAccountId" },
        { status: 409 }
      );
    }
    account = todas[0] ?? null;
  }

  // workspaceId sent alongside an account identifier is a RESTRICTION, and a
  // mismatch answers 404 rather than 403 — otherwise this route becomes a probe
  // for which accounts exist in other tenants.
  if (account && d.workspaceId && account.workspaceId !== d.workspaceId) account = null;
  if (!account) {
    return NextResponse.json(
      { error: "No connected Instagram account for that target" },
      { status: 404 }
    );
  }

  const workspaceId = account.workspaceId;
  // ⚠️ `matchAnyPost` responde em QUALQUER post — não é "espere o próximo reel". Com o
  // pendingNextReel ligado junto, a campanha entrava na fila do cron e CONSUMIA o reel que era
  // de outra campanha, deixando a outra órfã pra sempre.
  const pendingNextReel = !d.postId && !d.matchAnyPost;

  const linkCreates = [
    ...(d.linkUrl
      ? [{ workspaceId, slug: generateTrackedLinkSlug(), label: "Primary campaign link", destinationUrl: d.linkUrl }]
      : []),
    ...(d.secondaryLinkUrl
      // ⚠️ o rótulo do 2º botão mora AQUI, no label do link — não existe `secondaryButtonLabel`
      // no model Automation. O motor (lib/queue/dm-worker.ts:102) usa primaryLabel no 1º botão e
      // `link.label` do 2º em diante, com teto de 3 botões que é o limite da Meta.
      ? [{ workspaceId, slug: generateTrackedLinkSlug(), label: d.secondaryLinkLabel?.trim() || "Link 2", destinationUrl: d.secondaryLinkUrl }]
      : []),
  ];

  // Uma resposta pública só, ou uma lista em rodízio. Quem manda a lista manda a lista; quem manda
  // a frase única continua funcionando igual (é o que o Framely fazia até aqui).
  const respostasPublicas = (d.publicReplyMessages || []).map((m) => m.trim()).filter(Boolean);
  const publicReply = d.publicReplyMessage?.trim() || respostasPublicas[0] || "";
  const listaPublicas = respostasPublicas.length ? respostasPublicas : publicReply ? [publicReply] : [];

  const automation = await prisma.automation.create({
    data: {
      name: d.name?.trim() || `API · ${new Date().toISOString().slice(0, 10)}`,
      goal: d.goal?.trim() || null,
      postId: d.postId ?? null,
      pendingNextReel,
      bindCaption: pendingNextReel ? d.bindCaption?.trim() || null : null,
      matchAnyPost: d.matchAnyPost,
      keywords: d.keywords,
      matchAnyWord: d.matchAnyWord,
      dmTriggerEnabled: d.dmTriggerEnabled,
      dmMessage: d.dmMessage,
      linkButtonLabel: d.linkLabel?.trim() || null,
      openingDmEnabled: d.openingDmEnabled,
      openingDmMessage: d.openingDmEnabled ? d.openingDmMessage?.trim() || null : null,
      openingDmButtonLabel: d.openingDmEnabled ? d.openingDmButtonLabel?.trim() || null : null,
      followUpEnabled: d.followUpEnabled,
      followUpMessage: d.followUpEnabled ? d.followUpMessage?.trim() || null : null,
      followUpDelayMinutes: d.followUpDelayMinutes,
      requireFollow: d.requireFollow,
      followPromptMessage: d.requireFollow ? d.followPromptMessage?.trim() || null : null,
      followPromptButtonLabel: d.requireFollow ? d.followPromptButtonLabel?.trim() || null : null,
      publicReplyEnabled: listaPublicas.length > 0,
      publicReplyMessage: publicReply || null,
      publicReplyMessages: listaPublicas,
      isActive: d.isActive,
      wholeWordMatch: d.wholeWordMatch,
      workspaceId,
      instagramAccountId: account.id,
      reportShareSlug: generateReportShareSlug(),
      ...(linkCreates.length > 0 ? { trackedLinks: { create: linkCreates } } : {}),
    },
    include: { trackedLinks: true },
  });

  return NextResponse.json({
    id: automation.id,
    postId: automation.postId,
    pendingNextReel: automation.pendingNextReel,
    account: { id: account.id, username: account.username },
    reportUrl: automation.reportShareSlug ? buildReportUrl(automation.reportShareSlug) : null,
    trackedUrls: automation.trackedLinks.map((l) => buildTrackedUrl(l.slug)),
    // o link RASTREADO não diz nada pra quem configurou ("/r/abc123"). Devolver junto o destino
    // real deixa a tela mostrar o wa.me que a pessoa digitou, que é o que ela reconhece.
    links: automation.trackedLinks.map((l) => ({
      trackedUrl: buildTrackedUrl(l.slug),
      destinationUrl: l.destinationUrl,
      label: l.label,
    })),
  });
}
