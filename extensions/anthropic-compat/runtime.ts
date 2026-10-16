// Pi resolves only the pi-ai root, `/compat`, `/oauth`, and `/providers/all` for installed
// extensions. The `/api/*` subpaths are unavailable outside a development checkout.
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import {
  getCurrentSystemMessage,
  getCurrentTools,
  normalizeContext,
  type Api,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  STRICT_TOOL_LIMIT_MESSAGES,
  StrictToolLimitError,
  compactRequest,
  supportsCompaction,
} from "./client.ts";
import type { Config } from "./config.ts";
import { object, objects, type JsonObject } from "./json.ts";
import {
  BOUNDARY_TYPE,
  CHECKPOINT_TYPE,
  TEMPLATE_TYPE,
  checkpoint,
  eligibleModel,
  enforceThinking,
  parseSummary,
  replay,
  template,
} from "./protocol.ts";
import { loadSessionConfig, registerSettings } from "./settings.ts";
import { finalizeRequest, type AnthropicTransport } from "./transport.ts";
import {
  REQUEST_TYPE,
  bindingTemplate,
  fingerprint,
  messageHash,
  prepareRetained,
  requestBoundary,
  selectTail,
  type RetainedHistory,
} from "./tail.ts";

const anthropic = anthropicMessagesApi();
const builtinTransport: AnthropicTransport = (model, messages, options) => {
  if (!anthropicModel(model)) throw new Error("Expected Anthropic Messages API.");
  return anthropic.streamSimple(model, messages, options);
};

/**
 * Serialize a request through Pi's Anthropic adapter without sending it. With `nonStrict`, the
 * first attempt is answered with a strict-tool-limit rejection, so Pi serializes its own retry
 * with `strict: "prefer"` tools non-strict, exactly as it does for a rejected turn. Without such
 * tools, Pi does not retry and the first serialization is already non-strict.
 */
async function prepareRequest(
  transport: AnthropicTransport,
  model: Model<"anthropic-messages">,
  context: TranscriptContext,
  options: SimpleStreamOptions,
  nonStrict = false,
): Promise<Request> {
  let prepared: Request | undefined;
  let rejected = false;
  await transport(model, context, {
    ...options,
    maxRetries: 0,
    fetch: (input, init) => {
      prepared = new Request(input, init);
      if (nonStrict && !rejected) {
        rejected = true;
        return Promise.resolve(
          Response.json(
            {
              type: "error",
              error: { type: "invalid_request_error", message: STRICT_TOOL_LIMIT_MESSAGES[1] },
            },
            { status: 400 },
          ),
        );
      }
      return Promise.reject(new Error("Native request prepared without transmission."));
    },
  }).result();
  options.signal?.throwIfAborted();
  if (!prepared) throw new Error("Could not serialize the Anthropic compaction request.");
  return prepared;
}

function anthropicModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

export function requireCompletedTools(messages: readonly Message[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const item of message.content) {
        if (item.type === "toolCall") pending.add(item.id);
      }
    } else if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    }
  }
  if (pending.size > 0) throw new Error("Resolve pending tool calls before native compaction.");
}

/**
 * The transcript Pi rebuilds after compaction: its snapshot of the current prompt and
 * tools leads, followed by the retained messages. Serializing this shape, rather than
 * the retained messages alone, proves the tail survives the compaction entry unchanged.
 */
/**
 * Current transcript tools the last turn request did not send. Pi hides them
 * from requests in codemode `only` mode. Pi hides only current tools, and a
 * tool a turn removed is no longer current. Names compare case-insensitively,
 * because OAuth requests send Claude Code's capitalized names for Pi's tools.
 */
export function hiddenTools(
  messages: readonly Message[],
  savedTemplate: JsonObject,
): ReadonlySet<string> {
  const tools = savedTemplate["tools"];
  const sent = new Set(
    (Array.isArray(tools) ? objects(tools) : []).flatMap((tool) =>
      typeof tool["name"] === "string" ? [tool["name"].toLowerCase()] : [],
    ),
  );
  return new Set(
    getCurrentTools([...messages])
      .map((tool) => tool.name)
      .filter((name) => !sent.has(name.toLowerCase())),
  );
}

/** Remove hidden tools from every tool declaration change, as Pi projects requests. */
export function withoutHiddenTools(
  messages: readonly Message[],
  hidden: ReadonlySet<string>,
): Message[] {
  if (hidden.size === 0) return [...messages];
  return messages.map((message) => {
    if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) {
      return message;
    }
    const { toolsAdded, toolsRemoved, ...rest } = message;
    const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
    const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
    return {
      ...rest,
      ...(added.length > 0 ? { toolsAdded: added } : {}),
      ...(removed.length > 0 ? { toolsRemoved: removed } : {}),
    };
  });
}

export function compactedTranscript(
  whole: readonly Message[],
  kept: readonly Message[],
): TranscriptContext {
  const snapshot = getCurrentSystemMessage(whole);
  return normalizeContext({ messages: snapshot ? [snapshot, ...kept] : [...kept] });
}

export function activeCheckpoint(entries: readonly SessionEntry[]) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "compaction") return checkpoint(entry.details);
  }
  return undefined;
}

export function activeTemplate(
  entries: readonly SessionEntry[],
  model: string,
): JsonObject | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== TEMPLATE_TYPE) continue;
    const data = object(entry.data);
    if (data["model"] === model) return data;
  }
  return undefined;
}

/**
 * Whether Pi had to retry the branch's latest response from this model with `strict: "prefer"`
 * tools non-strict after Anthropic rejected the strict tool set.
 */
export function strictToolsRejected(branch: readonly SessionEntry[], model: string): boolean {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    if (entry.message.model !== model) continue;
    return (entry.message.diagnostics ?? []).some(
      (diagnostic) => diagnostic.type === "anthropic_strict_tools_fallback",
    );
  }
  return false;
}

export function registerCompatibility(pi: ExtensionAPI, fetcher = fetch): void {
  let context: ExtensionContext | undefined;
  let config: Config | undefined;
  let transform: SimpleStreamOptions["onPayload"];
  let transformModel: string | undefined;
  // Resolve after every extension has registered. Never replace an OAuth wrapper
  // with the bare adapter, and never route serialization back through ourselves.
  let transport: AnthropicTransport = builtinTransport;
  const delegates = new WeakMap<AnthropicTransport, AnthropicTransport>();

  const configuration = (ctx: Parameters<typeof loadSessionConfig>[0]): Config => {
    config ??= loadSessionConfig(ctx);
    return config;
  };
  const reset = () => {
    context = undefined;
    config = undefined;
    transform = undefined;
    transformModel = undefined;
  };
  pi.on("session_start", (_event, ctx) => {
    reset();
    context = ctx;
    const registered = ctx.modelRegistry.getRegisteredProviderConfig("anthropic");
    const selected = registered?.streamSimple ?? builtinTransport;
    transport = delegates.get(selected) ?? selected;
    const delegate = transport;
    const composed: AnthropicTransport = (model, messages, options) => {
      if (!anthropicModel(model)) throw new Error("Expected Anthropic Messages API.");
      const ctx = context;
      const agentTurn =
        ctx && eligibleModel(model) && options?.sessionId === ctx.sessionManager.getSessionId();
      if (!agentTurn) return delegate(model, messages, options);
      transform = options?.onPayload;
      transformModel = model.id;
      const send = options?.fetch ?? fetcher;
      return delegate(model, messages, {
        ...options,
        // The auth transport owns onPayload and its fetch-level version checks.
        // Its final fetch delegates here, after all shaping has completed.
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (
            request.method !== "POST" ||
            url.origin !== "https://api.anthropic.com" ||
            url.pathname !== "/v1/messages"
          )
            return send(request);
          const transformed = object(await request.clone().json());
          const branch = ctx.sessionManager.getBranch();
          const nextTemplate = template(transformed);
          const current = configuration(ctx);
          const final = replay(
            current.enabled && current.keepRecentTokens > 0
              ? enforceThinking(transformed)
              : transformed,
            activeCheckpoint(branch),
          );
          const anchor = ctx.sessionManager.getLeafId();
          const response = await send(finalizeRequest(request, final));
          // Rejected attempts must not become request boundaries. Auth can safely
          // learn a version floor and send another attempt through this seam.
          if (response.ok) {
            const saved = activeTemplate(ctx.sessionManager.getBranch(), model.id);
            if (JSON.stringify(saved) !== JSON.stringify(nextTemplate)) {
              pi.appendEntry(TEMPLATE_TYPE, nextTemplate);
            }
            if (anchor) pi.appendEntry(REQUEST_TYPE, requestBoundary(final, anchor));
          }
          return response;
        },
      });
    };
    delegates.set(composed, delegate);
    pi.registerProvider("anthropic", { api: "anthropic-messages", streamSimple: composed });
  });
  pi.on("session_shutdown", reset);
  pi.on("session_tree", (_event, ctx) => {
    context = ctx;
    transform = undefined;
    transformModel = undefined;
  });
  pi.on("model_select", (_event, ctx) => {
    context = ctx;
    transform = undefined;
    transformModel = undefined;
  });
  // The full-transcript event returns messages verbatim. A changed `context`
  // result folds every later system message into the leading one,
  // which changes the serialized `system` template after a checkpoint and
  // breaks retained-history replay.
  pi.on("context_with_system", (event, ctx) => {
    context = ctx;
    if (!eligibleModel(ctx.model) || !activeCheckpoint(ctx.sessionManager.getBranch())) return;
    return { messages: event.messages.filter((message) => message.role !== "compactionSummary") };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    context = ctx;
    if (!eligibleModel(ctx.model)) return;
    try {
      if (!configuration(ctx).enabled) return;
      const model = ctx.model;
      const leaf = ctx.sessionManager.getLeafId();
      const session = ctx.sessionManager.getSessionId();
      const branch = ctx.sessionManager.getBranch();
      const saved = activeCheckpoint(branch);
      const savedTemplate = activeTemplate(branch, model.id);
      const currentTransform = transformModel === model.id ? transform : undefined;
      if (!savedTemplate) {
        throw new Error(
          "Run an Anthropic turn before compacting so final system instructions and tools can be captured.",
        );
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error("Anthropic authentication is unavailable.");
      const requestModel = { ...model, baseUrl: auth.baseUrl ?? model.baseUrl };
      if (!eligibleModel(requestModel))
        throw new Error("Native compaction requires the direct Claude API.");
      const signal = AbortSignal.any([
        event.signal,
        AbortSignal.timeout(configuration(ctx).timeoutSeconds * 1000),
      ]);
      signal.throwIfAborted();
      // Prompt and tool declarations travel as system messages inside the transcript.
      const active = buildSessionContext(branch, leaf).messages;
      // Pi leaves tools it hides (codemode `only` mode) out of every request
      // after extensions see the transcript. The saved template lists the tools
      // the last turn sent, so the others are removed here as Pi removes them.
      const transcript = convertToLlm(
        saved ? active.filter((message) => message.role !== "compactionSummary") : active,
      );
      const hidden = hiddenTools(transcript, savedTemplate);
      const messages = withoutHiddenTools(transcript, hidden);
      requireCompletedTools(messages);
      const level = pi.getThinkingLevel();
      const serializationOptions: SimpleStreamOptions = {
        ...auth,
        signal,
        ...(level === "off" ? {} : { reasoning: level }),
        maxTokens: Math.min(configuration(ctx).maxSummaryTokens, model.maxTokens),
        onPayload: async (payload, selected) => {
          const updated = await currentTransform?.(payload, selected);
          const result = object(updated === undefined ? payload : updated);
          if (!currentTransform) {
            for (const key of ["system", "tools", "thinking", "output_config"] as const) {
              if (savedTemplate[key] === undefined) delete result[key];
              else result[key] = savedTemplate[key];
            }
          }
          return configuration(ctx).keepRecentTokens > 0 ? enforceThinking(result) : result;
        },
      };
      // The retained tail must be checked against the tools Pi will send after
      // compaction, which come from the compacted snapshot. Saved tools would
      // hide a tool change and let a billed summary strand the conversation.
      const tailSerializationOptions: SimpleStreamOptions = {
        ...serializationOptions,
        onPayload: async (payload, selected) => {
          const result = object(await serializationOptions.onPayload?.(payload, selected));
          if (!currentTransform) {
            const serialized = object(payload)["tools"];
            if (serialized === undefined) delete result["tools"];
            else result["tools"] = serialized;
          }
          return result;
        },
      };
      // Serialize without transmission, then select only a proven earlier request.
      const serialize = async (nonStrict: boolean) => {
        const request = await prepareRequest(
          transport,
          requestModel,
          normalizeContext({ messages }),
          serializationOptions,
          nonStrict,
        );
        const payload = replay(object(await request.clone().json()), saved);
        if (payload["model"] !== model.id) {
          throw new Error("A provider transform changed the summary model. History was preserved.");
        }
        return { request, payload };
      };
      // After Anthropic rejects the strict tool set, Pi sends each turn non-strict. Retained
      // messages replay only behind the tools they were answered with, and Pi sends the strict
      // set first on every later turn, so such sessions compact the full history instead.
      const rejectedStrict = strictToolsRejected(branch, model.id);
      let { request: whole, payload: wholePayload } = await serialize(rejectedStrict);
      const keepRecentTokens = configuration(ctx).keepRecentTokens;
      const managedEffort = model.compat?.supportsMidConvoEffort === true;
      let fullHistoryFallback = keepRecentTokens > 0 && rejectedStrict;
      let selection =
        keepRecentTokens > 0 && !rejectedStrict
          ? selectTail(branch, leaf, wholePayload, keepRecentTokens, managedEffort)
          : undefined;
      let retained: RetainedHistory | undefined;
      if (selection) {
        const keptMessages = withoutHiddenTools(convertToLlm(selection.keptMessages), hidden);
        requireCompletedTools(keptMessages);
        const tailRequest = await prepareRequest(
          transport,
          requestModel,
          compactedTranscript(messages, keptMessages),
          tailSerializationOptions,
        );
        retained = prepareRetained(
          selection.tail,
          object(await tailRequest.json()),
          selection.template,
          selection.prefix.at(-1),
          managedEffort,
        );
      }
      const summaryRequest = () =>
        new Request(whole.url, {
          method: "POST",
          headers: whole.headers,
          body: JSON.stringify(
            selection ? { ...wholePayload, messages: selection.prefix } : wholePayload,
          ),
        });
      if (!(await supportsCompaction(summaryRequest(), model.id, signal, fetcher))) {
        ctx.ui.notify(
          "This model does not support native compaction. Pi compaction remains available.",
          "warning",
        );
        return;
      }
      const summarize = () =>
        compactRequest(
          summaryRequest(),
          Math.min(configuration(ctx).maxSummaryTokens, model.maxTokens),
          signal,
          event.customInstructions,
          fetcher,
        );
      let raw: JsonObject;
      try {
        raw = await summarize();
      } catch (error) {
        if (!(error instanceof StrictToolLimitError)) throw error;
        // Follow Pi: retry once with preferred strict tools non-strict. Retained messages
        // cannot follow the changed tools, so the retry summarizes the full history.
        const downgraded = await serialize(true);
        if (JSON.stringify(downgraded.payload) === JSON.stringify(wholePayload)) throw error;
        whole = downgraded.request;
        wholePayload = downgraded.payload;
        if (selection) {
          selection = undefined;
          retained = undefined;
          fullHistoryFallback = true;
        }
        raw = await summarize();
      }
      const result = parseSummary(raw, model);
      signal.throwIfAborted();
      if (selection) {
        const verification = await prepareRequest(
          transport,
          requestModel,
          normalizeContext({ messages }),
          serializationOptions,
        );
        const verifiedPayload = replay(object(await verification.json()), saved);
        if (
          fingerprint(bindingTemplate(verifiedPayload)) !==
            fingerprint(bindingTemplate(wholePayload)) ||
          messageHash(objects(verifiedPayload["messages"])) !==
            messageHash(objects(wholePayload["messages"]))
        ) {
          throw new Error(
            "System, tools, or history changed during compaction. The summary was not applied.",
          );
        }
      }
      if (
        ctx.sessionManager.getSessionId() !== session ||
        ctx.sessionManager.getLeafId() !== leaf ||
        ctx.model?.id !== model.id
      ) {
        throw new Error("The session changed during compaction. The summary was not applied.");
      }
      // Full-history mode needs an empty boundary. Keep-tail mode points to the
      // original first retained entry. Neither mode deletes historical entries.
      if (fullHistoryFallback) {
        ctx.ui.notify(
          "Anthropic rejects this session's strict tool set, so native compaction summarized the full history instead of retaining recent messages.",
          "warning",
        );
      }
      if (!selection) pi.appendEntry(BOUNDARY_TYPE, { version: 1 });
      const boundary = selection?.firstKeptEntryId ?? ctx.sessionManager.getLeafId();
      if (!boundary) throw new Error("Could not record the compaction boundary.");
      return {
        compaction: {
          summary: result.summary,
          firstKeptEntryId: boundary,
          tokensBefore: event.preparation.tokensBefore,
          usage: result.usage,
          details: {
            type: CHECKPOINT_TYPE,
            version: 1,
            model: model.id,
            block: result.block,
            ...(retained ? { retained } : {}),
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Native compaction failed.";
      // No automatic switch to a text-summary algorithm after a native failure.
      ctx.ui.notify(message, "error");
      return { cancel: true };
    }
  });

  registerSettings(pi, {
    get: configuration,
    set: (next) => {
      config = next;
    },
  });
}
