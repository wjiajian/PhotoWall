import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Lock, User, AlertCircle, Loader2 } from 'lucide-react';
import { login } from '../../utils/auth';
import { usePageTitle } from '../../hooks/usePageTitle';

/**
 * 管理员登录页面
 * 统一使用网站亮色主题风格
 */
export const LoginPage: React.FC = () => {
  usePageTitle('管理后台登录');
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    const result = await login(username, password);

    if (result.success) {
      navigate('/admin');
    } else {
      setError(result.error || '登录失败');
    }

    setIsLoading(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-white to-gray-100 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md"
      >
        {/* Logo / 标题 */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-500/25">
            <Lock size={28} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-800">照片墙管理后台</h1>
          <p className="text-gray-500 mt-2">请登录以继续</p>
        </div>

        {/* 登录表单 */}
        <form onSubmit={handleSubmit} className="bg-white/80 backdrop-blur-xl rounded-2xl p-8 border border-gray-200 shadow-xl">
          {/* 错误提示 */}
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl flex items-center gap-3"
            >
              <AlertCircle size={20} className="text-red-500 flex-shrink-0" />
              <span className="text-red-600 text-sm">{error}</span>
            </motion.div>
          )}

          {/* 用户名 */}
          <div className="mb-5">
            <label className="block text-gray-600 text-sm mb-2">用户名</label>
            <div className="relative">
              <User size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl py-3 pl-12 pr-4 text-gray-800 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all"
                placeholder="请输入用户名"
                required
                autoComplete="username"
              />
            </div>
          </div>

          {/* 密码 */}
          <div className="mb-6">
            <label className="block text-gray-600 text-sm mb-2">密码</label>
            <div className="relative">
              <Lock size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl py-3 pl-12 pr-4 text-gray-800 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all"
                placeholder="请输入密码"
                required
                autoComplete="current-password"
              />
            </div>
          </div>

          {/* 登录按钮 */}
          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-medium py-3 rounded-xl hover:from-blue-600 hover:to-indigo-700 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-blue-500/25"
          >
            {isLoading ? (
              <>
                <Loader2 size={20} className="animate-spin" />
                登录中...
              </>
            ) : (
              '登录'
            )}
          </button>

          {/* 返回前台 */}
          <div className="mt-6 text-center">
            <a
              href="/"
              className="text-gray-400 hover:text-gray-600 text-sm transition-colors"
            >
              ← 返回照片墙
            </a>
          </div>
        </form>
      </motion.div>
    </div>
  );
};
