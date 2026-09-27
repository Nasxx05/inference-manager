import Image from "next/image";

export function PromgentLogo({ size = 32, priority = false }: { size?: number; priority?: boolean }) {
  return (
    <Image
      src="/promgent-icon.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      priority={priority}
      className="shrink-0"
    />
  );
}
