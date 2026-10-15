// Iconos de trazo del módulo de Opciones (sin emoji).
function Svg({ size = 16, strokeWidth = 2, children }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
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

export const ManualIcon = (p) => <Svg {...p}><path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 5-6" /></Svg>;
export const StrategiesIcon = (p) => <Svg {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 9h6v6H9z" /></Svg>;
export const BacktestIcon = (p) => <Svg {...p}><path d="M12 8v4l3 2" /><path d="M3.05 11a9 9 0 1 1 .5 4" /><path d="M3 4v5h5" /></Svg>;
export const ChevronDownIcon = (p) => <Svg {...p}><path d="M6 9l6 6 6-6" /></Svg>;
export const LinkIcon = (p) => <Svg {...p}><path d="M9 6h9v9" /><path d="M18 6L6 18" /></Svg>;
export const AlertIcon = (p) => <Svg {...p}><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4" /><path d="M12 17.5v.01" /></Svg>;
export const LayersIcon = (p) => <Svg {...p}><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></Svg>;
