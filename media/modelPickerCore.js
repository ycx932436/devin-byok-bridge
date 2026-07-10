'use strict';

(function initModelPickerCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ModelPickerCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : undefined, function createModelPickerCore() {
  function normalizeText(value) {
    return String(value == null ? '' : value).trim();
  }

  function optionValue(option) {
    if (typeof option === 'string') {
      return normalizeText(option);
    }
    return normalizeText(option && (option.id || option.value || option.name));
  }

  function optionLabel(option) {
    if (typeof option === 'string') {
      return normalizeText(option);
    }
    return normalizeText(option && (option.label || option.text || option.name || option.id || option.value));
  }

  function detectProvider(model) {
    const normalized = normalizeText(model).toLowerCase().replace(/-thinking$/i, '');
    if (/^gemini-|^model_google_gemini|^models\/gemini-/.test(normalized)) {
      return 'gemini';
    }
    if (/^gpt-|^o[0-9][a-z0-9.-]*|^chatgpt-|^model_gpt/.test(normalized)) {
      return 'gpt';
    }
    if (/^claude-|^model_claude/.test(normalized)) {
      return 'claude';
    }
    return '';
  }

  function normalizeOption(option) {
    const value = optionValue(option);
    if (!value) {
      return null;
    }
    const label = optionLabel(option) || value;
    const provider = normalizeText(option && option.provider).toLowerCase() || detectProvider(value);
    return {
      value,
      label,
      provider
    };
  }

  function dedupeOptions(options, selected) {
    const seen = new Set();
    const result = [];
    const selectedValue = normalizeText(selected);
    if (selectedValue) {
      seen.add(selectedValue);
      result.push({
        value: selectedValue,
        label: selectedValue,
        provider: detectProvider(selectedValue)
      });
    }
    for (const option of options || []) {
      const normalized = normalizeOption(option);
      if (!normalized || seen.has(normalized.value)) {
        continue;
      }
      seen.add(normalized.value);
      result.push(normalized);
    }
    return result;
  }

  function buildModelPickerItems(options, selected, query) {
    const search = normalizeText(query).toLowerCase();
    const normalized = dedupeOptions(options, selected);
    const filtered = search ? normalized.filter(option => {
      return option.value.toLowerCase().includes(search) ||
        option.label.toLowerCase().includes(search) ||
        option.provider.toLowerCase().includes(search);
    }) : normalized;
    const customValue = normalizeText(query);
    const hasExact = customValue && normalized.some(option => option.value.toLowerCase() === customValue.toLowerCase());
    return {
      items: filtered,
      customValue: hasExact ? '' : customValue,
      showCustom: !!customValue && !hasExact
    };
  }

  function buildChoicePickerItems(options, selected) {
    const selectedValue = normalizeText(selected);
    return (options || []).map(option => {
      const value = optionValue(option);
      const label = optionLabel(option) || value;
      return {
        value,
        label,
        selected: value === selectedValue
      };
    });
  }

  function buildModelFetchUiState(state) {
    const count = Math.max(0, Number(state && state.count) || 0);
    const slot = normalizeText(state && state.slot);
    if (state && state.error || count === 0) {
      return {
        statusText: '未获取到模型列表，可直接输入自定义模型名',
        statusColor: '#fbbf24',
        actionState: null,
        actionMessage: ''
      };
    }
    return {
      statusText: '已加载 ' + count + ' 个模型',
      statusColor: '#34d399',
      actionState: 'success',
      actionMessage: 'BYOK #' + slot + ' 已加载 ' + count + ' 个模型'
    };
  }

  return {
    normalizeText,
    optionValue,
    optionLabel,
    detectProvider,
    normalizeOption,
    dedupeOptions,
    buildModelPickerItems,
    buildChoicePickerItems,
    buildModelFetchUiState
  };
});
