/**
 * 应用程序的统一主题配置。
 */

export const FRONTEND_DARK_BG_CLASS = 'bg-[#0a0a0a]';
export const FRONTEND_LIGHT_BG_CLASS = 'bg-[#fefefb]';

export const getFrontendPageClass = (darkMode: boolean, includeText = true) => {
  if (darkMode) {
    return includeText ? `${FRONTEND_DARK_BG_CLASS} text-white` : FRONTEND_DARK_BG_CLASS;
  }
  return includeText ? `${FRONTEND_LIGHT_BG_CLASS} text-gray-900` : FRONTEND_LIGHT_BG_CLASS;
};

export const getFrontendHeaderGradientToClass = (darkMode: boolean) => (
  darkMode ? 'to-[#0a0a0a]' : 'to-[#fefefb]'
);

/**
 * 获取主应用程序布局的主题配置。
 * @param darkMode 是否启用暗黑模式
 */
export const getAppTheme = (darkMode: boolean) => ({
  page: getFrontendPageClass(darkMode),
  yearTitle: darkMode ? 'text-white/30' : 'text-gray-300',
  yearBorder: darkMode ? 'border-white/10' : 'border-gray-200',
  tagline: darkMode ? 'bg-[#1a1a1a]/80 border-white/10' : 'bg-white/80 border-gray-200',
  taglineText: darkMode ? 'text-white/60' : 'text-gray-600',
  taglineHighlight: darkMode ? 'text-white' : 'text-gray-900',
  filterBadge: darkMode ? 'bg-white/10 text-white/70' : 'bg-gray-100 text-gray-700',
  filterText: darkMode ? 'text-white/50' : 'text-gray-500',
  filterClear: darkMode ? 'text-white/40 hover:text-white/60' : 'text-gray-400 hover:text-gray-600',
  emptyText: darkMode ? 'text-white/50' : 'text-gray-500',
  overlay: darkMode ? 'bg-black/60' : 'bg-black/40',
});

/**
 * 获取照片墙页面（GalleryPage）的主题配置。
 * @param darkMode 是否启用暗黑模式
 */
export const getGalleryTheme = (darkMode: boolean) => ({
  page: darkMode ? 'bg-[#0a0a0a] text-white' : 'bg-[#f8f9fa] text-gray-900',
  header: darkMode ? 'bg-[#0a0a0a]/80 border-white/10' : 'bg-white/80 border-gray-200',
  backLink: darkMode ? 'text-white/70 hover:text-white' : 'text-gray-600 hover:text-gray-900',
  controlBg: darkMode ? 'bg-white/5' : 'bg-gray-100',
  controlBtn: (active: boolean) => active 
    ? (darkMode ? 'bg-white/20 text-white' : 'bg-gray-200 text-gray-900')
    : (darkMode ? 'text-white/50 hover:text-white' : 'text-gray-400 hover:text-gray-600'),
  stats: darkMode ? 'text-white/50' : 'text-gray-500',
  statsHighlight: darkMode ? 'text-white' : 'text-gray-900',
  spinner: darkMode ? 'border-white/20 border-t-white' : 'border-gray-200 border-t-gray-600',
  footer: darkMode ? 'border-white/10' : 'border-gray-200',
  footerText: darkMode ? 'text-white/40' : 'text-gray-500',
  kbd: darkMode ? 'bg-white/10' : 'bg-gray-200',
});

/**
 * 获取导航组件（Navigation）的主题配置。
 * @param darkMode 是否启用暗黑模式
 */
export const getNavTheme = (darkMode: boolean) => ({
  navItem: (active: boolean) => active
    ? (darkMode ? 'text-white bg-white/15' : 'text-gray-900 bg-gray-100')
    : (darkMode ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'),
  dropdown: darkMode ? 'bg-[#1a1a1a]/95 border-white/10' : 'bg-white/95 border-gray-200',
  dropdownItem: (active: boolean) => active
    ? (darkMode ? 'text-white bg-white/15' : 'text-gray-900 bg-gray-100')
    : (darkMode ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'),
  searchInput: darkMode ? 'bg-[#1a1a1a] border-white/10 text-white placeholder-white/40' : 'bg-white border-gray-200 text-gray-900 placeholder-gray-400',
  mobileSearchBg: darkMode ? 'bg-white/10' : 'bg-gray-100',
  borderColor: darkMode ? 'border-white/10' : 'border-gray-100',
  mutedText: darkMode ? 'text-white/50' : 'text-gray-500',
});
