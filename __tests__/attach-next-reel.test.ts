/**
 * Binding pending campaigns to the reels they belong to.
 *
 * Reels go out in batches. The first version of this asked, for every pending
 * campaign, "the earliest reel posted after I was created" — so three campaigns
 * waiting on three reels all answered the SAME reel, and two clips silently ran
 * with no automation. These tests pin the two rules that fix it: a reel is
 * consumed once, and a campaign that knows its caption gets ITS reel.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockProvider } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findMany: vi.fn(), update: vi.fn() },
  },
  mockProvider: {
    createInstagramContext: vi.fn(),
    hasInstagramCredentials: vi.fn(() => true),
    getUserMedia: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/instagram/provider", () => mockProvider);

import { attachPendingNextReels } from "../lib/automation/attach-next-reel";

const CONTA = { id: "acc_1", accessToken: "tok" };
const t = (iso: string) => new Date(iso);

const campanha = (id: string, criadaEm: string, bindCaption: string | null = null) => ({
  id,
  instagramAccountId: CONTA.id,
  instagramAccount: CONTA,
  createdAt: t(criadaEm),
  bindCaption,
});

const reel = (id: string, quando: string, caption = "") => ({
  id,
  caption,
  media_type: "VIDEO",
  media_product_type: "REELS",
  timestamp: quando,
  permalink: `https://instagram.com/reel/${id}`,
});

/** findMany é chamado 2x: campanhas pendentes e, por conta, os reels já tomados. */
function comBanco(pendentes: unknown[], jaTomados: { postId: string }[] = []) {
  mockPrisma.automation.findMany.mockReset()
  mockPrisma.automation.findMany
    .mockResolvedValueOnce(pendentes)
    .mockResolvedValue(jaTomados)
  mockPrisma.automation.update.mockReset()
  mockPrisma.automation.update.mockResolvedValue({})
}

const ligadas = () =>
  mockPrisma.automation.update.mock.calls.map((c: any[]) => ({
    id: c[0].where.id,
    postId: c[0].data.postId,
  }));

describe("attachPendingNextReels", () => {
  beforeEach(() => {
    mockProvider.getUserMedia.mockReset();
    mockProvider.hasInstagramCredentials.mockReturnValue(true);
    mockProvider.createInstagramContext.mockResolvedValue({});
  });

  it("um post, uma campanha: continua igual", async () => {
    comBanco([campanha("c1", "2026-09-01T10:00:00Z")]);
    mockProvider.getUserMedia.mockResolvedValue([reel("r1", "2026-09-01T12:00:00Z")]);

    const r = await attachPendingNextReels();

    expect(r.bound).toBe(1);
    expect(ligadas()).toEqual([{ id: "c1", postId: "r1" }]);
  });

  it("LOTE: três campanhas pegam três reels diferentes, não o mesmo", async () => {
    comBanco([
      campanha("c1", "2026-09-01T10:00:00Z"),
      campanha("c2", "2026-09-01T10:01:00Z"),
      campanha("c3", "2026-09-01T10:02:00Z"),
    ]);
    mockProvider.getUserMedia.mockResolvedValue([
      reel("r1", "2026-09-01T12:00:00Z"),
      reel("r2", "2026-09-01T13:00:00Z"),
      reel("r3", "2026-09-01T14:00:00Z"),
    ]);

    const r = await attachPendingNextReels();

    expect(r.bound).toBe(3);
    expect(ligadas()).toEqual([
      { id: "c1", postId: "r1" },
      { id: "c2", postId: "r2" },
      { id: "c3", postId: "r3" },
    ]);
  });

  it("não entrega um reel que outra campanha já tomou numa rodada anterior", async () => {
    comBanco([campanha("c9", "2026-09-01T10:00:00Z")], [{ postId: "r1" }]);
    mockProvider.getUserMedia.mockResolvedValue([
      reel("r1", "2026-09-01T12:00:00Z"),
      reel("r2", "2026-09-01T13:00:00Z"),
    ]);

    await attachPendingNextReels();

    expect(ligadas()).toEqual([{ id: "c9", postId: "r2" }]);
  });

  it("legenda manda: a campanha casa com O reel dela, mesmo fora de ordem", async () => {
    comBanco([
      campanha("cA", "2026-09-01T10:00:00Z", "corte do jogo 🔥"),
      campanha("cB", "2026-09-01T10:01:00Z", "bastidor do treino"),
    ]);
    mockProvider.getUserMedia.mockResolvedValue([
      reel("rX", "2026-09-01T12:00:00Z", "BASTIDOR DO TREINO   completo"),
      reel("rY", "2026-09-01T13:00:00Z", "corte do jogo 🔥 olha isso"),
    ]);

    await attachPendingNextReels();

    // sem o casamento por legenda, cA (criada antes) levaria rX — o reel errado
    expect(ligadas()).toEqual([
      { id: "cA", postId: "rY" },
      { id: "cB", postId: "rX" },
    ]);
  });

  it("campanha com legenda tem preferência sobre a que só espera a vez", async () => {
    comBanco([
      campanha("cOrdem", "2026-09-01T10:00:00Z"),
      campanha("cLegenda", "2026-09-01T10:05:00Z", "promo de setembro"),
    ]);
    mockProvider.getUserMedia.mockResolvedValue([
      reel("r1", "2026-09-01T12:00:00Z", "promo de setembro"),
      reel("r2", "2026-09-01T13:00:00Z", "outro assunto"),
    ]);

    await attachPendingNextReels();

    expect(ligadas()).toEqual([
      { id: "cLegenda", postId: "r1" },
      { id: "cOrdem", postId: "r2" },
    ]);
  });

  it("legenda que não aparece em reel nenhum: a campanha espera, não pega o errado", async () => {
    comBanco([campanha("cZ", "2026-09-01T10:00:00Z", "legenda que ninguém publicou")]);
    mockProvider.getUserMedia.mockResolvedValue([reel("r1", "2026-09-01T12:00:00Z", "outra coisa")]);

    const r = await attachPendingNextReels();

    expect(r.bound).toBe(0);
    expect(ligadas()).toEqual([]);
  });

  it("ignora reel publicado ANTES da campanha existir", async () => {
    comBanco([campanha("c1", "2026-09-01T12:00:00Z")]);
    mockProvider.getUserMedia.mockResolvedValue([reel("r0", "2026-09-01T09:00:00Z")]);

    const r = await attachPendingNextReels();

    expect(r.bound).toBe(0);
  });

  it("conta sem credencial não derruba a varredura", async () => {
    comBanco([campanha("c1", "2026-09-01T10:00:00Z")]);
    mockProvider.hasInstagramCredentials.mockReturnValue(false);

    const r = await attachPendingNextReels();

    expect(r).toEqual({ checked: 1, bound: 0, failedAccounts: 0 });
    expect(mockProvider.getUserMedia).not.toHaveBeenCalled();
  });
});
