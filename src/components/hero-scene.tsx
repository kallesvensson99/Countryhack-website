/** Night field with a barn that carries a wifi antenna. Decorative only. */
const STARS: [number, number][] = [[120, 40], [260, 110], [420, 60], [560, 150], [700, 50], [760, 130], [940, 30], [1180, 150], [1230, 60], [60, 170]];

export function HeroScene() {
  return (
    <svg viewBox="0 0 1280 460" preserveAspectRatio="xMidYMax slice" aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[300px] w-full sm:h-[460px]">
      <g fill="#f2ead6">
        {STARS.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="3" height="3" />
        ))}
      </g>
      <circle cx="1090" cy="100" r="46" fill="#f2ead6" />
      <circle cx="1074" cy="88" r="9" fill="#e0d6b8" />
      <circle cx="1104" cy="116" r="6" fill="#e0d6b8" />
      <circle cx="1110" cy="84" r="4" fill="#e0d6b8" />
      <path d="M0 330C200 280 400 304 600 322S1000 292 1280 312V460H0Z" fill="#1c3f2f" />
      <g>
        <path d="M800 360V300L832 270H888L920 300V360Z" fill="#b83a24" />
        <path d="M800 300L832 270H888L920 300" fill="none" stroke="#f2ead6" strokeWidth="4" />
        <rect x="845" y="316" width="30" height="44" fill="#7d2415" />
        <path d="M845 316L875 360M875 316L845 360" stroke="#f2ead6" strokeWidth="3" />
        <rect x="852" y="282" width="16" height="12" fill="#e9b73a" />
        <path d="M860 270V222" stroke="#f2ead6" strokeWidth="4" />
        <path d="M846 212a20 20 0 0 1 28 0" fill="none" stroke="#e9b73a" strokeWidth="4" />
        <path d="M838 202a32 32 0 0 1 44 0" fill="none" stroke="#e9b73a" strokeWidth="4" />
        <circle cx="860" cy="222" r="5" fill="#e9b73a" />
      </g>
      <path d="M0 372C240 332 520 362 760 350S1100 334 1280 354V460H0Z" fill="#25503b" />
      <path d="M0 420C300 388 600 428 900 408S1200 396 1280 412V460H0Z" fill="#2f6247" />
    </svg>
  );
}
