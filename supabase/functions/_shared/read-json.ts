export class RequestBodyTooLargeError extends Error {}
export class InvalidJsonBodyError extends Error {}

export async function readJsonWithLimit<T>(request: Request, maxBytes: number): Promise<T> {
  if (!request.body) {
    throw new InvalidJsonBodyError('Request body is missing');
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError(`Request body exceeds ${maxBytes} bytes`);
    }

    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    throw new InvalidJsonBodyError('Request body is not valid JSON');
  }
}
