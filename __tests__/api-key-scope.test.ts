/**
 * Isolamento entre clientes na superfície /api/v1.
 *
 * Com uma chave só pra instância inteira, quem comprasse o serviço lia, editava e
 * apagava a campanha de todo mundo — a rota buscava por `findUnique({ where: { id } })`
 * e o id sai de graça no próprio POST de criação. Estes testes prendem as duas regras
 * que consertam isso: a chave resolve pra UM workspace, e toda consulta carrega esse
 * workspace junto.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    apiKey: { findUnique: vi.fn(), update: vi.fn() },
    automation: { findFirst: vi.fn(), deleteMany: vi.fn() },
    instagramAccount: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { checkApiKey, escopo, novaChave, API_KEY_PREFIX } from "../lib/api-key";
import { createHash } from "node:crypto";

const req = (chave?: string) =>
  new Request("https://exemplo/api/v1/ping", {
    headers: chave ? { "x-api-key": chave } : {},
  });

describe("escopo()", () => {
  it("chave de workspace vira filtro; chave da instância não filtra", () => {
    expect(escopo("ws_1")).toEqual({ workspaceId: "ws_1" });
    expect(escopo(null)).toEqual({});
  });

  it("o filtro é espalhável numa cláusula where sem apagar as outras condições", () => {
    expect({ id: "x", ...escopo("ws_1") }).toEqual({ id: "x", workspaceId: "ws_1" });
    expect({ id: "x", ...escopo(null) }).toEqual({ id: "x" });
  });
});

describe("novaChave()", () => {
  it("guarda só o hash — o texto da chave existe uma vez e nunca é persistido", () => {
    const { bruta, hash, prefix } = novaChave();
    expect(bruta.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(hash).toBe(createHash("sha256").update(bruta).digest("hex"));
    expect(hash).not.toContain(bruta);
    expect(prefix).toBe(bruta.slice(0, 12));
    expect(bruta.length).toBeGreaterThan(30);
  });

  it("duas chaves nunca saem iguais", () => {
    expect(novaChave().bruta).not.toBe(novaChave().bruta);
  });
});

describe("checkApiKey", () => {
  beforeEach(() => {
    mockPrisma.apiKey.findUnique.mockReset();
    mockPrisma.apiKey.update.mockReset().mockResolvedValue({});
    process.env.OPENREPLY_API_KEY = "chave-da-instancia-do-dono";
  });

  it("sem chave nenhuma: 401", async () => {
    await expect(checkApiKey(req())).resolves.toMatchObject({ ok: false, status: 401 });
  });

  it("chave de workspace resolve PRO WORKSPACE DELA", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({ id: "k1", workspaceId: "ws_cliente", revokedAt: null });
    await expect(checkApiKey(req("orp_qualquer"))).resolves.toEqual({ ok: true, workspaceId: "ws_cliente", keyId: "k1" });
  });

  it("chave revogada não entra", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({ id: "k1", workspaceId: "ws_1", revokedAt: new Date() });
    await expect(checkApiKey(req("orp_revogada"))).resolves.toMatchObject({ ok: false, status: 401 });
  });

  it("a chave da instância passa sem workspace (dono enxerga tudo)", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(null);
    await expect(checkApiKey(req("chave-da-instancia-do-dono"))).resolves.toEqual({ ok: true, workspaceId: null, keyId: null });
  });

  it("chave errada não vira chave da instância", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(null);
    await expect(checkApiKey(req("chute"))).resolves.toMatchObject({ ok: false, status: 401 });
  });

  it("aceita Authorization: Bearer além do x-api-key", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({ id: "k2", workspaceId: "ws_2", revokedAt: null });
    const r = new Request("https://exemplo/api/v1/ping", { headers: { authorization: "Bearer orp_abc" } });
    await expect(checkApiKey(r)).resolves.toMatchObject({ ok: true, workspaceId: "ws_2" });
  });

  it("procura no banco pelo HASH, nunca pela chave em texto", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(null);
    await checkApiKey(req("orp_segredo"));
    const where = mockPrisma.apiKey.findUnique.mock.calls[0][0].where;
    expect(where.hash).toBe(createHash("sha256").update("orp_segredo").digest("hex"));
    expect(JSON.stringify(where)).not.toContain("orp_segredo");
  });

  it("sem OPENREPLY_API_KEY e sem chave no banco: 503 explicando, não 401 mudo", async () => {
    delete process.env.OPENREPLY_API_KEY;
    mockPrisma.apiKey.findUnique.mockResolvedValue(null);
    await expect(checkApiKey(req("qualquer"))).resolves.toMatchObject({ ok: false, status: 503 });
  });
});
