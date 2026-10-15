import { createNexusApiHandler } from '../../../server/src/api-handler.js';

// Supabase forwards the function-name prefix to the runtime. Only this fixed
// prefix is removed; never accept client-selected destinations or route bases.
export function createEdgeHandler(options = {}) {
  const handle = createNexusApiHandler(options);
  return request => {
    const url = new URL(request.url);
    const prefix = ['/functions/v1/nexus-relay', '/nexus-relay']
      .find(value => url.pathname.startsWith(value + '/'));
    if (prefix) {
      url.pathname = url.pathname.slice(prefix.length);
      request = new Request(url, request);
    }
    return handle(request);
  };
}
