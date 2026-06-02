import { useState, useEffect } from "react";

/**
 * 移动端检测 Hook
 * 使用 matchMedia API 检测屏幕宽度，实时响应窗口大小变化
 * 断点：768px（对应 Tailwind 的 md 断点）
 *
 * @returns {boolean} 是否为移动端设备（屏幕宽度 < 768px）
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    // 服务端渲染时默认返回 false
    if (typeof window === "undefined") return false;
    return window.innerWidth < 768;
  });

  useEffect(() => {
    // 创建媒体查询
    const mediaQuery = window.matchMedia("(max-width: 767px)");

    // 更新状态
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsMobile(e.matches);
    };

    // 初始化
    handleChange(mediaQuery);

    // 监听变化
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => {
        mediaQuery.removeEventListener("change", handleChange);
      };
    }

    if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(handleChange);
    }

    return () => {
      if (typeof mediaQuery.removeListener === "function") {
        mediaQuery.removeListener(handleChange);
      }
    };
  }, []);

  return isMobile;
}
