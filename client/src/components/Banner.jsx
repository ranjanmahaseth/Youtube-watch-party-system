const VARIANTS = {
  error: 'border-red-900 bg-red-950/70 text-red-200',
  warning: 'border-amber-800 bg-amber-950/60 text-amber-200',
  info: 'border-sky-800 bg-sky-950/60 text-sky-200',
};

/**
 * Small reusable notice strip, shared by the Home and Room screens.
 *
 * variant: 'error' | 'warning' | 'info'
 */
export default function Banner({ variant = 'info', children }) {
  if (!children) return null;

  return (
    <p
      role={variant === 'error' ? 'alert' : 'status'}
      className={`rounded-lg border px-4 py-3 text-sm ${VARIANTS[variant] ?? VARIANTS.info}`}
    >
      {children}
    </p>
  );
}

