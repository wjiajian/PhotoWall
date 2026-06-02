import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Home, LogOut, Menu, X } from 'lucide-react';

export interface AdminNavItem {
  icon: React.ReactNode;
  label: string;
  path: string;
}

interface AdminSidebarPanelProps {
  mode: 'desktop' | 'mobile';
  collapsed?: boolean;
  navItems: AdminNavItem[];
  isActivePath: (path: string) => boolean;
  username: string | null;
  onLogout: () => void;
  onNavigate?: () => void;
  onDesktopToggle?: () => void;
  onMobileClose?: () => void;
}

export const AdminSidebarPanel: React.FC<AdminSidebarPanelProps> = ({
  mode,
  collapsed = false,
  navItems,
  isActivePath,
  username,
  onLogout,
  onNavigate,
  onDesktopToggle,
  onMobileClose,
}) => {
  const isDesktop = mode === 'desktop';
  const showLabel = !isDesktop || !collapsed;

  return (
    <div className="h-full bg-white border-r border-gray-200 flex flex-col">
      <div className="h-16 flex items-center justify-between px-4 border-b border-gray-100">
        {showLabel && <span className="text-lg font-bold text-gray-800">照片墙后台</span>}
        {isDesktop ? (
          <button
            onClick={onDesktopToggle}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          >
            {collapsed ? <Menu size={20} /> : <X size={20} />}
          </button>
        ) : (
          <button
            onClick={onMobileClose}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
            aria-label="关闭侧边栏"
          >
            <X size={20} />
          </button>
        )}
      </div>

      <nav className="flex-1 py-4 px-3">
        {navItems.map((item) => (
          <Link
            key={item.path}
            to={item.path}
            onClick={onNavigate}
            className={`flex items-center gap-3 px-3 py-3 rounded-xl mb-1 transition-all ${
              isActivePath(item.path)
                ? 'bg-blue-50 text-blue-600'
                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-800'
            }`}
          >
            {item.icon}
            {showLabel && <span className="font-medium">{item.label}</span>}
            {showLabel && isActivePath(item.path) && (
              <ChevronRight size={16} className="ml-auto" />
            )}
          </Link>
        ))}
      </nav>

      <div className="p-3 border-t border-gray-100">
        <Link
          to="/"
          onClick={onNavigate}
          className="flex items-center gap-3 px-3 py-3 rounded-xl text-gray-600 hover:bg-gray-100 hover:text-gray-800 transition-all mb-1"
        >
          <Home size={20} />
          {showLabel && <span className="font-medium">返回前台</span>}
        </Link>

        <button
          onClick={onLogout}
          className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-gray-600 hover:bg-red-50 hover:text-red-600 transition-all"
        >
          <LogOut size={20} />
          {showLabel && <span className="font-medium">退出登录</span>}
        </button>

        {showLabel && username && (
          <div className="mt-3 px-3 py-2 text-xs text-gray-400">
            当前用户: {username}
          </div>
        )}
      </div>
    </div>
  );
};
