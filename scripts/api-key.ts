/**
 * Chaves de API por workspace, da linha de comando.
 *
 * Rode no console do container (Easypanel → o serviço web → Console):
 *
 *   npx tsx scripts/api-key.ts listar
 *   npx tsx scripts/api-key.ts criar <workspaceId> "nome do cliente"
 *   npx tsx scripts/api-key.ts revogar <keyId>
 *
 * A chave aparece UMA vez, na criação. O banco guarda só o hash — se o cliente perder,
 * você revoga e cria outra; não há como recuperar (é o ponto).
 */
import { prisma } from "@/lib/db/client";
import { novaChave } from "@/lib/api-key";

const [, , comando, a, b] = process.argv;

async function listar() {
  const ws = await prisma.workspace.findMany({
    select: {
      id: true,
      name: true,
      _count: { select: { instagramAccounts: true, automations: true } },
      apiKeys: { select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, revokedAt: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!ws.length) return console.log("nenhum workspace ainda — entre no painel e faça login uma vez");
  for (const w of ws) {
    console.log(`\n■ ${w.name || "(sem nome)"}  id=${w.id}`);
    console.log(`  ${w._count.instagramAccounts} conta(s) de Instagram · ${w._count.automations} campanha(s)`);
    if (!w.apiKeys.length) console.log("  (sem chave de API)");
    for (const k of w.apiKeys) {
      const estado = k.revokedAt ? "REVOGADA" : k.lastUsedAt ? `usada ${k.lastUsedAt.toISOString().slice(0, 16)}` : "nunca usada";
      console.log(`  · ${k.prefix}…  ${k.name}  [${estado}]  id=${k.id}`);
    }
  }
}

async function criar(workspaceId: string, nome: string) {
  const w = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } });
  if (!w) return console.error("workspace não encontrado:", workspaceId);
  const { bruta, hash, prefix } = novaChave();
  const k = await prisma.apiKey.create({
    data: { workspaceId: w.id, name: nome || "sem nome", prefix, hash },
    select: { id: true },
  });
  console.log(`\nchave criada para "${w.name || w.id}" (id=${k.id})`);
  console.log("\n  " + bruta + "\n");
  console.log("Copie AGORA — ela não aparece de novo. Cole no Framely em Instachat → Conectar.");
}

async function revogar(keyId: string) {
  const r = await prisma.apiKey.updateMany({ where: { id: keyId, revokedAt: null }, data: { revokedAt: new Date() } });
  console.log(r.count ? "chave revogada — para de funcionar na hora" : "não achei chave ativa com esse id");
}

const rodar = async () => {
  if (comando === "listar") return listar();
  if (comando === "criar") return a ? criar(a, b) : console.error('uso: criar <workspaceId> "nome"');
  if (comando === "revogar") return a ? revogar(a) : console.error("uso: revogar <keyId>");
  console.log("comandos: listar | criar <workspaceId> \"nome\" | revogar <keyId>");
};

rodar()
  .catch((e) => {
    console.error(String(e?.message || e));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
