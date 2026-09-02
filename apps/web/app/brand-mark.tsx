import ribbonHeart from "../../mobile/assets/brand/ribbon-heart-master.png";

type BrandMarkProps = {
  className?: string;
  priority?: boolean;
};

export function BrandMark({ className = "h-12 w-12", priority = false }: BrandMarkProps) {
  return <img
    className={className}
    src={ribbonHeart.src}
    width={ribbonHeart.width}
    height={ribbonHeart.height}
    alt=""
    aria-hidden="true"
    decoding="async"
    fetchPriority={priority ? "high" : "auto"}
  />;
}
