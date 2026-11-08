/* 線描きSVGアイコン（絵文字は使わない） */
const PATHS: Record<string, React.ReactNode> = {
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.8-3.8" /></>,
  gear: <><circle cx="12" cy="12" r="3.2" /><path d="M19 12a7 7 0 0 0-.14-1.4l2.1-1.63-2-3.46-2.48 1a7 7 0 0 0-2.42-1.4L13.66 2.6h-3.32l-.4 2.51a7 7 0 0 0-2.42 1.4l-2.48-1-2 3.46L5.14 10.6A7 7 0 0 0 5 12c0 .48.05.94.14 1.4l-2.1 1.63 2 3.46 2.48-1a7 7 0 0 0 2.42 1.4l.4 2.51h3.32l.4-2.51a7 7 0 0 0 2.42-1.4l2.48 1 2-3.46-2.1-1.63c.09-.46.14-.92.14-1.4Z" /></>,
  x: <><path d="M6 6l12 12M18 6 6 18" /></>,
  send: <><path d="M12 19V5M5 12l7-7 7 7" /></>,
  stop: <><rect x="7" y="7" width="10" height="10" rx="2" /></>,
  pin: <><path d="m21 12.5-8.5 8.5a5.5 5.5 0 0 1-7.78-7.78L13.5 4.5a3.67 3.67 0 0 1 5.19 5.19l-8.78 8.78a1.83 1.83 0 0 1-2.6-2.6l8.02-8.02" /></>,
  star: <><path d="m12 3.6 2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8L12 3.6Z" /></>,
  check: <><path d="M20 6 9 17l-5-5" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5" /></>,
  pencil: <><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3Z" /></>,
  trash: <><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7" /></>,
  chevron: <><path d="m6 9 6 6 6-6" /></>,
  bot: <><rect x="4" y="8" width="16" height="11" rx="2" /><path d="M12 8V4m0 0h4m-4 0H8" /><circle cx="9" cy="13.5" r="0.6" fill="currentColor" /><circle cx="15" cy="13.5" r="0.6" fill="currentColor" /></>,
  code: <><path d="m8 8-5 4 5 4m8-8 5 4-5 4" /></>,
  codeB: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5M13.5 4l-3 16" /></>,
  download: <><path d="M12 4v11m0 0 4-4m-4 4-4-4M4 19h16" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <><path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5Z" /></>,
  alert: <><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></>,
  ext: <><path d="M14 4h6v6m0-6L10.5 13.5M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" /></>,
  chevR: <><path d="m9 5 7 7-7 7" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.7 2.6 4 5.6 4 9s-1.3 6.4-4 9c-2.7-2.6-4-5.6-4-9s1.3-6.4 4-9Z" /></>,
  doc: <><path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7Z" /><path d="M14 3v4h4M9.5 13h5M9.5 17h5" /></>,
  img: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m5 19 5.5-5.5 3 3L17 13l2 2.5" /></>,
  bulb: <><path d="M9.5 18h5M10.5 21h3M12 3a6 6 0 0 1 3.4 10.9c-.7.6-1.1 1.1-1.3 1.9l-.2.7H10l-.2-.7c-.2-.8-.6-1.3-1.3-1.9A6 6 0 0 1 12 3Z" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5c1.4-3.4 4.2-5 7.5-5s6.1 1.6 7.5 5" /></>,
  dots: <><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" /></>,
  plane: <><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4Z" /></>,
};

export function Icon({ name, className = "ic" }: { name: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/* 公式ロゴ（public/logos/<id>.svg に同梱。出典は DESIGN.md に記録）。
   ロゴが実在しない会社（llama.cpp）はモノグラムのままにする。 */
const LOGO_IDS = new Set([
  "openai", "gemini", "anthropic", "mistral", "groq", "openrouter", "cohere",
  "cloudflare", "sambanova", "deepseek", "xai", "together", "fireworks",
  "cerebras", "perplexity", "nvidia", "huggingface", "replicate", "bedrock",
  "azure", "vertex", "githubmodels", "ai21", "alephalpha", "novita",
  "hyperbolic", "siliconflow", "ollama", "lmstudio", "custom",
]);

export function hasLogo(id: string): boolean {
  return LOGO_IDS.has(id);
}

/* コネクタの公式ロゴ（public/logos/conn-<id>.svg に同梱。出典は DESIGN.md に記録）。
   17種すべて Simple Icons に実在するブランドマークを取得済み。 */
const CONNECTOR_LOGO_IDS = new Set([
  "github", "youtube", "notion", "discord", "slack",
  "gdrive", "gcal", "gmail", "gdocs", "gsheets",
  "onedrive", "outlook", "dropbox", "linear", "trello", "jira",
  "supabase",
]);

export function hasConnectorLogo(id: string): boolean {
  return CONNECTOR_LOGO_IDS.has(id);
}

export function ConnectorTile({ cid, mono, color, lg = false }: { cid?: string; mono: string; color: string; lg?: boolean }) {
  if (cid && CONNECTOR_LOGO_IDS.has(cid)) {
    return (
      <span className={`tile logo${lg ? " lg" : ""}`}>
        <img src={`${import.meta.env.BASE_URL}logos/conn-${cid}.svg`} alt="" loading="lazy" />
      </span>
    );
  }
  return (
    <span className={`tile${lg ? " lg" : ""}`} style={{ color }}>
      {mono}
    </span>
  );
}

export function ProviderTile({ pid, mono, color, lg = false }: { pid?: string; mono: string; color: string; lg?: boolean }) {
  /* カスタムプロバイダー（custom / custom-…）は共通のカスタムロゴを使う */
  const logoId = pid ? (LOGO_IDS.has(pid) ? pid : pid.startsWith("custom") ? "custom" : null) : null;
  if (logoId) {
    return (
      <span className={`tile logo${lg ? " lg" : ""}`}>
        <img src={`${import.meta.env.BASE_URL}logos/${logoId}.svg`} alt="" loading="lazy" />
      </span>
    );
  }
  return (
    <span className={`tile${lg ? " lg" : ""}`} style={{ color }}>
      {mono}
    </span>
  );
}
