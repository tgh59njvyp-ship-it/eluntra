import { loginWith, type OAuthProvider } from "../lib/auth";
import { PROVIDERS } from "../lib/providers/registry";
import { ProviderTile } from "./icons";

const BRAND: Record<OAuthProvider, { label: string; path: string }> = {
  github: {
    label: "GitHubでログイン",
    path: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  },
  google: {
    label: "Googleでログイン",
    path: "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z",
  },
  apple: {
    label: "Appleでログイン",
    path: "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
  },
};

export function Welcome({ onGuest }: { onGuest: () => void }) {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <span className="logo" style={{ fontSize: 26 }}>Eluntra</span>
        <h1>30社のAIを、<br />自分のキーで。</h1>
        <p className="lead">
          OpenAI・Gemini・Claudeなど30社のAIを、自分のAPIキー（BYOK）で使うチャットです。
          自分専用のカスタム接続も作れます。
          キーは端末の中にだけ保存され、選んだ会社のAPIへ直接つながります。
        </p>
        <div className="login-col">
          {(Object.keys(BRAND) as OAuthProvider[]).map((pr) => (
            <button key={pr} type="button" className="loginbtn" onClick={() => void loginWith(pr)}>
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d={BRAND[pr].path} />
              </svg>
              {BRAND[pr].label}
            </button>
          ))}
        </div>
        <button type="button" className="btn ghost" onClick={onGuest} style={{ paddingLeft: 4 }}>
          ログインせずに使う →
        </button>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "22px 0 8px" }}>
          {PROVIDERS.slice(0, 12).map((p) => (
            <span key={p.id} className="attach-chip" style={{ margin: 0 }}>
              <ProviderTile pid={p.id} mono={p.mono} color={p.color} />
              {p.name}
            </span>
          ))}
          <span className="attach-chip" style={{ margin: 0 }}>ほか18社</span>
        </div>
        <div className="feat">
          <h3>キーは端末の中だけ</h3>
          <p>APIキーはこの端末のブラウザ内にのみ保存され、クラウド同期の対象にもなりません。</p>
        </div>
        <div className="feat">
          <h3>モデルは実物だけ</h3>
          <p>モデル一覧はあなたのキーで各社から取得します。一覧APIがない会社は、その旨を表示します。</p>
        </div>
        <div className="feat">
          <h3>ログインで同期</h3>
          <p>会話と設定は、ログインすると端末間で同期されます。</p>
        </div>
        <p style={{ color: "var(--text-3)", fontSize: 12.5, marginTop: 24 }}>
          Googleログインはテスト中のため、当面は許可されたアカウントのみ使えます。Appleログインは未有効化の場合があります。
        </p>
      </div>
    </div>
  );
}
