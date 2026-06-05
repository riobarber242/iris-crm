// fetch con timeout vía AbortController. Si se supera el tiempo, aborta y lanza
// (AbortError) — el llamador lo trata como fallo de red. Evita que un request
// colgado deje la UI trabada (botón "Enviar" en "..." para siempre).
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
