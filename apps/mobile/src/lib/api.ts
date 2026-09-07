/**
 * Process-wide singletons for the shell. `api` is safe in shared code —
 * it resolves the platform token store through Metro's extension
 * resolution and never imports `expo-secure-store` itself.
 */
import { createApiClient, type ApiClient } from './apiClient';
import { config } from './config';
import { impl as tokenStoreImpl } from './tokenStore.impl';

export const api: ApiClient = createApiClient(tokenStoreImpl, {
  baseUrl: config.apiBaseUrl,
  source: config.source,
});

export { tokenStoreImpl as tokenStore };
