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
  download: <><path d="M12 4v11m0 0 4-4m-4 4-4-4M4 19h16" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <><path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5Z" /></>,
  alert: <><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></>,
  ext: <><path d="M14 4h6v6m0-6L10.5 13.5M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" /></>,
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
  "hyperbolic", "siliconflow", "ollama", "lmstudio",
]);

export function hasLogo(id: string): boolean {
  return LOGO_IDS.has(id);
}

export function ProviderTile({ pid, mono, color, lg = false }: { pid?: string; mono: string; color: string; lg?: boolean }) {
  if (pid && LOGO_IDS.has(pid)) {
    return (
      <span className={`tile logo${lg ? " lg" : ""}`}>
        <img src={`${import.meta.env.BASE_URL}logos/${pid}.svg`} alt="" loading="lazy" />
      </span>
    );
  }
  return (
    <span className={`tile${lg ? " lg" : ""}`} style={{ color }}>
      {mono}
    </span>
  );
}
