import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { sanitizeAnthropicMessages, parseGetChatMessageRequest } from "../proxy-scripts/src/handlers/parse-request.js";
import { applySystemPromptOverride, clearSystemPromptCache } from "../proxy-scripts/src/handlers/system-prompt.js";
import { shouldFallbackToChatCompletions, toChatCompletionsMessages, buildOpenAIResponsesBody, buildOpenAIChatCompletionsBody, requiresConfiguredDefaultModel, toInjectedTailMessage, splitSseFrames, filterForwardedTools, sanitizeLogBody, buildThinkingOptions } from "../proxy-scripts/src/handlers/chat.js";
import { setRuntimeConfig, getSlotServiceTier, getSlotReasoningMode, handleConfigRequest } from "../proxy-scripts/src/handlers/models.js";
import { applyAnthropicPromptCache, normalizeOpenAIPromptCacheMode, prepareToolsForPromptCache, shouldRetryWithoutPromptCache, sortToolsForStablePrefix } from "../proxy-scripts/src/handlers/prompt-cache.js";
import { computeCacheHitRate, extractOpenAIResponsesUsage, formatUsageLog, mergeUsage } from "../proxy-scripts/src/handlers/usage-log.js";
import { parseOpenAISSEChunk, OpenAIStreamProcessor } from "../proxy-scripts/src/handlers/openai-stream.js";
import { buildAnthropicThinkingPayload, supportsAdaptiveClaudeThinking, getByokSlot, shouldInterceptByokChat, peekRequestedModel, thinkingEffortToOpenAIReasoningEffort } from "../proxy-scripts/src/handlers/byok-slots.js";
import { bufferedResponseHeaders, wrapEnvelope } from "../proxy-scripts/src/connect.js";
import { writeStringField } from "../proxy-scripts/src/proto.js";
import { buildGatewayCapabilityKey, clearGatewayCapabilityCache, getGatewayCapability, markGatewayCapability, _getGatewayCapabilityCacheSizeForTests, _resetGatewayCapabilityMemoryForTests, _setGatewayCapabilityCachePathForTests } from "../proxy-scripts/src/handlers/gateway-capability.js";

const require = createRequire(import.meta.url);
const { readClaudeUserConfig, readCodexUserConfig } = require("../externalConfigImporter.js");
const { PatchManager } = require("../patchManager.js");
const gatewayUrl = require("../gatewayUrl.js");
const { buildThinkingEffortOptionsHtml, sanitizeThinkingEffort } = require("../thinkingEffort.js");
const proxyRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "proxy-scripts");

function httpJsonRequest(port, method, reqPath, body = null, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const started = Date.now();
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: reqPath,
      method,
      headers: payload ? {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      } : {}
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf8"),
          ms: Date.now() - started
        });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) {
      req.end(payload);
    } else {
      req.end();
    }
  });
}

async function waitForHybridConfigEndpoint(port, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const result = await httpJsonRequest(port, "GET", "/api/config", null, 1000);
      if (result.status === 200) {
        return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("hybrid-server did not become ready on port " + port);
}

test("sanitizeAnthropicMessages strips unsigned thinking and keeps signed thinking", () => {
  const messages = [{
    role: "assistant",
    content: [{
      type: "thinking",
      thinking: "unsigned"
    }, {
      type: "thinking",
      thinking: "signed",
      signature: "sig"
    }, {
      type: "text",
      text: "done"
    }]
  }];

  const result = sanitizeAnthropicMessages(messages);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].content, [{
    type: "thinking",
    thinking: "signed",
    signature: "sig"
  }, {
    type: "text",
    text: "done"
  }]);
});

test("sanitizeAnthropicMessages normalizes Bedrock-incompatible tool ids", () => {
  const messages = [{
    role: "assistant",
    content: [{
      type: "tool_use",
      id: "toolu_01.bad:id",
      name: "read_file",
      input: {
        path: "a.txt"
      }
    }]
  }, {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "toolu_01.bad:id",
      content: "ok"
    }]
  }];

  const result = sanitizeAnthropicMessages(messages);
  const toolUseId = result[0].content[0].id;

  assert.match(toolUseId, /^[a-zA-Z0-9_-]+$/);
  assert.notEqual(toolUseId, "toolu_01.bad:id");
  assert.equal(result[1].content[0].tool_use_id, toolUseId);
});

test("toInjectedTailMessage marks runtime injections as volatile tail", () => {
  assert.deepEqual(toInjectedTailMessage({
    role: "user",
    content: "hello"
  }), {
    role: "user",
    content: "hello",
    _volatileTail: true
  });
});

test("splitSseFrames supports LF and CRLF separators", () => {
  assert.deepEqual(splitSseFrames("data: one\n\ndata: two\r\n\r\ndata: partial"), {
    frames: ["data: one", "data: two"],
    remainder: "data: partial"
  });
  assert.deepEqual(splitSseFrames("data: one\r\n\r\n"), {
    frames: ["data: one"],
    remainder: ""
  });
});

test("filterForwardedTools supports allow and deny filters", () => {
  const oldAllow = process.env.TOOL_ALLOWLIST;
  const oldDenyPrefixes = process.env.TOOL_DENY_PREFIXES;
  try {
    process.env.TOOL_ALLOWLIST = "read_file,edit,mcp1_*";
    process.env.TOOL_DENY_PREFIXES = "mcp3_";
    const tools = [{
      name: "read_file"
    }, {
      name: "run_command"
    }, {
      name: "mcp1_fetch-doc"
    }, {
      name: "mcp3_get_script_source"
    }];
    assert.deepEqual(filterForwardedTools(tools).map(tool => tool.name), ["read_file", "mcp1_fetch-doc"]);
  } finally {
    if (oldAllow === undefined) {
      delete process.env.TOOL_ALLOWLIST;
    } else {
      process.env.TOOL_ALLOWLIST = oldAllow;
    }
    if (oldDenyPrefixes === undefined) {
      delete process.env.TOOL_DENY_PREFIXES;
    } else {
      process.env.TOOL_DENY_PREFIXES = oldDenyPrefixes;
    }
  }
});

test("sanitizeLogBody redacts structured secrets", () => {
  const body = JSON.stringify({
    api_key: "sk-1234567890abcdef",
    token: "Bearer abcdefghijklmnop",
    nested: {
      password: "secret-value"
    },
    detail: "ok"
  });
  const sanitized = sanitizeLogBody(body);
  assert.match(sanitized, /"api_key":"\[REDACTED\]"/);
  assert.match(sanitized, /"token":"\[REDACTED\]"/);
  assert.match(sanitized, /"password":"\[REDACTED\]"/);
  assert.doesNotMatch(sanitized, /1234567890abcdef|abcdefghijklmnop|secret-value/);
});

test("normalizeOpenAIPromptCacheMode normalizes invalid values to observe", () => {
  assert.equal(normalizeOpenAIPromptCacheMode("AUTO"), "auto");
  assert.equal(normalizeOpenAIPromptCacheMode("off"), "off");
  assert.equal(normalizeOpenAIPromptCacheMode("unexpected"), "observe");
  assert.equal(normalizeOpenAIPromptCacheMode(""), "observe");
});

test("prepareToolsForPromptCache keeps OpenAI tools unchanged when mode is off", () => {
  const tools = [{
    name: "zebra"
  }, {
    name: "alpha"
  }];
  const prepared = prepareToolsForPromptCache(tools, "openai", {
    config: {
      enabled: true,
      openaiMode: "off",
      sortTools: true
    }
  });
  assert.equal(prepared, tools);
  assert.deepEqual(prepared.map(tool => tool.name), ["zebra", "alpha"]);
});

test("prepareToolsForPromptCache respects global disable switch for Anthropic too", () => {
  const tools = [{
    name: "zebra"
  }, {
    name: "alpha"
  }];
  const prepared = prepareToolsForPromptCache(tools, "anthropic", {
    config: {
      enabled: false,
      openaiMode: "observe",
      sortTools: true
    }
  });
  assert.equal(prepared, tools);
  assert.deepEqual(prepared.map(tool => tool.name), ["zebra", "alpha"]);
});

test("prepareToolsForPromptCache canonicalizes OpenAI tool order and nested schema keys", () => {
  const prepared = prepareToolsForPromptCache([{
    name: "same",
    input_schema: {
      z: 1,
      a: 2
    }
  }, {
    name: "alpha",
    input_schema: {
      b: 1,
      a: 1
    }
  }], "openai", {
    config: {
      enabled: true,
      openaiMode: "observe",
      sortTools: true
    }
  });
  assert.deepEqual(prepared.map(tool => tool.name), ["alpha", "same"]);
  assert.equal(JSON.stringify(prepared[0]), "{\"input_schema\":{\"a\":1,\"b\":1},\"name\":\"alpha\"}");
  assert.equal(JSON.stringify(prepared[1]), "{\"input_schema\":{\"a\":2,\"z\":1},\"name\":\"same\"}");
});

test("requiresConfiguredDefaultModel allows __DEFAULT__ models when default model is configured", () => {
  setRuntimeConfig({
    defaultModel: "gpt-5.5",
    BYOK1_MODEL: "gpt-5.5"
  });
  assert.equal(requiresConfiguredDefaultModel("MODEL_GOOGLE_GEMINI_2_5_FLASH"), false);
  assert.equal(requiresConfiguredDefaultModel("MODEL_CHAT"), false);
  assert.equal(requiresConfiguredDefaultModel("MODEL_CLAUDE_4_OPUS"), false);
});

test("requiresConfiguredDefaultModel blocks __DEFAULT__ models when default model is missing", () => {
  setRuntimeConfig({
    defaultModel: "",
    DEFAULT_MODEL: "",
    BYOK1_MODEL: ""
  });
  assert.equal(requiresConfiguredDefaultModel("MODEL_GOOGLE_GEMINI_2_5_FLASH"), true);
  assert.equal(requiresConfiguredDefaultModel("MODEL_CHAT"), true);
});

test("requiresConfiguredDefaultModel blocks missing BYOK slot models independently", () => {
  setRuntimeConfig({
    defaultModel: "gpt-5.5",
    BYOK1_MODEL: "gpt-5.5",
    BYOK2_MODEL: ""
  });
  assert.equal(requiresConfiguredDefaultModel("MODEL_CLAUDE_4_OPUS_BYOK"), false);
  assert.equal(requiresConfiguredDefaultModel("MODEL_CLAUDE_4_OPUS_THINKING_BYOK"), true);
});

test("handleConfigRequest applies POST body when hybrid passes buffered body", async () => {
  setRuntimeConfig({
    defaultModel: "",
    BYOK1_MODEL: ""
  });
  let status = 0;
  let body = "";
  const req = {
    method: "POST",
    headers: {},
    socket: {
      remoteAddress: "127.0.0.1"
    }
  };
  const res = {
    writeHead(code) {
      status = code;
    },
    end(payload) {
      body = payload;
    }
  };
  await handleConfigRequest(req, res, JSON.stringify({
    defaultModel: "claude-sonnet-4-6",
    BYOK1_MODEL: "claude-sonnet-4-6",
    BYOK2_MODEL: "claude-opus-4-8-thinking",
    OPENAI_SERVICE_TIER: "FAST",
    BYOK1_OPENAI_SERVICE_TIER: "fast",
    BYOK2_OPENAI_SERVICE_TIER: "slow"
  }));
  assert.equal(status, 200);
  const parsed = JSON.parse(body);
  assert.equal(parsed.defaultModel, "claude-sonnet-4-6");
  assert.equal(parsed.byok2.model, "claude-opus-4-8-thinking");
  assert.equal(parsed.openaiServiceTier, "fast");
  assert.equal(parsed.byok1.serviceTier, "fast");
  assert.equal(parsed.byok2.serviceTier, "");
});

test("system prompt override hot reload reads updated prompt file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-prompt-"));
  const promptPath = path.join(dir, "system-prompt.md");
  fs.writeFileSync(promptPath, "first prompt\n", "utf8");
  clearSystemPromptCache();
  assert.equal(applySystemPromptOverride("base", {
    systemPromptOverride: true,
    systemPromptPath: promptPath
  }), "first prompt");
  await new Promise(resolve => setTimeout(resolve, 5));
  fs.writeFileSync(promptPath, "second prompt\n", "utf8");
  assert.equal(applySystemPromptOverride("base", {
    systemPromptOverride: true,
    systemPromptPath: promptPath,
    systemPromptVersion: String(Date.now())
  }), "second prompt");
});

test("parseGetChatMessageRequest applies runtime system prompt override", () => {
  setRuntimeConfig({
    systemPromptOverride: true,
    systemPromptText: "runtime custom prompt",
    systemPromptVersion: String(Date.now()),
    BYOK1_MODEL: "claude-sonnet-4-6",
    defaultModel: "claude-sonnet-4-6"
  });
  const proto = Buffer.concat([
    writeStringField(2, "base system prompt"),
    writeStringField(6, "hello"),
    writeStringField(21, "MODEL_CLAUDE_4_OPUS_BYOK")
  ]);
  const parsed = parseGetChatMessageRequest(wrapEnvelope(proto, false), {});
  assert.equal(parsed.systemPrompt, "runtime custom prompt");
  setRuntimeConfig({
    systemPromptOverride: false,
    systemPromptText: "",
    systemPromptVersion: ""
  });
});

test("shouldFallbackToChatCompletions detects unsupported responses gateways", () => {
  assert.equal(shouldFallbackToChatCompletions(500, JSON.stringify({
    error: {
      code: "convert_request_failed",
      message: "not implemented"
    }
  })), true);
  assert.equal(shouldFallbackToChatCompletions(401, "not implemented"), false);
});

test("toChatCompletionsMessages converts tool use and tool result", () => {
  const result = toChatCompletionsMessages("sys", [{
    role: "assistant",
    content: [{
      type: "text",
      text: "calling"
    }, {
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: {
        path: "a.txt"
      }
    }]
  }, {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "call_1",
      content: "ok"
    }]
  }]);

  assert.equal(result[0].role, "system");
  assert.equal(result[1].tool_calls[0].function.name, "read_file");
  assert.equal(result[2].role, "tool");
  assert.equal(result[2].tool_call_id, "call_1");
});

test("buildOpenAIChatCompletionsBody can omit Gemini thinking fields", () => {
  const withThinking = buildOpenAIChatCompletionsBody({
    systemPrompt: "",
    messages: [{
      role: "user",
      content: "hello"
    }],
    resolvedModel: "gemini-3.5-flash",
    thinkingOptions: {
      thinkingEnabled: true,
      reasoningEffort: "low"
    },
    forwardTools: false
  });
  const withoutThinking = buildOpenAIChatCompletionsBody({
    systemPrompt: "",
    messages: [{
      role: "user",
      content: "hello"
    }],
    resolvedModel: "gemini-3.5-flash",
    thinkingOptions: {
      thinkingEnabled: true,
      reasoningEffort: "low"
    },
    forwardTools: false,
    omitGeminiThinking: true
  });

  assert.ok(withThinking.thinking_config || withThinking.extra_body);
  assert.equal(withoutThinking.thinking_config, undefined);
  assert.equal(withoutThinking.extra_body, undefined);
});

test("OpenAI request body builders include fast service tier", () => {
  const input = {
    systemPrompt: "",
    messages: [{
      role: "user",
      content: "hello"
    }],
    resolvedModel: "gpt-5.4",
    serviceTier: "fast",
    thinkingOptions: {
      thinkingEnabled: false
    },
    forwardTools: false
  };
  const responses = buildOpenAIResponsesBody(input);
  const chat = buildOpenAIChatCompletionsBody(input);

  assert.equal(responses.service_tier, "fast");
  assert.equal(chat.service_tier, "fast");
});

test("runtime OpenAI service tier config is sanitized and slot-aware", () => {
  const current = setRuntimeConfig({
    OPENAI_SERVICE_TIER: "FAST",
    BYOK1_OPENAI_SERVICE_TIER: "fast",
    BYOK2_OPENAI_SERVICE_TIER: "slow"
  });

  assert.equal(current.openaiServiceTier, "fast");
  assert.equal(current.byok1.serviceTier, "fast");
  assert.equal(current.byok2.serviceTier, "");
  assert.equal(getSlotServiceTier(1), "fast");
  assert.equal(getSlotServiceTier(2), "");

  setRuntimeConfig({
    OPENAI_SERVICE_TIER: "",
    BYOK1_OPENAI_SERVICE_TIER: "",
    BYOK2_OPENAI_SERVICE_TIER: ""
  });
});

test("GPT-5.6 Responses body supports max effort and pro mode", () => {
  const responses = buildOpenAIResponsesBody({
    systemPrompt: "",
    messages: [{ role: "user", content: "hello" }],
    resolvedModel: "gpt-5.6-terra",
    serviceTier: "priority",
    thinkingOptions: {
      thinkingEnabled: true,
      reasoningEffort: "max",
      reasoningMode: "pro"
    },
    forwardTools: false
  });

  assert.equal(responses.model, "gpt-5.6-terra");
  assert.equal(responses.reasoning.effort, "max");
  assert.equal(responses.reasoning.mode, "pro");
  assert.equal(responses.service_tier, "priority");
  assert.equal(thinkingEffortToOpenAIReasoningEffort("max", "gpt-5.6-luna"), "max");
  assert.equal(thinkingEffortToOpenAIReasoningEffort("max", "gpt-5.4"), "xhigh");
});

test("GPT-5.6 mode is omitted from Chat Completions fallback", () => {
  const chat = buildOpenAIChatCompletionsBody({
    systemPrompt: "",
    messages: [{ role: "user", content: "hello" }],
    resolvedModel: "gpt-5.6-sol",
    thinkingOptions: {
      thinkingEnabled: true,
      reasoningEffort: "max",
      reasoningMode: "pro"
    },
    forwardTools: false
  });

  assert.equal(chat.reasoning_effort, "max");
  assert.equal(chat.reasoning, undefined);
});

test("runtime GPT-5.6 reasoning mode is sanitized and slot-aware", () => {
  const current = setRuntimeConfig({
    OPENAI_REASONING_MODE: "PRO",
    BYOK1_OPENAI_REASONING_MODE: "standard",
    BYOK2_OPENAI_REASONING_MODE: "invalid",
    BYOK1_OPENAI_SERVICE_TIER: "priority"
  });

  assert.equal(current.openaiReasoningMode, "pro");
  assert.equal(getSlotReasoningMode(1), "standard");
  assert.equal(getSlotReasoningMode(2), "");
  assert.equal(getSlotServiceTier(1), "priority");

  setRuntimeConfig({
    OPENAI_REASONING_MODE: "",
    BYOK1_OPENAI_REASONING_MODE: "",
    BYOK2_OPENAI_REASONING_MODE: "",
    BYOK1_OPENAI_SERVICE_TIER: ""
  });
});

test("Claude 4 Bedrock model ids use adaptive thinking", () => {
  const model = "us.anthropic.claude-sonnet-4-20250514-v1:0";
  const payload = buildAnthropicThinkingPayload(model, "high");

  assert.equal(supportsAdaptiveClaudeThinking(model), true);
  assert.deepEqual(payload, {
    thinking: {
      type: "adaptive"
    },
    output_config: {
      effort: "high"
    }
  });
});

test("Claude 4 regional aliases use adaptive thinking", () => {
  const model = "Claude-jp-opus-4-8-thinking";
  const payload = buildAnthropicThinkingPayload(model, "medium");

  assert.equal(supportsAdaptiveClaudeThinking(model), true);
  assert.equal(payload.thinking.type, "adaptive");
  assert.equal(payload.output_config.effort, "medium");
});

test("thinking effort options distinguish default from explicit off", () => {
  const html = buildThinkingEffortOptionsHtml("claude-opus-4-8", "off");

  assert.equal(sanitizeThinkingEffort("off"), "off");
  assert.match(html, /<option value="">默认 · 按模型\/槽位决定<\/option>/);
  assert.match(html, /<option value="off" selected>关闭 · 不启用思考<\/option>/);
});

test("BYOK #2 Claude defaults an unset thinking effort to medium", () => {
  setRuntimeConfig({
    BYOK2_MODEL: "claude-opus-4-8",
    BYOK2_THINKING_EFFORT: ""
  });

  assert.deepEqual(buildThinkingOptions("claude-opus-4-8", false, 2), {
    thinkingEnabled: true,
    reasoningEffort: "medium",
    thinkingBudget: 10000,
    provider: "claude"
  });
});

test("BYOK #2 Claude respects an explicit off thinking effort", () => {
  setRuntimeConfig({
    BYOK2_MODEL: "claude-opus-4-8",
    BYOK2_THINKING_EFFORT: "off"
  });

  assert.deepEqual(buildThinkingOptions("claude-opus-4-8", false, 2), {
    thinkingEnabled: false,
    reasoningEffort: "",
    thinkingBudget: 0,
    provider: "claude"
  });
});

test("BYOK #2 Claude enables thinking when an effort is configured", () => {
  setRuntimeConfig({
    BYOK2_MODEL: "claude-opus-4-8",
    BYOK2_THINKING_EFFORT: "high"
  });

  assert.deepEqual(buildThinkingOptions("claude-opus-4-8", false, 2), {
    thinkingEnabled: true,
    reasoningEffort: "high",
    thinkingBudget: 20000,
    provider: "claude"
  });
});

test("gateway capability cache uses detailed keys and can be cleared", () => {
  _setGatewayCapabilityCachePathForTests("");
  clearGatewayCapabilityCache();
  const key = buildGatewayCapabilityKey({
    protocol: "https",
    host: "api.example.com",
    port: 443,
    apiPath: "/v1/responses",
    providerKind: "openai",
    slot: 1
  });

  markGatewayCapability(key, {
    preferChatCompletions: true,
    reason: "responses rejected"
  });

  assert.equal(getGatewayCapability(key).preferChatCompletions, true);
  assert.equal(_getGatewayCapabilityCacheSizeForTests(), 1);
  clearGatewayCapabilityCache();
  assert.equal(getGatewayCapability(key), null);
});

test("gateway capability cache can persist to disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "byok-gateway-cache-"));
  const cachePath = path.join(dir, "capabilities.json");
  const key = buildGatewayCapabilityKey({
    protocol: "http",
    host: "127.0.0.1",
    port: 8787,
    apiPath: "/v1/responses",
    providerKind: "openai",
    slot: "default"
  });
  try {
    _setGatewayCapabilityCachePathForTests(cachePath);
    markGatewayCapability(key, {
      preferChatCompletions: true,
      reason: "responses rejected: HTTP 400"
    });
    assert.equal(fs.existsSync(cachePath), true);

    _resetGatewayCapabilityMemoryForTests();
    assert.equal(getGatewayCapability(key).preferChatCompletions, true);
    assert.equal(getGatewayCapability(key).reason, "responses rejected: HTTP 400");
  } finally {
    _setGatewayCapabilityCachePathForTests("");
    fs.rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});

test("gateway URL inference preserves explicit protocol and infers local HTTP", () => {
  assert.equal(gatewayUrl.ensureGatewayUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(gatewayUrl.ensureGatewayUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(gatewayUrl.ensureGatewayUrl("api.example.com"), "https://api.example.com");
  assert.equal(gatewayUrl.ensureGatewayUrl("http://api.example.com:8080"), "http://api.example.com:8080");
  assert.equal(gatewayUrl.shouldUseHttpGateway("api.example.com:8080"), true);
});

test("provider base URL parsing preserves the user input and derives runtime host/path", () => {
  assert.deepEqual(gatewayUrl.parseProviderBaseUrl("https://modelservice.jdcloud.com/v1", "/messages"), {
    input: "https://modelservice.jdcloud.com/v1",
    host: "modelservice.jdcloud.com",
    apiPath: "/v1/messages"
  });

  assert.deepEqual(gatewayUrl.parseProviderBaseUrl("https://modelservice.jdcloud.com/anthropic", "/responses"), {
    input: "https://modelservice.jdcloud.com/anthropic",
    host: "modelservice.jdcloud.com",
    apiPath: "/anthropic/responses"
  });
});

test("bufferedResponseHeaders strips transfer encoding and stale content length", () => {
  const headers = bufferedResponseHeaders({
    "content-type": "application/proto",
    "Content-Length": "999",
    "transfer-encoding": "chunked",
    connection: "keep-alive",
    "x-request-id": "req-1"
  }, 12);

  assert.equal(headers["transfer-encoding"], undefined);
  assert.equal(headers["Content-Length"], undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers["content-length"], 12);
  assert.equal(headers["x-request-id"], "req-1");
});

test("external config importer reads Claude and Codex user config files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "byok-import-"));
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://claude.example.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-claude",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8"
    }
  }));
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({
    OPENAI_API_KEY: "sk-openai"
  }));
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), [
    "model_provider = \"custom\"",
    "model = \"gpt-5.5\"",
    "",
    "[model_providers.custom]",
    "base_url = \"https://openai.example.com/v1\""
  ].join("\n"));

  const claude = readClaudeUserConfig(home);
  const codex = readCodexUserConfig(home);

  assert.equal(claude.ok, true);
  assert.equal(claude.host, "claude.example.com/anthropic");
  assert.equal(claude.baseUrl, "https://claude.example.com/anthropic");
  assert.equal(claude.model, "claude-opus-4-8");
  assert.equal(codex.ok, true);
  assert.equal(codex.host, "openai.example.com/v1");
  assert.equal(codex.baseUrl, "https://openai.example.com/v1");
  assert.equal(codex.model, "gpt-5.5");
});

test("shouldInterceptByokChat only matches BYOK entry models", () => {
  function buildChatBody(modelId) {
    const proto = Buffer.concat([
      writeStringField(2, "system"),
      writeStringField(21, modelId)
    ]);
    return wrapEnvelope(proto, false);
  }
  const headers = {};

  assert.equal(getByokSlot("MODEL_CLAUDE_4_OPUS_BYOK"), 1);
  assert.equal(getByokSlot("MODEL_CLAUDE_4_OPUS_THINKING_BYOK"), 2);
  assert.equal(getByokSlot("MODEL_CLAUDE_4_OPUS"), null);

  assert.equal(shouldInterceptByokChat(buildChatBody("MODEL_CLAUDE_4_OPUS_BYOK"), headers), true);
  assert.equal(shouldInterceptByokChat(buildChatBody("MODEL_CLAUDE_4_OPUS_THINKING_BYOK"), headers), true);
  assert.equal(shouldInterceptByokChat(buildChatBody("MODEL_CLAUDE_4_OPUS"), headers), false);
  assert.equal(shouldInterceptByokChat(buildChatBody("MODEL_SWE_1_5"), headers), false);
  assert.equal(peekRequestedModel(buildChatBody("MODEL_CLAUDE_4_OPUS_BYOK"), headers), "MODEL_CLAUDE_4_OPUS_BYOK");
});

test("applyAnthropicPromptCache marks system tools and message prefix", () => {
  const body = applyAnthropicPromptCache({
    model: "claude-sonnet-4-20250514",
    system: "system prompt",
    messages: [{
      role: "user",
      content: "one"
    }, {
      role: "assistant",
      content: "two"
    }, {
      role: "user",
      content: "three"
    }, {
      role: "assistant",
      content: "four"
    }],
    tools: [{
      name: "alpha",
      description: "a"
    }, {
      name: "beta",
      description: "b"
    }]
  }, {
    enabled: true,
    anthropic: true,
    tailMessages: 2
  });

  assert.equal(Array.isArray(body.system), true);
  assert.equal(body.system[0].cache_control.type, "ephemeral");
  assert.equal(body.tools[1].cache_control.type, "ephemeral");
  assert.equal(body.messages[1].content[0].cache_control.type, "ephemeral");
  assert.equal(body.messages[2].content?.[0]?.cache_control, undefined);
  assert.equal(body.messages[3].content?.[0]?.cache_control, undefined);
});

test("applyAnthropicPromptCache preserves additional volatile tail messages", () => {
  const body = applyAnthropicPromptCache({
    model: "claude-sonnet-4-20250514",
    messages: [{
      role: "user",
      content: "one"
    }, {
      role: "assistant",
      content: "two"
    }, {
      role: "user",
      content: "three"
    }, {
      role: "assistant",
      content: "four"
    }]
  }, {
    enabled: true,
    anthropic: true,
    tailMessages: 1,
    additionalTailMessages: 1
  });

  assert.equal(body.messages[1].content[0].cache_control.type, "ephemeral");
  assert.equal(body.messages[2].content?.[0]?.cache_control, undefined);
  assert.equal(body.messages[3].content?.[0]?.cache_control, undefined);
});

test("shouldRetryWithoutPromptCache detects cache-related upstream errors", () => {
  assert.equal(shouldRetryWithoutPromptCache(400, "cache_control is not supported"), true);
  assert.equal(shouldRetryWithoutPromptCache(422, "invalid prompt caching breakpoint"), true);
  assert.equal(shouldRetryWithoutPromptCache(500, "upstream timeout"), false);
});

test("sortToolsForStablePrefix orders tools by name", () => {
  const sorted = sortToolsForStablePrefix([{
    name: "zebra"
  }, {
    name: "alpha"
  }], {
    config: {
      sortTools: true
    }
  });
  assert.deepEqual(sorted.map(tool => tool.name), ["alpha", "zebra"]);
});

test("mergeUsage accepts null base from stream processors", () => {
  const usage = mergeUsage(null, {
    input_tokens: 1000,
    output_tokens: 50,
    cached_tokens: 800
  });
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.cached_tokens, 800);
});

test("mergeUsage tolerates missing and non-object usage patches", () => {
  assert.deepEqual(mergeUsage(null, null), {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cached_tokens: 0
  });
  assert.deepEqual(mergeUsage("bad", "bad"), {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cached_tokens: 0
  });
});

test("OpenAI response.completed without usage does not crash stream processor", () => {
  const processor = new OpenAIStreamProcessor("msg-1", "gpt-test");
  const chunks = processor.processEvent({
    done: false,
    type: "response.completed",
    data: {
      type: "response.completed",
      response: {
        status: "completed"
      }
    }
  });
  assert.equal(processor.isDone, true);
  assert.equal(processor.stopReason, "stop");
  assert.ok(Array.isArray(chunks));
});

test("formatUsageLog tolerates non-object usage and meta", () => {
  const line = formatUsageLog(null, "OpenAI", "bad");
  assert.match(line, /OpenAI tokens: input=0/);
  assert.match(line, /cached=0/);
});

test("formatUsageLog reports cache hit rate", () => {
  const usage = extractOpenAIResponsesUsage({
    data: {
      response: {
        usage: {
          input_tokens: 100000,
          output_tokens: 500,
          input_tokens_details: {
            cached_tokens: 92000
          }
        }
      }
    }
  });
  assert.equal(computeCacheHitRate(usage), 92);
  assert.match(formatUsageLog(usage, "OpenAI"), /cached=92000/);
  assert.match(formatUsageLog(usage, "OpenAI"), /hit=92%/);
});

test("formatUsageLog includes cache metadata fields", () => {
  const usage = {
    input_tokens: 1200,
    output_tokens: 80,
    cached_tokens: 600
  };
  const line = formatUsageLog(usage, "OpenAI", {
    mode: "responses",
    route: "/v1/responses",
    cacheStatus: "eligible",
    requestBytes: 4096,
    fallback: "responses-to-chat"
  });
  assert.match(line, /mode=responses/);
  assert.match(line, /route=\/v1\/responses/);
  assert.match(line, /cache=eligible/);
  assert.match(line, /req=4096b/);
  assert.match(line, /fallback=responses-to-chat/);
});

test("PatchManager recognizes dynamic loopback patch URLs", () => {
  const rules = [{
    name: "P1: mock",
    originalRegex: /([A-Za-z_$][\w$]*)\.getApiServerUrlFromContext=([A-Za-z_$][\w$]*)=>\{return"old"\}/
  }, {
    name: "P2: mock",
    originalRegex: /async restart\(([A-Za-z_$][\w$]*)\)\{this\.apiServerUrl=\1,this\.inputs\.apiServerUrl=\1,/
  }, {
    name: "P3: mock",
    originalRegex: /const ([A-Za-z_$][\w$]*)=oldInference/
  }];
  let content = 'e.getApiServerUrlFromContext=A=>{return"old"}\nasync restart(A){this.apiServerUrl=A,this.inputs.apiServerUrl=A,\nconst i=oldInference';
  content = PatchManager.applyPatchContent(content, rules[0], "http://127.0.0.1:3333", "http://127.0.0.1:4444").content;
  content = PatchManager.applyPatchContent(content, rules[1], "http://127.0.0.1:3333", "http://127.0.0.1:4444").content;
  content = PatchManager.applyPatchContent(content, rules[2], "http://127.0.0.1:3333", "http://127.0.0.1:4444").content;

  assert.match(content, /127\.0\.0\.1:3333/);
  assert.match(content, /127\.0\.0\.1:4444/);
  assert.equal(PatchManager.isPatched(content, rules[0], "http://127.0.0.1:3333", "http://127.0.0.1:4444"), true);
  assert.equal(PatchManager.isPatched(content, rules[2], "http://127.0.0.1:3333", "http://127.0.0.1:4444"), true);
});

test("hybrid-server POST /api/config hot reload responds without timeout", {
  timeout: 15000
}, async () => {
  const port = 31997;
  const child = spawn(process.execPath, ["src/hybrid-server.js"], {
    cwd: proxyRoot,
    env: {
      ...process.env,
      HYBRID_PORT: String(port),
      BIND_HOST: "127.0.0.1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForHybridConfigEndpoint(port);
    const posted = await httpJsonRequest(port, "POST", "/api/config", {
      defaultModel: "integration-test-model",
      BYOK1_MODEL: "integration-test-model",
      BYOK2_MODEL: "integration-test-thinking",
      OPENAI_SERVICE_TIER: "fast",
      BYOK1_OPENAI_SERVICE_TIER: "fast",
      BYOK2_OPENAI_SERVICE_TIER: "fast",
      SYSTEM_PROMPT_OVERRIDE: true,
      systemPromptText: "integration prompt",
      systemPromptVersion: String(Date.now())
    }, 2000);
    assert.equal(posted.status, 200, posted.body);
    assert.ok(posted.ms < 2000, "POST /api/config took " + posted.ms + "ms");
    const updated = JSON.parse(posted.body);
    assert.equal(updated.defaultModel, "integration-test-model");
    assert.equal(updated.byok2.model, "integration-test-thinking");
    assert.equal(updated.openaiServiceTier, "fast");
    assert.equal(updated.byok1.serviceTier, "fast");
    assert.equal(updated.byok2.serviceTier, "fast");
    const fetched = await httpJsonRequest(port, "GET", "/api/config");
    assert.equal(fetched.status, 200);
    const current = JSON.parse(fetched.body);
    assert.equal(current.defaultModel, "integration-test-model");
    assert.equal(current.byok2.model, "integration-test-thinking");
    assert.equal(current.openaiServiceTier, "fast");
    assert.equal(current.byok1.serviceTier, "fast");
    assert.equal(current.byok2.serviceTier, "fast");
    assert.equal(current.systemPromptOverride, true);
    assert.equal(current.systemPromptText, "integration prompt");
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
});
