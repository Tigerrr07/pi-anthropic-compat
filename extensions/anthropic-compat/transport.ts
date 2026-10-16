import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { JsonObject } from "./json.ts";

export type AnthropicTransport = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Replay runs after provider shaping, so translate its SDK-only beta field here. */
export function finalizeRequest(request: Request, payload: JsonObject): Request {
  const { betas, ...body } = payload;
  const headers = new Headers(request.headers);
  if (betas !== undefined) {
    if (!Array.isArray(betas) || !betas.every((beta) => typeof beta === "string")) {
      throw new Error("Invalid Anthropic beta configuration.");
    }
    const original = (headers.get("anthropic-beta") ?? "").split(",").filter(Boolean);
    headers.set("anthropic-beta", [...new Set([...original, ...betas])].join(","));
  }
  headers.delete("content-length");
  return new Request(request, { method: request.method, headers, body: JSON.stringify(body) });
}
