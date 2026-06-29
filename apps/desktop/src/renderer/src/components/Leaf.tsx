/** Healix mark — a green leaf. Inline SVG so it inherits sizing via className. */
export function Leaf({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} role="img" aria-label="Healix">
      <defs>
        <linearGradient id="healix-leaf" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#46c878" />
          <stop offset="1" stopColor="#1f8f44" />
        </linearGradient>
      </defs>
      <g transform="rotate(-32 512 512)">
        <path
          d="M512 168 C 712 320, 752 560, 512 856 C 272 560, 312 320, 512 168 Z"
          fill="url(#healix-leaf)"
        />
        <path
          d="M512 200 L 512 824"
          fill="none"
          stroke="#0d3a22"
          strokeOpacity="0.7"
          strokeWidth="22"
          strokeLinecap="round"
        />
        <g
          fill="none"
          stroke="#0d3a22"
          strokeOpacity="0.55"
          strokeWidth="15"
          strokeLinecap="round"
        >
          <path d="M512 340 C 560 360, 600 392, 624 440" />
          <path d="M512 340 C 464 360, 424 392, 400 440" />
          <path d="M512 470 C 568 494, 612 532, 636 584" />
          <path d="M512 470 C 456 494, 412 532, 388 584" />
          <path d="M512 600 C 558 622, 596 656, 616 700" />
          <path d="M512 600 C 466 622, 428 656, 408 700" />
        </g>
      </g>
    </svg>
  );
}
