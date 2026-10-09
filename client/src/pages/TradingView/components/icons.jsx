// Iconos de trazo para la UI del gráfico. Sustituyen a los emojis, que se
// ven distinto en cada sistema y no admiten color ni tamaño consistentes.
function Svg({ size = 20, children, fill = 'none', strokeWidth = 1.8 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={fill === 'none' ? 'currentColor' : 'none'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IndicatorsIcon = (p) => <Svg {...p}><path d="M3 17l5-6 4 4 8-9" /><path d="M15 6h5v5" /></Svg>;
export const PencilIcon = (p) => <Svg {...p}><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" /><path d="M14 7l3 3" /></Svg>;
export const ReplayIcon = (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M10 8.5v7l6-3.5z" /></Svg>;
export const SlidersIcon = (p) => <Svg {...p}><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></Svg>;
export const ExpandIcon = (p) => <Svg {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Svg>;
export const CollapseIcon = (p) => <Svg {...p}><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></Svg>;
export const ChevronDownIcon = (p) => <Svg {...p}><path d="M6 9l6 6 6-6" /></Svg>;
export const ChevronRightIcon = (p) => <Svg {...p}><path d="M9 6l6 6-6 6" /></Svg>;
export const ChevronLeftIcon = (p) => <Svg {...p}><path d="M15 6l-6 6 6 6" /></Svg>;
export const CloseIcon = (p) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const EyeIcon = (p) => <Svg {...p}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Svg>;
export const EyeOffIcon = (p) => <Svg {...p}><path d="M17.9 17.9A10.9 10.9 0 0 1 12 19c-6.4 0-10-7-10-7a18.5 18.5 0 0 1 5.1-5.9" /><path d="M9.9 5.2A10 10 0 0 1 12 5c6.4 0 10 7 10 7a18.6 18.6 0 0 1-2.2 3.2" /><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2" /><path d="M2 2l20 20" /></Svg>;
export const PlusIcon = (p) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const TrashIcon = (p) => <Svg {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Svg>;
export const UndoIcon = (p) => <Svg {...p}><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></Svg>;
export const RefreshIcon = (p) => <Svg {...p}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></Svg>;
export const MoreIcon = (p) => <Svg fill="currentColor" {...p}><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></Svg>;
// Estrella de favorito: contorno por defecto, `filled` la rellena.
export const StarIcon = ({ filled = false, ...p }) => (
  <Svg fill={filled ? 'currentColor' : 'none'} {...p}>
    <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
  </Svg>
);
export const DiceIcon =(p) => <Svg {...p}><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1" fill="currentColor" /><circle cx="15" cy="15" r="1" fill="currentColor" /><circle cx="15" cy="9" r="1" fill="currentColor" /><circle cx="9" cy="15" r="1" fill="currentColor" /></Svg>;

// Herramientas de dibujo
export const CursorIcon = (p) => <Svg {...p}><path d="M5 3l14 8-6 2-2 6z" /></Svg>;
export const TrendlineIcon = (p) => <Svg {...p}><path d="M5 19L19 5" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="5" r="2" /></Svg>;
export const HorizontalLineIcon = (p) => <Svg {...p}><path d="M3 12h18" /></Svg>;
export const RectangleIcon = (p) => <Svg {...p}><rect x="4" y="6" width="16" height="12" rx="1" /></Svg>;
export const FibIcon = (p) => <Svg {...p}><path d="M3 5h18M3 10h18M3 14h18M3 19h18" /></Svg>;
export const RulerIcon = (p) => <Svg {...p}><path d="M3 16L16 3l5 5L8 21z" /><path d="M7 12l2 2M10 9l2 2M13 6l2 2" /></Svg>;

// Transporte de replay (rellenos)
export const PlayIcon = (p) => <Svg fill="currentColor" {...p}><path d="M7 5l12 7-12 7z" /></Svg>;
export const PauseIcon = (p) => <Svg fill="currentColor" {...p}><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></Svg>;
export const StepIcon = (p) => <Svg fill="currentColor" {...p}><path d="M5 5l10 7-10 7z" /><rect x="16" y="5" width="3" height="14" rx="1" /></Svg>;
export const StopIcon = (p) => <Svg fill="currentColor" {...p}><rect x="6" y="6" width="12" height="12" rx="2" /></Svg>;
export const ResetIcon = (p) => <Svg {...p}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v5h5" /></Svg>;

export const DRAWING_TOOL_ICONS = {
  select: CursorIcon,
  ruler: RulerIcon,
  trendline: TrendlineIcon,
  horizontal: HorizontalLineIcon,
  rectangle: RectangleIcon,
  fib: FibIcon,
};
