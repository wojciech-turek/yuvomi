import { op, jsonBody, idParam } from '../helpers.js';

export function aiPaths() {
  return {
    '/api/v1/ai/status': { get: op({ summary: 'Whether AI help is on, per feature (no keys, no costs)', tag: 'AI' }) },
    '/api/v1/ai/config': {
      get: op({ summary: 'AI settings and this month\'s usage', tag: 'AI', admin: true }),
      put: op({ summary: 'Update AI settings (switch, keys, model, monthly limit, features)', tag: 'AI', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/ai/test': { post: op({ summary: 'Test the configured AI providers with one tiny call each', tag: 'AI', admin: true, stateChanging: true }) },
    '/api/v1/ai/memories': {
      get: op({ summary: 'List what Yuvomi knows about the household', tag: 'AI' }),
      post: op({ summary: 'Add a sentence to the household memory', tag: 'AI', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/ai/memories/{id}': {
      patch: op({ summary: 'Change or pause a memory sentence', tag: 'AI', params: [idParam('id', 'Memory ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a memory sentence', tag: 'AI', params: [idParam('id', 'Memory ID')], stateChanging: true }),
    },
  };
}
