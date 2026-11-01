import type { ReactNode } from 'react';
import type { ToolId } from './store';

const P = (d: ReactNode) => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;

export const ToolIcons: Record<ToolId, ReactNode> = {
  gradient: P(<><rect x="4" y="5" width="16" height="14" rx="1.5" /><path d="M8 5v14M12 5v14M16 5v14" strokeOpacity=".45" /></>),
  move: P(<><path d="M12 3v18M3 12h18" /><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" /></>),
  marquee: P(<rect x="4" y="5" width="16" height="14" rx="1" strokeDasharray="3 2.5" />),
  brush: P(<><path d="M4 20c3 0 5-1 5-3.5C9 15 8 14 6.5 14S4 15.5 4 17.5V20z" /><path d="M9.5 14.5L19 5a1.8 1.8 0 012.5 2.5L12 17" transform="translate(-1 0)" /></>),
  eraser: P(<><path d="M7 20h11" /><path d="M5.5 14.5l8-8a2 2 0 012.8 0l2.2 2.2a2 2 0 010 2.8L11.5 18.5H8L5.5 16z" /></>),
  text: P(<><path d="M5 6V4.5h14V6M12 4.5V20M9 20h6" /></>),
  eyedropper: P(<><path d="M14 6l4 4M16 4a2.1 2.1 0 013 3l-2 2-3-3z" /><path d="M13 7l-8 8-1 5 5-1 8-8" /></>),
  hand: P(<path d="M8 12V6.5a1.5 1.5 0 013 0V11m0-4.5a1.5 1.5 0 013 0V11m0-3a1.5 1.5 0 013 0v6.5A6 6 0 0113 20h-1.5a5 5 0 01-4-2L4 13.5a1.5 1.5 0 012.3-1.8L8 13" />),
  zoom: P(<><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5M8 10.5h5M10.5 8v5" /></>),
};

export const Eye = ({ on }: { on: boolean }) => P(on ? <><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="2.6" /></> : <><path d="M3 3l18 18" /><path d="M10 6a9 9 0 012-.5C18.4 5.5 22 12 22 12a17 17 0 01-3 3.7M6.5 7.3A17 17 0 002 12s3.6 6.5 10 6.5a9 9 0 004-1" /></>);
export const Lock = () => P(<><rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 118 0v3" /></>);
export const Plus = () => P(<path d="M12 5v14M5 12h14" />);
export const Trash = () => P(<><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13" /></>);
export const Copy = () => P(<><rect x="8" y="8" width="12" height="12" rx="1.5" /><path d="M16 8V5.5A1.5 1.5 0 0014.5 4h-9A1.5 1.5 0 004 5.5v9A1.5 1.5 0 005.5 16H8" /></>);
export const Folder = () => P(<path d="M3 7a1.5 1.5 0 011.5-1.5H9l2 2.5h8.5A1.5 1.5 0 0121 9.5v8A1.5 1.5 0 0119.5 19h-15A1.5 1.5 0 013 17.5z" />);
export const MaskIcon = () => P(<><rect x="4" y="4" width="16" height="16" rx="2" /><circle cx="12" cy="12" r="4.5" /></>);
export const TextIcon = () => P(<path d="M6 7V5h12v2M12 5v14M9.5 19h5" />);
export const Close = () => <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
export const Swap = () => P(<path d="M7 7h11l-3-3M17 17H6l3 3" />);

export const Logo = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-label="Pixel Studio logo" role="img">
    <rect x="2" y="2" width="9" height="9" rx="1.5" fill="#3ddcc8" /><rect x="13" y="2" width="9" height="9" rx="1.5" fill="#8b7cff" />
    <rect x="2" y="13" width="9" height="9" rx="1.5" fill="#8b7cff" opacity=".55" /><rect x="13" y="13" width="9" height="9" rx="1.5" fill="#3ddcc8" opacity=".55" />
  </svg>
);
