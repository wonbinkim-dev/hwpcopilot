const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function extractUsage(provider, data, headers) {
  const source = provider === 'gemini' ? data.usageMetadata : data.usage;
  let tokens = null;
  if (source && typeof source === 'object') {
    let input, output, total;
    if (provider === 'gemini') {
      input = number(source.promptTokenCount);
      output = number(source.candidatesTokenCount);
      if (output !== null) output += number(source.thoughtsTokenCount) ?? 0;
      total = number(source.totalTokenCount);
    } else if (provider === 'anthropic') {
      input = number(source.input_tokens);
      if (input !== null) input += (number(source.cache_creation_input_tokens) ?? 0) + (number(source.cache_read_input_tokens) ?? 0);
      output = number(source.output_tokens);
    } else {
      input = number(source.input_tokens ?? source.prompt_tokens);
      output = number(source.output_tokens ?? source.completion_tokens);
      total = number(source.total_tokens);
    }
    if (total === null || total === undefined) total = input !== null && output !== null ? input + output : null;
    if (total !== null || input !== null || output !== null) tokens = { input, output, total };
  }
  const definitions = provider === 'anthropic'
    ? [['입력 토큰', 'anthropic-ratelimit-input-tokens'], ['출력 토큰', 'anthropic-ratelimit-output-tokens'], ['토큰', 'anthropic-ratelimit-tokens'], ['요청', 'anthropic-ratelimit-requests']]
    : [['토큰', 'x-ratelimit-tokens'], ['프로젝트 토큰', 'x-ratelimit-project-tokens'], ['요청', 'x-ratelimit-requests']];
  const limits = [];
  for (const [label, prefix] of definitions) {
    const field = name => provider === 'anthropic' ? `${prefix}-${name}` : `x-ratelimit-${name}-${prefix.replace('x-ratelimit-', '')}`;
    const rawLimit = headers?.get(field('limit'));
    const rawRemaining = headers?.get(field('remaining'));
    if (rawLimit == null || rawRemaining == null || !rawLimit.trim() || !rawRemaining.trim()) continue;
    const limit = Number(rawLimit), remaining = Number(rawRemaining);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining) || remaining < 0) continue;
    limits.push({ label, limit, remaining, usedPercent: Math.round(Math.min(100, Math.max(0, (limit - remaining) / limit * 100))), reset: headers.get(field('reset')) || null });
  }
  return { tokens, limits, observedAt: Date.now() };
}
