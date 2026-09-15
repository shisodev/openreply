import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { checkApiKey } from "@/lib/api-key";
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

const patchSchema = z.object({
  keywords: z.array(z.string().min(1).max(50)).min(1).max(10).optional(),
  dmMessage: z.string().min(1).max(1000).optional(),
  linkUrl: z.union([z.string().url(), z.literal("")]).optional().nullable(),
  linkLabel: z.string().max(20).optional().nullable(),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  requireFollow: z.boolean().optional(),
  isActive: z.boolean().optional(),
  wholeWordMatch: z.boolean().optional(),
  name: z.string().min(1).max(100).optional(),
});

async function achar(id: string) {
  return prisma.automation.findUnique({
    where: { id },
    include: { trackedLinks: true, instagramAccount: { select: { id: true, username: true } } },
  });
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = checkApiKey(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const a = await achar(id);
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
    trackedUrls: a.trackedLinks.map((l) => buildTrackedUrl(l.slug)),
  });
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = checkApiKey(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const atual = await achar(id);
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
      await tx.trackedLink.deleteMany({ where: { automationId: id } });
    }
    return tx.automation.update({
      where: { id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.keywords !== undefined ? { keywords: d.keywords } : {}),
        ...(d.dmMessage !== undefined ? { dmMessage: d.dmMessage } : {}),
        ...(d.linkLabel !== undefined ? { linkButtonLabel: d.linkLabel || null } : {}),
        ...(d.requireFollow !== undefined ? { requireFollow: d.requireFollow } : {}),
        ...(d.isActive !== undefined ? { isActive: d.isActive } : {}),
        ...(d.wholeWordMatch !== undefined ? { wholeWordMatch: d.wholeWordMatch } : {}),
        ...(publicReply !== undefined
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
  const auth = checkApiKey(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const a = await prisma.automation.findUnique({ where: { id }, select: { id: true } });
  if (!a) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

  await prisma.automation.delete({ where: { id } });
  return NextResponse.json({ ok: true, id });
}
