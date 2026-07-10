import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  dedupeOptions,
  buildModelPickerItems,
  detectProvider,
  buildChoicePickerItems,
  buildModelFetchUiState
} = require("../media/modelPickerCore.js");

test("model picker keeps a selected custom model before loaded options", () => {
  const options = dedupeOptions([{
    id: "claude-sonnet-4-5-20250929"
  }, {
    id: "gpt-5.4"
  }], "custom-router-model");

  assert.deepEqual(options.map(option => option.value), [
    "custom-router-model",
    "claude-sonnet-4-5-20250929",
    "gpt-5.4"
  ]);
});

test("model picker offers custom model when search has no exact match", () => {
  const result = buildModelPickerItems([{
    id: "claude-sonnet-4-5-20250929"
  }], "", "ffff");

  assert.equal(result.showCustom, true);
  assert.equal(result.customValue, "ffff");
  assert.equal(result.items.length, 0);
});

test("model picker filters by provider and detects common model families", () => {
  const result = buildModelPickerItems([{
    id: "claude-sonnet-4-5-20250929"
  }, {
    id: "gpt-5.4"
  }, {
    id: "gemini-3.5-flash"
  }], "", "gpt");

  assert.deepEqual(result.items.map(option => option.value), ["gpt-5.4"]);
  assert.equal(detectProvider("claude-sonnet-4-5-20250929"), "claude");
  assert.equal(detectProvider("gpt-5.4"), "gpt");
  assert.equal(detectProvider("gemini-3.5-flash"), "gemini");
});

test("choice picker normalizes native select options and marks selected item", () => {
  const result = buildChoicePickerItems([{
    value: "",
    label: "默认 · 不覆盖 service_tier"
  }, {
    value: "fast",
    label: "Fast · service_tier=fast"
  }], "fast");

  assert.deepEqual(result, [{
    value: "",
    label: "默认 · 不覆盖 service_tier",
    selected: false
  }, {
    value: "fast",
    label: "Fast · service_tier=fast",
    selected: true
  }]);
});

test("model fetch failure uses a neutral UI state without leaking exception text", () => {
  const result = buildModelFetchUiState({
    error: "HTTP 404: upstream stack trace",
    count: 0,
    slot: 1
  });

  assert.equal(result.statusText, "未获取到模型列表，可直接输入自定义模型名");
  assert.equal(result.statusColor, "#fbbf24");
  assert.equal(result.actionState, null);
  assert.equal(result.actionMessage, "");
  assert.equal(JSON.stringify(result).includes("HTTP 404"), false);
  assert.equal(JSON.stringify(result).includes("stack trace"), false);
});

test("model fetch empty result uses a neutral UI state", () => {
  const result = buildModelFetchUiState({
    error: "",
    count: 0,
    slot: 2
  });

  assert.equal(result.statusText, "未获取到模型列表，可直接输入自定义模型名");
  assert.equal(result.statusColor, "#fbbf24");
  assert.equal(result.actionState, null);
  assert.equal(result.actionMessage, "");
});

test("model fetch success keeps the existing success UI state", () => {
  const result = buildModelFetchUiState({
    error: "",
    count: 3,
    slot: 2
  });

  assert.equal(result.statusText, "已加载 3 个模型");
  assert.equal(result.statusColor, "#34d399");
  assert.equal(result.actionState, "success");
  assert.equal(result.actionMessage, "BYOK #2 已加载 3 个模型");
});
