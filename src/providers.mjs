export const PROVIDERS = Object.freeze({
  openai: { name: 'OpenAI', key: 'OPENAI_API_KEY' },
  anthropic: { name: 'Anthropic', key: 'ANTHROPIC_API_KEY' },
  google: { name: 'Google Gemini', key: 'GEMINI_API_KEY' },
  groq: { name: 'Groq', key: 'GROQ_API_KEY', endpoint: 'https://api.groq.com/openai/v1/chat/completions' },
  mistral: { name: 'Mistral', key: 'MISTRAL_API_KEY', endpoint: 'https://api.mistral.ai/v1/chat/completions' },
});

function bearer(key) {
  return { authorization: `Bearer ${key}` };
}

function joinText(parts, predicate) {
  return Array.isArray(parts) ? parts.filter(predicate).map(part => part.text).filter(text => typeof text === 'string').join('\n') : '';
}

function tokenUsage(inputTokens, outputTokens) {
  return Number.isSafeInteger(inputTokens) && inputTokens >= 0 &&
    Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? { inputTokens, outputTokens } : undefined;
}

function requestSpec(provider, model, key, prompt) {
  if (provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/responses',
      headers: bearer(key),
      body: { model, input: prompt, max_output_tokens: 2048, store: false },
      unpack: data => ({
        text: joinText(data.output?.flatMap(item => item.content ?? []), part => part.type === 'output_text'),
        usage: tokenUsage(data.usage?.input_tokens, data.usage?.output_tokens),
        model: data.model,
      }),
    };
  }
  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: { model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] },
      unpack: data => ({
        text: joinText(data.content, part => part.type === 'text'),
        usage: tokenUsage(data.usage?.input_tokens, data.usage?.output_tokens),
        model: data.model,
      }),
    };
  }
  if (provider === 'google') {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: { 'x-goog-api-key': key },
      body: { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 2048 } },
      unpack: data => ({
        text: joinText(data.candidates?.[0]?.content?.parts, part => !part.thought),
        usage: tokenUsage(data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount),
        model: data.modelVersion,
      }),
    };
  }
  return {
    url: PROVIDERS[provider].endpoint,
    headers: bearer(key),
    body: { model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] },
    unpack: data => ({
      text: data.choices?.[0]?.message?.content,
      usage: tokenUsage(data.usage?.prompt_tokens, data.usage?.completion_tokens),
      model: data.model,
    }),
  };
}

export function createProvider(env = process.env, transport = fetch) {
  const id = env.AGENT007_PROVIDER?.trim().toLowerCase();
  const model = env.AGENT007_MODEL?.trim();
  const provider = Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : undefined;
  const key = provider && env[provider.key]?.trim();
  const liveConfigured = Boolean(provider && model && key);
  const config = {
    liveConfigured, provider: provider?.name ?? null, model: model || null,
    providers: Object.entries(PROVIDERS).map(([providerId, { name, key: keyName }]) => ({ id: providerId, name, keyName })),
  };
  return {
    config,
    async invoke({ prompt }) {
      if (!liveConfigured) throw new Error('Configure a hosted model before starting a live run.');
      const request = requestSpec(id, model, key, prompt);
      let response;
      try {
        response = await transport(request.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...request.headers },
          body: JSON.stringify(request.body),
          redirect: 'error',
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        throw new Error(error.name === 'TimeoutError' ? 'The hosted model timed out.' : 'The hosted model request could not be completed.');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`${provider.name} returned HTTP ${response.status}. Check your model, API key, or provider limits.`);
      }
      let result;
      try {
        result = request.unpack(await response.json());
      } catch {
        throw new Error(`${provider.name} returned a response that could not be read.`);
      }
      if (typeof result.text !== 'string' || !result.text.trim()) throw new Error(`${provider.name} returned no text.`);
      return { ...result, text: result.text.trim(), model: result.model ?? model };
    },
  };
}
