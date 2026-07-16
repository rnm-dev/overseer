import { useEffect, useState } from "react";

type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const sizes: Record<AvatarSize, string> = {
  xs: "h-4 w-4 text-[0.48rem]",
  sm: "h-5 w-5 text-[0.55rem]",
  md: "size-7 text-[0.68rem]",
  lg: "size-9 text-sm",
  xl: "size-10 text-sm",
};

export function Avatar({
  src,
  label,
  size = "md",
  className = "",
  decorative = false,
  tooltip,
}: {
  src?: string | null;
  label: string;
  size?: AvatarSize;
  className?: string;
  decorative?: boolean;
  tooltip?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  const shared = `${sizes[size]} shrink-0 rounded-full border bg-iron-800 ${className}`;
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={decorative ? "" : label}
        title={tooltip === null ? undefined : tooltip ?? label}
        className={`${shared} object-cover`}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      className={`${shared} grid place-items-center font-display font-bold text-bone`}
      title={tooltip === null ? undefined : tooltip ?? label}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
    >
      {label.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
