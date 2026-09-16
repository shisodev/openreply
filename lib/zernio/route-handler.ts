import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@/app/generated/prisma/client';
import { getBaseUrl } from '@/lib/env';
import { MetaApiError } from '@/lib/meta/client';
import { canManageWorkspace, getCurrentWorkspaceContext, type WorkspaceContext } from '@/lib/workspace-access';

export class ConnectionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function withZernioManagement(handler: (context: WorkspaceContext, request: Request) => Promise<Response>) {
  return async (request: Request) => {
    try {
      const context = await getCurrentWorkspaceContext();
      if (!context) throw new ConnectionError('Sign in to manage your connection.', 401);
      if (!canManageWorkspace(context.role)) throw new ConnectionError('Only workspace owners and admins can manage the Zernio connection.', 403);
      if (request.method !== 'GET') {
        const origin = request.headers.get('origin');
        // ⚠️ NÃO comparar só com `new URL(request.url).origin`. Atrás de proxy reverso
        // (Easypanel/Traefik, nginx, Cloudflare) o Next remonta request.url a partir da requisição
        // INTERNA: o protocolo vira http e a porta muda. Aí o Origin legítimo do navegador
        // (https://seu-dominio) nunca casa e quem está self-hosted leva "Invalid request origin."
        // exatamente ao salvar a chave do Zernio — com tudo o resto certo.
        // A referência confiável é a URL pública configurada (NEXTAUTH_URL), a mesma que o app já
        // usa pra montar o webhook. O origin do request continua aceito pra não quebrar dev local.
        // ⚠️ getBaseUrl() cai em http://localhost:3000 quando NEXTAUTH_URL não está setado — aí a
        // "referência confiável" vira inútil e o guard volta a depender só do request, que é o
        // que estava quebrado. Nada no projeto valida essa env, então avisa alto aqui: sem ela,
        // o sintoma é este mesmo 403 e ninguém liga uma coisa à outra.
        if (!process.env.NEXTAUTH_URL) {
          console.error('[zernio] NEXTAUTH_URL não está setado — a checagem de origem fica sem referência pública e o salvar da chave pode falhar com "Invalid request origin.". Configure-o com a URL HTTPS pública desta instância.');
        }
        const permitidas = new Set<string>();
        for (const candidata of [getBaseUrl(), new URL(request.url).origin]) {
          try { if (candidata) permitidas.add(new URL(candidata).origin); } catch { /* ignora inválida */ }
        }
        if (origin && !permitidas.has(origin)) throw new ConnectionError('Invalid request origin.', 403);
      }
      return await handler(context, request);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return NextResponse.json({ success: false, error: 'This connection was already added. Refresh and try again.' }, { status: 409 });
      if (error instanceof ConnectionError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
      if (error instanceof z.ZodError) return NextResponse.json({ success: false, error: 'Unexpected Zernio response. Please retry or contact support.' }, { status: 502 });
      if (error instanceof MetaApiError) {
        const message = error.code === 401 ? 'The Zernio API key is invalid or expired.' : error.code === 403 ? 'Use an unrestricted, read-write Zernio key with access to this profile and Inbox.' : error.code === 402 ? 'This Zernio account needs Inbox access. Check your Zernio plan.' : error.message;
        return NextResponse.json({ success: false, error: message }, { status: 502 });
      }
      return NextResponse.json({ success: false, error: 'Could not configure Zernio. Please retry.' }, { status: 502 });
    }
  };
}

export async function readBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new ConnectionError('Send a JSON request body.');
  const input: unknown = await request.json().catch(() => null);
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ConnectionError(parsed.error.issues.map(i => i.message).join('; '));
  return parsed.data;
}
