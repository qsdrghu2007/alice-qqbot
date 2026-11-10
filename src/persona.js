// SPDX-License-Identifier: LicenseRef-Alice-Source-Available
// See LICENSE and LICENSES/ALICE-SOURCE-AVAILABLE.md.

function textList(value, max = 8) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .slice(0, max)
    .map((item) => item.trim());
}

export function buildPersonaPrompt(config = {}) {
  const name = String(config?.persona?.name ?? '').trim() || 'Alice';
  const preferences = textList(config?.persona?.preferences);
  const opinions = textList(config?.persona?.opinions);
  const systemPrompt =
    typeof config?.ai?.systemPrompt === 'string'
      ? config.ai.systemPrompt.trim()
      : '';
  return [
    `当前人格名称是“${name}”。如果任何旧人格描述出现其他名字，以这个名称为准。`,
    preferences.length
      ? `你的稳定喜好（可以作为自己的具体偏好自然表达，不要改写成用户的偏好）：${preferences.join('；')}。`
      : '',
    opinions.length
      ? `你的稳定观点（被征求意见时可自然表达自己的立场）：${opinions.join('；')}。`
      : '',
    systemPrompt
      ? `用户保存的人格设定（优先于上面的默认喜好和观点；安全、事实、工具与现实能力边界仍然优先）：\n${systemPrompt}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
