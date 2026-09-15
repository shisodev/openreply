import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/client";

/**
 * Machine-to-machine auth for the /api/v1 surface.
 *
 * Everything else here authenticates a browser session. These routes are called by
 * another system (a publishing tool creating a campaign for the reel it just queued),
 * so they get a key instead.
 *
 * Two kinds of key, and the difference is the whole point:
 *
 *  - a WORKSPACE key (stored hashed in ApiKey) resolves to one workspace, and every
 *    route scopes its queries to it. This is what you hand a customer.
 *  - the instance key in OPENREPLY_API_KEY resolves to no workspace — it can act on
 *    any of them. It is the owner's key, kept for a single-tenant install and for
 *    bootstrapping the first workspace key.
 *
 * Without the first kind, one instance can only ever serve one customer safely: a
 * single shared key reads, edits and deletes every tenant's campaigns.
 *
 * Keys are compared over SHA-256 digests: the DB lookup is by digest (so a database
 * dump doesn't hand over working keys), and the env comparison is constant-time over
 * digests, which also keeps it constant-length — a wrong key never leaks the right
 * key's length through a thrown error.
 */
export type ApiKeyCheck =
  | { ok: true; workspaceId: string | null; keyId: string | null }
  | { ok: false; status: 401 | 503; error: string };

const digest = (s: string) => createHash("sha256").update(s).digest();
const hex = (s: string) => createHash("sha256").update(s).digest("hex");

export const API_KEY_PREFIX = "orp_";

/** Gera uma chave nova pra um workspace. Devolve o texto UMA vez; o banco fica só com o hash. */
export function novaChave() {
  const bruta = API_KEY_PREFIX + randomBytes(24).toString("base64url");
  return { bruta, hash: hex(bruta), prefix: bruta.slice(0, 12) };
}

function apresentada(request: Request): string {
  const header = request.headers.get("authorization");
  return (
    (header && /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim()) ||
    request.headers.get("x-api-key")?.trim() ||
    ""
  );
}

export async function checkApiKey(request: Request): Promise<ApiKeyCheck> {
  const bruta = apresentada(request);
  if (!bruta) return { ok: false, status: 401, error: "Missing API key" };

  // 1) chave de workspace (o caminho normal de quem é cliente)
  const registro = await prisma.apiKey.findUnique({
    where: { hash: hex(bruta) },
    select: { id: true, workspaceId: true, revokedAt: true },
  });
  if (registro) {
    if (registro.revokedAt) return { ok: false, status: 401, error: "API key revoked" };
    // marca o uso sem segurar a resposta: serve pra achar chave abandonada, não é auditoria
    prisma.apiKey
      .update({ where: { id: registro.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
    return { ok: true, workspaceId: registro.workspaceId, keyId: registro.id };
  }

  // 2) chave da instância (dono)
  const esperada = process.env.OPENREPLY_API_KEY;
  if (!esperada) {
    // Self-hosted: dizer que a chave não está configurada é diagnóstico, não vazamento.
    return { ok: false, status: 503, error: "OPENREPLY_API_KEY is not set on this instance" };
  }
  if (timingSafeEqual(digest(bruta), digest(esperada))) {
    return { ok: true, workspaceId: null, keyId: null };
  }

  return { ok: false, status: 401, error: "Invalid API key" };
}

/**
 * O filtro de workspace que TODA consulta de /api/v1 tem que usar.
 * Chave de workspace → trava naquele workspace. Chave da instância → sem trava.
 */
export const escopo = (workspaceId: string | null) =>
  workspaceId ? { workspaceId } : {};
