type BrandMarkProps = {
  className?: string;
  priority?: boolean;
};

export function BrandMark({ className = "h-12 w-12", priority = false }: BrandMarkProps) {
  return <img
    className={className}
    src="/fieldops-mark.svg"
    alt=""
    aria-hidden="true"
    decoding="async"
    fetchPriority={priority ? "high" : "auto"}
  />;
}
