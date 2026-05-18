const sources = {
  long: "/logo-long.png",
  square: "/logo-square.png",
};

export function BrandLogo({ variant = "long", alt = "Wanie", className = "" }) {
  const src = sources[variant] || sources.long;
  const fitClassName = variant === "square" ? "object-cover" : "object-contain";

  return (
    <img
      src={src}
      alt={alt}
      className={`${fitClassName} ${className}`.trim()}
    />
  );
}
