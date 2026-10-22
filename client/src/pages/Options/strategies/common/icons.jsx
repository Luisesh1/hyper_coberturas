// Iconos SVG de trazo de las pestañas de automatización. Se reutilizan los
// del gráfico (TradingView) y se añaden los que faltan con la misma rejilla.
export {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  SlidersIcon,
  TrashIcon,
} from '../../../TradingView/components/icons';

function Svg({ size = 18, children, fill = 'none', strokeWidth = 2 }) {
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

export const WarningIcon = (p) => (
  <Svg {...p}><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></Svg>
);
export const InfoIcon = (p) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Svg>
);
export const CopyIcon = (p) => <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></Svg>;
export const RunIcon = (p) => <Svg fill="currentColor" {...p}><path d="M7 4v16l13-8z" /></Svg>;
export const DownloadIcon = (p) => (
  <Svg {...p}><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 20h14" /></Svg>
);
export const HistoryIcon = (p) => (
  <Svg {...p}><path d="M12 8v4l3 2" /><path d="M3.05 11a9 9 0 1 1 .5 4" /><path d="M3 4v5h5" /></Svg>
);
export const StrategyIcon = (p) => (
  <Svg {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 9h6v6H9z" /></Svg>
);
