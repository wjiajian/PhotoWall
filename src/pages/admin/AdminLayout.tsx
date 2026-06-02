import React, { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  Image, 
  Menu, 
} from 'lucide-react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { logout, getUsername } from '../../utils/auth';
import { AdminSidebarPanel, type AdminNavItem } from '../../components/admin/AdminSidebarPanel';

const navItems: AdminNavItem[] = [
  { icon: <Image size={20} />, label: '照片管理', path: '/admin/photos' },
];

interface AdminMobileSidebarProps {
  isActivePath: (path: string) => boolean;
  navItems: AdminNavItem[];
  onLogout: () => void;
  username: string | null;
}

const AdminMobileSidebar: React.FC<AdminMobileSidebarProps> = ({
  isActivePath,
  navItems,
  onLogout,
  username,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const closeSidebar = () => setIsOpen(false);

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="fixed top-4 left-4 z-50 p-2.5 rounded-xl bg-white border border-gray-200 shadow-sm text-gray-700 md:hidden"
        aria-label="打开侧边栏"
      >
        <Menu size={20} />
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            className="absolute inset-0 bg-black/35 backdrop-blur-[1px]"
            onClick={closeSidebar}
            aria-label="关闭侧边栏遮罩"
          />

          <motion.aside
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            transition={{ duration: 0.25 }}
            className="absolute left-0 top-0 h-full w-72 shadow-xl"
          >
            <AdminSidebarPanel
              mode="mobile"
              navItems={navItems}
              isActivePath={isActivePath}
              username={username}
              onLogout={onLogout}
              onNavigate={closeSidebar}
              onMobileClose={closeSidebar}
            />
          </motion.aside>
        </div>
      )}
    </>
  );
};

/**
 * 管理后台布局组件
 * 统一使用网站亮色主题风格
 */
export const AdminLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobileView = useIsMobile();
  const [isDesktopSidebarOpen, setIsDesktopSidebarOpen] = useState(true);
  const username = getUsername();

  const handleLogout = () => {
    logout();
    navigate('/admin/login');
  };

  const isActivePath = (path: string) => location.pathname.startsWith(path);
  const desktopSidebarWidth = isDesktopSidebarOpen ? 256 : 80;
  const contentClassName = isMobileView
    ? 'min-h-screen px-4 pb-6 pt-20'
    : 'min-h-screen p-6';

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* 桌面端侧边栏 */}
      {!isMobileView && (
        <motion.aside
          initial={false}
          animate={{ width: desktopSidebarWidth }}
          transition={{ duration: 0.3 }}
          className="fixed h-full z-40 shadow-sm"
        >
          <AdminSidebarPanel
            mode="desktop"
            collapsed={!isDesktopSidebarOpen}
            navItems={navItems}
            isActivePath={isActivePath}
            username={username}
            onLogout={handleLogout}
            onDesktopToggle={() => setIsDesktopSidebarOpen(!isDesktopSidebarOpen)}
          />
        </motion.aside>
      )}

      {/* 移动端菜单按钮与抽屉 */}
      {isMobileView && (
        <AdminMobileSidebar
          isActivePath={isActivePath}
          navItems={navItems}
          username={username}
          onLogout={handleLogout}
        />
      )}

      <main
        className="flex-1 transition-all duration-300"
        style={{ marginLeft: isMobileView ? 0 : desktopSidebarWidth }}
      >
        <div className={contentClassName}>
          <Outlet />
        </div>
      </main>
    </div>
  );
};
