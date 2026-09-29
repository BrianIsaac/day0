import type { CSSProperties, ReactNode } from 'react';

const ORBIT_SURFACES = [
  { cx: 300, cy: 110, label: 'docs', anchor: 'middle', labelDx: 0, labelDy: -22 },
  { cx: 465, cy: 190, label: 'spreadsheet', anchor: 'start', labelDx: 20, labelDy: 4 },
  { cx: 500, cy: 380, label: 'slack', anchor: 'start', labelDx: 20, labelDy: 4 },
  { cx: 180, cy: 455, label: 'tickets', anchor: 'end', labelDx: -20, labelDy: 4 },
  { cx: 115, cy: 265, label: 'twitter', anchor: 'end', labelDx: -20, labelDy: 4 },
] as const;

// HTML wrappers let the browser composite motion without relaying out SVG geometry.
function OrbitLayer({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`absolute inset-0 ${className ?? ''}`} style={style}>
      <svg viewBox="0 0 600 600" className="w-full h-full" aria-hidden="true">
        {children}
      </svg>
    </div>
  );
}

/**
 * The hero's orbit: Day0 at the centre of the mock work surfaces. The rings sit in one wrapper
 * that turns with the page's scroll and the whole orbit lags behind it (`data-orbit-rings`,
 * `data-orbit-lag` in the stylesheet); the centre dot is its own layer so it can pulse once.
 */
export function SurfaceOrbit() {
  return (
    <div
      className="relative aspect-square w-full max-w-md mx-auto overflow-hidden pointer-events-none"
      role="img"
      aria-label="Day0 at the centre of mock work surfaces: docs, spreadsheet, slack, tickets, twitter."
    >
      <OrbitLayer className="day0-surface-glow">
        <defs>
          <radialGradient id="agent-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.22" />
            <stop offset="55%" stopColor="#22d3ee" stopOpacity="0.04" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="300" cy="300" r="290" fill="url(#agent-glow)" />
      </OrbitLayer>
      <div data-orbit-rings="" className="absolute inset-0">
        <OrbitLayer className="day0-surface-orbit">
          <circle
            cx="300"
            cy="300"
            r="240"
            fill="none"
            stroke="#22d3ee"
            strokeOpacity="0.18"
            strokeWidth="1"
            strokeDasharray="3 12"
          />
        </OrbitLayer>
        <OrbitLayer className="day0-surface-orbit day0-surface-orbit-inner">
          <circle
            cx="300"
            cy="300"
            r="170"
            fill="none"
            stroke="#22d3ee"
            strokeOpacity="0.1"
            strokeWidth="1"
            strokeDasharray="80 14 2 14"
          />
        </OrbitLayer>
      </div>
      {ORBIT_SURFACES.map(({ cx, cy, ...label }, index) => (
        <div
          key={label.label}
          style={{ '--surface-delay': `${600 + index * 450}ms` } as CSSProperties}
        >
          <OrbitLayer className="day0-surface-link">
            <line
              x1="300"
              y1="300"
              x2={cx}
              y2={cy}
              stroke="#22d3ee"
              strokeOpacity="0.25"
              strokeWidth="0.75"
              strokeDasharray="2 5"
            />
          </OrbitLayer>
          <OrbitLayer className="day0-surface-node">
            <SurfaceNode cx={cx} cy={cy} {...label} />
          </OrbitLayer>
        </div>
      ))}
      <OrbitLayer>
        <circle
          cx="300"
          cy="300"
          r="48"
          fill="#22d3ee"
          fillOpacity="0.06"
          stroke="#22d3ee"
          strokeOpacity="0.3"
          strokeWidth="1"
        />
      </OrbitLayer>
      <OrbitLayer className="day0-orbit-dot">
        <circle cx="300" cy="300" r="6" fill="#22d3ee" />
      </OrbitLayer>
      <OrbitLayer>
        <text
          x="300"
          y="338"
          textAnchor="middle"
          fill="#22d3ee"
          fillOpacity="0.75"
          fontSize="10"
          fontFamily="ui-sans-serif, system-ui"
          letterSpacing="3"
        >
          DAY0
        </text>
      </OrbitLayer>
      <OrbitLayer className="day0-surface-pulse">
        <circle
          cx="300"
          cy="300"
          r="22"
          fill="#22d3ee"
          fillOpacity="0.18"
          stroke="#22d3ee"
          strokeOpacity="0.55"
          strokeWidth="1"
        />
      </OrbitLayer>
      {ORBIT_SURFACES.map(({ cx, cy, label }, index) => (
        <OrbitLayer
          key={label}
          className={`day0-surface-packet${index === 0 ? ' day0-surface-packet-held' : ''}`}
          style={
            {
              '--packet-delay': `${4000 + index * 2400}ms`,
              '--packet-x': `${((cx - 300) / 6).toFixed(3)}%`,
              '--packet-y': `${((cy - 300) / 6).toFixed(3)}%`,
            } as CSSProperties
          }
        >
          <circle cx="300" cy="300" r="3" fill="#a5f3fc" />
        </OrbitLayer>
      ))}
    </div>
  );
}

function SurfaceNode({
  cx,
  cy,
  label,
  anchor,
  labelDx,
  labelDy,
}: {
  cx: number;
  cy: number;
  label: string;
  anchor: 'start' | 'middle' | 'end';
  labelDx: number;
  labelDy: number;
}) {
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r="16"
        fill="#0a0a0b"
        stroke="#22d3ee"
        strokeOpacity="0.4"
        strokeWidth="1"
      />
      <circle cx={cx} cy={cy} r="5" fill="#22d3ee" fillOpacity="0.7" />
      <text
        x={cx + labelDx}
        y={cy + labelDy}
        textAnchor={anchor}
        fill="#a1a1aa"
        fontSize="11"
        fontFamily="ui-sans-serif, system-ui"
        letterSpacing="0.5"
      >
        {label}
      </text>
    </g>
  );
}
