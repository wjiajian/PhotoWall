import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isAuthenticated, verifyToken, removeToken } from '../../utils/auth';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * 路由守卫组件
 * 保护需要登录才能访问的页面
 */
export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const navigate = useNavigate();
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const checkAuth = async () => {
      // 首先检查本地 token 是否存在
      if (!isAuthenticated()) {
        if (isMounted) navigate('/admin/login', { replace: true });
        return;
      }

      try {
        // 然后验证 token 有效性
        const isValid = await verifyToken();
        if (!isMounted) return;

        if (!isValid) {
          // token 无效，清除并跳转登录
          removeToken();
          navigate('/admin/login', { replace: true });
          return;
        }

        setIsChecking(false);
      } catch {
        // 验证失败时也跳转登录
        if (isMounted) {
          removeToken();
          navigate('/admin/login', { replace: true });
        }
      }
    };

    checkAuth();

    return () => {
      isMounted = false;
    };
  }, [navigate]);

  // 检查中或没有 token，不渲染子组件
  if (isChecking || !isAuthenticated()) {
    return null;
  }

  return <>{children}</>;
};
