import { consumePartialObjectStream } from "../partial-object-stream";

describe("consumePartialObjectStream", () => {
  it("defers a partial-stream parse error so the final object can still be recovered", async () => {
    const partialStreamError = new Error("AI_JSONParseError");
    const finalObject = Promise.resolve({ protocolNumber: "№1" });
    const receivedPartials: unknown[] = [];

    async function* malformedPartialStream(): AsyncGenerator<unknown> {
      yield { protocolNumber: "№" };
      throw partialStreamError;
    }

    const deferredError = await consumePartialObjectStream(
      malformedPartialStream(),
      (partial) => receivedPartials.push(partial),
    );

    expect(deferredError).toBe(partialStreamError);
    expect(receivedPartials).toEqual([{ protocolNumber: "№" }]);
    await expect(finalObject).resolves.toEqual({ protocolNumber: "№1" });
  });
});
