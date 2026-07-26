/**
 * Consumes best-effort partial structured output without preventing recovery
 * from the stream's final object when a provider rejects a malformed chunk.
 */
export async function consumePartialObjectStream<T>(
  partialObjectStream: AsyncIterable<T>,
  consumePartial: (partial: T) => void | Promise<void>,
): Promise<unknown | null> {
  try {
    for await (const partial of partialObjectStream) {
      await consumePartial(partial);
    }
  } catch (error) {
    return error;
  }

  return null;
}
