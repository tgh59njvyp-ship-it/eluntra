/* Eluntra ロゴマーク（v7.0）
   参考デザインの再現：青→紫グラデーションの四芒星＋小さな星＋細い軌道リング。
   ヘッダー（小）・ヒーロー（大）・ログイン画面で共用する。 */
export function Logo({ size = 40, className }: { size?: number; className?: string }) {
  const h = Math.round((size * 170) / 260);
  return (
    <svg
      className={className}
      width={size}
      height={h}
      viewBox="0 0 260 170"
      role="img"
      aria-label="Eluntra"
      style={{ display: "block", flex: "none" }}
    >
      <defs>
        <linearGradient id="eluntra-star" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#38BDF8" />
          <stop offset="0.38" stopColor="#2E7CF6" />
          <stop offset="0.72" stopColor="#6366F1" />
          <stop offset="1" stopColor="#A855F7" />
        </linearGradient>
        <linearGradient id="eluntra-ring" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#BDE3FF" stopOpacity="0.5" />
          <stop offset="0.45" stopColor="#7CC4FA" stopOpacity="0.8" />
          <stop offset="1" stopColor="#B7A6F9" stopOpacity="0.95" />
        </linearGradient>
      </defs>
      {/* 軌道リング（星の後ろ） */}
      <ellipse
        cx="128"
        cy="97"
        rx="118"
        ry="35"
        fill="none"
        stroke="url(#eluntra-ring)"
        strokeWidth="5.5"
        strokeLinecap="round"
        transform="rotate(-11 128 97)"
      />
      {/* メインの星 */}
      <g transform="translate(118 85) scale(1.07) translate(-118 -85)">
        <path
          fill="url(#eluntra-star)"
          d="M118 4 C124 44 128 58 198 80 C128 90 124 118 118 166 C112 118 108 90 38 80 C108 58 112 44 118 4 Z"
        />
      </g>
      {/* 右上の小さな星 */}
      <g transform="translate(198 23) scale(1.5) translate(-198 -23)">
        <path
          fill="url(#eluntra-star)"
          d="M198 6 C200 17 202 19 214 23 C202 26 200 29 198 40 C196 29 194 26 182 23 C194 19 196 17 198 6 Z"
        />
      </g>
    </svg>
  );
}
