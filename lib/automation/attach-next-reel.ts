import { prisma } from "@/lib/db/client";
import {
  createInstagramContext,
  hasInstagramCredentials,
  getUserMedia,
  type InstagramMedia,
} from "@/lib/instagram/provider";

function isReel(media: InstagramMedia): boolean {
  return media.media_product_type === "REELS";
}

/** Normaliza legenda pra comparar: espaços, caixa e emojis de borda não decidem nada. */
function norm(s: string | null | undefined): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export type AttachNextReelResult = {
  checked: number;
  bound: number;
  failedAccounts: number;
};

/**
 * Bind each pending "next reel" campaign to the reel it belongs to.
 *
 * Two ways to decide which reel is which:
 *
 *  - `bindCaption` — the caption the campaign's creator published with. This is
 *    what an external publishing tool sends: it creates the campaign at the same
 *    moment it hands the video to a scheduler, before the reel exists.
 *  - otherwise, order: the oldest pending campaign takes the oldest new reel.
 *
 * Ordering matters because reels are published in BATCHES. The previous version
 * asked, for every pending campaign, "the earliest reel posted after I was
 * created" — with three campaigns waiting, all three answered the SAME reel and
 * the other two clips silently ended up with no automation at all. A reel is now
 * consumed once: taken by one campaign, invisible to the next.
 */
export async function attachPendingNextReels(): Promise<AttachNextReelResult> {
  const pending = await prisma.automation.findMany({
    where: { pendingNextReel: true },
    include: { instagramAccount: true },
    orderBy: { createdAt: "asc" }, // fila: quem pediu primeiro escolhe primeiro
  });

  // Group by connected account so we fetch each account's media only once.
  const byAccount = new Map<
    string,
    {
      account: (typeof pending)[number]["instagramAccount"];
      automations: typeof pending;
    }
  >();
  for (const automation of pending) {
    const key = automation.instagramAccountId;
    const entry = byAccount.get(key);
    if (entry) entry.automations.push(automation);
    else
      byAccount.set(key, {
        account: automation.instagramAccount,
        automations: [automation],
      });
  }

  let checked = 0;
  let bound = 0;
  const failures: string[] = [];

  for (const { account, automations } of byAccount.values()) {
    checked += automations.length;
    if (!account || !hasInstagramCredentials(account)) continue;

    let reels: InstagramMedia[];
    try {
      const context = await createInstagramContext(account);
      const media = await getUserMedia({ context, limit: 25 });
      reels = media
        .filter(isReel)
        .sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
    } catch (error) {
      failures.push(account.id);
      console.error("[attach-next-reel] media fetch failed", account.id, error);
      continue;
    }

    // Reels already spoken for — by a campaign bound in an earlier run, or by one
    // bound a few lines below. Without this the same reel is handed out twice.
    const taken = new Set(
      (
        await prisma.automation.findMany({
          where: { instagramAccountId: account.id, postId: { not: null } },
          select: { postId: true },
        })
      )
        .map((a) => a.postId)
        .filter((id): id is string => Boolean(id))
    );

    // Caption-matched campaigns go first: they know exactly which reel is theirs,
    // so they must not lose it to a by-order campaign that merely came earlier.
    const porLegenda = automations.filter((a) => norm(a.bindCaption));
    const porOrdem = automations.filter((a) => !norm(a.bindCaption));

    const ligar = async (automationId: string, reel: InstagramMedia) => {
      await prisma.automation.update({
        where: { id: automationId },
        data: {
          postId: reel.id,
          postUrl: reel.permalink ?? null,
          pendingNextReel: false,
          bindCaption: null,
        },
      });
      taken.add(reel.id);
      bound += 1;
    };

    for (const automation of porLegenda) {
      const alvo = norm(automation.bindCaption);
      const reel = reels.find(
        (r) =>
          !taken.has(r.id) &&
          new Date(r.timestamp) > automation.createdAt &&
          norm(r.caption).includes(alvo)
      );
      if (reel) await ligar(automation.id, reel);
    }

    for (const automation of porOrdem) {
      // The "next" reel = the earliest unclaimed one posted after the campaign was created.
      const reel = reels.find(
        (r) => !taken.has(r.id) && new Date(r.timestamp) > automation.createdAt
      );
      if (reel) await ligar(automation.id, reel);
    }
  }

  return { checked, bound, failedAccounts: failures.length };
}
