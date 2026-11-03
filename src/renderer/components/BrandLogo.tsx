import brandIconUrl from "../../../build/icon.png";

/** 品牌图标（透明背景 PNG），统一用于各界面入口 */
export default function BrandLogo({ className }: { className?: string }) {
  return (
    <img
      className={className}
      src={brandIconUrl}
      alt=""
      draggable={false}
    />
  );
}
