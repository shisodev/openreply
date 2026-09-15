import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { checkApiKey } from "@/lib/api-key";
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
    keywords: z.array(z.string().min(1).max(50)).min(1).max(10),
    dmMessage: z.string().min(1).max(1000),
    // Which reel: an id if the caller already knows it, otherwise the caption
    // it published with, otherwise plain "my next reel".
    postId: z.string().min(1).optional().nullable(),
    bindCaption: z.string().min(1).max(2200).optional().nullable(),

    linkUrl: z.union([z.string().url(), z.literal("")]).optional().nullable(),
    linkLabel: z.string().max(20).optional().nullable(),
    publicReplyMessage: z.string().max(1000).optional().nullable(),
    requireFollow: z.boolean().optional().default(false),
    followPromptMessage: z.string().max(1000).optional().nullable(),
    dmTriggerEnabled: z.boolean().optional().default(false),
    wholeWordMatch: z.boolean().optional().default(true),
    isActive: z.boolean().optional().default(true),
  });

export async function POST(request: NextRequest) {
  const auth = checkApiKey(request);
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
  if (d.instagramAccountId) {
    account = await prisma.instagramAccount.findUnique({ where: { id: d.instagramAccountId } });
  } else if (d.instagramId) {
    account = await prisma.instagramAccount.findUnique({ where: { instagramId: d.instagramId } });
  } else if (d.instagramUsername) {
    // username is not unique in the schema — two matches is ambiguous, not a guess to make
    const hits = await prisma.instagramAccount.findMany({
      where: { username: d.instagramUsername },
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
    account = await getWorkspaceInstagramAccount(d.workspaceId, null);
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
  const pendingNextReel = !d.postId;

  const linkCreates = d.linkUrl
    ? [
        {
          workspaceId,
          slug: generateTrackedLinkSlug(),
          label: "Primary campaign link",
          destinationUrl: d.linkUrl,
        },
      ]
    : [];

  const publicReply = d.publicReplyMessage?.trim() || "";

  const automation = await prisma.automation.create({
    data: {
      name: d.name?.trim() || `API · ${new Date().toISOString().slice(0, 10)}`,
      postId: d.postId ?? null,
      pendingNextReel,
      bindCaption: pendingNextReel ? d.bindCaption?.trim() || null : null,
      matchAnyPost: false,
      keywords: d.keywords,
      matchAnyWord: false,
      dmTriggerEnabled: d.dmTriggerEnabled,
      dmMessage: d.dmMessage,
      linkButtonLabel: d.linkLabel?.trim() || null,
      requireFollow: d.requireFollow,
      followPromptMessage: d.requireFollow ? d.followPromptMessage?.trim() || null : null,
      publicReplyEnabled: Boolean(publicReply),
      publicReplyMessage: publicReply || null,
      publicReplyMessages: publicReply ? [publicReply] : [],
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
  });
}
