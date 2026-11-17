// Cloudflare Pages Function: every /api/* request lands here and goes to the shared API.
import { handleApi } from '../../src/server/api.ts';
import { buildCtx } from '../../src/server/context.ts';
import type { Env } from '../../src/server/ctx.ts';

export const onRequest = async (c: { request: Request; env: Env }): Promise<Response> =>
  handleApi(buildCtx(c.env, c.request.url), c.request);
