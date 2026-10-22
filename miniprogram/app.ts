/**
 * 小程序入口
 *
 * 启动顺序：注册引擎（判分器 + 渲染器）→ 同步主题 → 监听系统主题变化。
 */

import { bootstrapEngine, rendererSizeReport } from './engine/bootstrap';
import { store } from './store/index';

const DARK_BG = '#121212';
const LIGHT_BG = '#f7f8fa';

const appConfig = {
  globalData: {
    theme: 'light' as 'light' | 'dark',
  },

  onLaunch() {
    // 1. 注册题型引擎。放在这里而不是各页面，保证任何入口都能拿到完整注册表
    bootstrapEngine();

    // 2. 体积看板：超过 300KB 未分包的渲染器必须处理
    const report = rendererSizeReport();
    if (report.oversize.length > 0) {
      console.warn(
        '[engine] 以下渲染器超过 300KB 且未指定分包，必须走分包异步化：',
        report.oversize
      );
    }

    // 3. 主题
    //    先恢复用户手动选的偏好（存在本机的），再跟随系统。
    //    ⚠️ 顺序不能反：若先跟随系统并写进 store，用户的手动选择会被系统值盖掉，
    //       表现就是「我在设置里选了深色，重进小程序又变回浅色」。
    store.restoreTheme();
    appConfig.applyThemeBg();
    if (wx.onThemeChange) {
      wx.onThemeChange(function () {
        // 系统主题变化只在用户**没有手动选过**时才生效
        appConfig.syncTheme();
      });
    }
  },

  /**
   * 跟随系统深浅色。
   *
   * 说明：page 元素本身无法挂 class，所以系统主题变化时通过 setBackgroundColor
   * 同步页面主体背景；内容区由各页面根 view 上的 .theme-* 类负责。
   *
   * ⚠️ 用户手动选过主题后，**不再跟随系统**（否则用户的显式选择就没有意义了）。
   *    这里用「本机是否有偏好记录」来判断，而不是加一个内存标志——
   *    内存标志在「用户选完深色 → 杀进程 → 重开」之后就失效了。
   */
  syncTheme() {
    if (appConfig.hasUserTheme()) return;
    const info = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync();
    const theme: 'light' | 'dark' = info && info.theme === 'dark' ? 'dark' : 'light';
    appConfig.globalData.theme = theme;
    store.set({ theme: theme });
    appConfig.applyThemeBg();
  },

  /** 本机是否存有用户手动选择的主题 */
  hasUserTheme(): boolean {
    try {
      const v = wx.getStorageSync('xxgk:theme:v1');
      return v === 'dark' || v === 'light';
    } catch (e) {
      return false;
    }
  },

  /** 按当前主题同步页面主体背景色（内容区由 .theme-* 类负责） */
  applyThemeBg() {
    if (!wx.setBackgroundColor) return;
    const bg = store.state.theme === 'dark' ? DARK_BG : LIGHT_BG;
    wx.setBackgroundColor({
      backgroundColor: bg,
      backgroundColorTop: bg,
      backgroundColorBottom: bg,
    });
  },
};

App(appConfig);
