import { createEdgeHandler } from './handler.js';
import { config } from '../../../server/src/config.js';

const rawOrigins = Deno.env.get('NEXUS_ALLOWED_ORIGINS') || Deno.env.get('ALLOWED_ORIGINS') || 'https://zenosx77.github.io';
const hostedOrigins = rawOrigins.split(',').map(s => s.trim()).filter(Boolean);

Deno.serve(createEdgeHandler({
  config: config.allowedOrigins.length ? config : { ...config, allowedOrigins: hostedOrigins },
}));
