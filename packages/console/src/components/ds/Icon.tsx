import * as React from 'react';

/**
 * Vendored Lucide glyphs (https://lucide.dev), MIT.
 * Curated subset for the Memex console — inline SVG, no CDN dependency.
 */

export type IconName =
  | 'activity' | 'git-branch' | 'database' | 'layers' | 'hexagon'
  | 'circle' | 'dot' | 'zap' | 'triangle-alert' | 'check' | 'x'
  | 'chevron-right' | 'chevron-left' | 'chevron-down' | 'search'
  | 'clock' | 'gauge' | 'terminal' | 'share' | 'plus' | 'minus'
  | 'cpu' | 'radio' | 'box' | 'eye' | 'waypoints' | 'settings'
  | 'arrow-right' | 'menu';

export interface IconProps extends React.SVGAttributes<SVGSVGElement> {
  /** Glyph name from the vendored Lucide subset. */
  name: IconName;
  /** Pixel size (square). @default 18 */
  size?: number;
  /** Stroke width. @default 1.6 */
  strokeWidth?: number;
}

// 24x24 viewBox, stroke paths. Each value is an array of <path d>/element specs.
const PATHS: Record<IconName, string[]> = {
  activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  'git-branch': ['M6 3v12', 'c:18,6,3', 'c:6,18,3', 'M18 9a9 9 0 0 1-9 9'],
  database: ['e:12,5,9,3', 'M3 5v14a9 3 0 0 0 18 0V5', 'M3 12a9 3 0 0 0 18 0'],
  layers: [
    'M12.8 2.2a2 2 0 0 0-1.6 0l-8.6 3.9a1 1 0 0 0 0 1.8l8.6 3.9a2 2 0 0 0 1.6 0l8.6-3.9a1 1 0 0 0 0-1.8Z',
    'm22 12.5-9.2 4.2a2 2 0 0 1-1.6 0L2 12.5',
    'm22 17.5-9.2 4.2a2 2 0 0 1-1.6 0L2 17.5',
  ],
  hexagon: ['M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z'],
  circle: ['c:12,12,10'],
  dot: ['c:12,12,3'],
  zap: ['M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'],
  'triangle-alert': ['m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z', 'M12 9v4', 'M12 17h.01'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  'chevron-right': ['m9 18 6-6-6-6'],
  'chevron-left': ['m15 18-6-6 6-6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  search: ['c:11,11,8', 'm21 21-4.3-4.3'],
  clock: ['c:12,12,10', 'M12 6v6l4 2'],
  gauge: ['m12 14 4-4', 'M3.34 19a10 10 0 1 1 17.32 0'],
  terminal: ['m4 17 6-6-6-6', 'M12 19h8'],
  share: ['c:18,5,3', 'c:6,12,3', 'c:18,19,3', 'M8.6 13.5l6.8 4', 'M15.4 6.5l-6.8 4'],
  plus: ['M5 12h14', 'M12 5v14'],
  minus: ['M5 12h14'],
  cpu: ['r:4,4,16,16,2', 'r:9,9,6,6,1', 'M15 2v2', 'M15 20v2', 'M2 15h2', 'M20 15h2', 'M2 9h2', 'M20 9h2', 'M9 2v2', 'M9 20v2'],
  radio: ['c:12,12,2', 'M4.9 19.1a10 10 0 0 1 0-14.2', 'M7.8 16.2a6 6 0 0 1 0-8.4', 'M16.2 7.8a6 6 0 0 1 0 8.4', 'M19.1 4.9a10 10 0 0 1 0 14.2'],
  box: ['M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z', 'm3.3 7 8.7 5 8.7-5', 'M12 22V12'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z', 'c:12,12,3'],
  waypoints: ['c:12,4.5,2.5', 'c:4.5,19.5,2.5', 'c:19.5,19.5,2.5', 'M9.7 17.7l4.6 0', 'M6.5 9.8l3.5 5.2', 'M17.5 9.8l-3.5 5.2'],
  settings: [
    'M12.2 2h-.4a2 2 0 0 0-2 2 1.7 1.7 0 0 1-2.6 1.1 2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7 1.7 1.7 0 0 1 0 3 2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7 1.7 1.7 0 0 1 2.6 1.1 2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2 1.7 1.7 0 0 1 2.6-1.1 2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7 1.7 1.7 0 0 1 0-3 2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7 1.7 1.7 0 0 1-2.6-1.1 2 2 0 0 0-2-2Z',
    'c:12,12,3',
  ],
  'arrow-right': ['M5 12h14', 'm12 5 7 7-7 7'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
};

function render(spec: string, i: number): React.ReactElement {
  if (spec.startsWith('c:')) {
    const [cx, cy, r] = spec.slice(2).split(',');
    return <circle key={i} cx={cx} cy={cy} r={r} />;
  }
  if (spec.startsWith('e:')) {
    const [cx, cy, rx, ry] = spec.slice(2).split(',');
    return <ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} />;
  }
  if (spec.startsWith('r:')) {
    const [x, y, w, h, rd] = spec.slice(2).split(',');
    return <rect key={i} x={x} y={y} width={w} height={h} rx={rd} />;
  }
  return <path key={i} d={spec} />;
}

/** Vendored Lucide glyph. Inherits color via currentColor. */
export function Icon({ name, size = 18, strokeWidth = 1.6, className = '', style, ...rest }: IconProps) {
  const specs = PATHS[name] || PATHS.circle;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`mx-icon ${className}`}
      style={{ display: 'block', flexShrink: 0, ...style }}
      aria-hidden="true"
      {...rest}
    >
      {specs.map(render)}
    </svg>
  );
}
