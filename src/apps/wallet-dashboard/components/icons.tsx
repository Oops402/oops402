// Simple SVG Icons
export const CopyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="5" y="5" width="9" height="9" rx="1" />
    <path d="M3 2h8v8" />
  </svg>
);

export const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 8l3 3 7-7" />
  </svg>
);

export const SendIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 10h14M10 3l7 7-7 7" />
  </svg>
);

export const ReceiveIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 10h14M10 17L3 10l7-7" />
  </svg>
);

export const RefreshIcon = ({ style }: { style?: React.CSSProperties }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" style={style}>
    <path d="M1 8a7 7 0 0 1 7-7v2M15 8a7 7 0 0 1-7 7v-2M8 1L6 3l2 2M8 15l2-2-2-2" />
  </svg>
);

export const CloseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M5 5l10 10M15 5l-10 10" />
  </svg>
);

