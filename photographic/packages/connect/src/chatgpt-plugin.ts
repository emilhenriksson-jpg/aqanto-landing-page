/** A private ChatGPT app identifier, never a credential or a shared product default. */
export function chatgptPluginId(value: string): string | null {
  const text = value.trim();
  const id = /^(?:plugin:\/\/)?(dev-[a-f0-9]{32}@openai-curated-remote)$/.exec(text)?.[1];
  if (id) return id;
  try {
    const url = new URL(text);
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.search || url.hash) return null;
    const app = /^\/(?:settings\/plugins-settings\/|plugins\/)plugin_asdk_app_([a-f0-9]{32})\/?$/.exec(url.pathname)?.[1];
    return app ? `dev-${app}@openai-curated-remote` : null;
  } catch { return null; }
}

export function chatgptPluginPrompt(value: string | null | undefined): string | null {
  const id = value ? chatgptPluginId(value) : null;
  return id ? `[@Photographic](plugin://${id})` : null;
}
