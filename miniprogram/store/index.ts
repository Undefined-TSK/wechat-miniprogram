/**
 * 轻量状态管理：发布订阅，不引入任何第三方库。
 * 只放跨页面共享的少量状态（主题、用户信息），业务数据一律走 services + 页面 data。
 */

export interface StoreState {
  theme: 'light' | 'dark';
  [k: string]: unknown;
}

export type StoreListener = (state: StoreState) => void;

/** 主题偏好的存储键。单独一个键，**不要和进度快照混在一起**——
 *  重置进度不应该顺手把用户的深色模式设置也清掉 */
const THEME_KEY = 'xxgk:theme:v1';

class MiniStore {
  state: StoreState = { theme: 'light' };
  listeners: StoreListener[] = [];

  get(key: string): unknown {
    return this.state[key];
  }

  set(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch };
    for (let i = 0; i < this.listeners.length; i++) {
      try {
        this.listeners[i](this.state);
      } catch (e) {
        console.error('[store] 监听器执行异常', e);
      }
    }
  }

  /** 切换主题并落盘。读失败按浅色处理（宁可回到默认，也不要卡在未知状态） */
  setTheme(theme: 'light' | 'dark'): void {
    this.set({ theme: theme });
    try {
      wx.setStorageSync(THEME_KEY, theme);
    } catch (e) {
      // 主题存不上不是致命问题：本次会话仍然生效，只是下次打开回到默认
      console.warn('[store] 主题偏好保存失败', e);
    }
  }

  /** 启动时恢复主题偏好（app.ts onLaunch 调用） */
  restoreTheme(): void {
    try {
      const v = wx.getStorageSync(THEME_KEY);
      if (v === 'dark' || v === 'light') this.set({ theme: v });
    } catch (e) {
      console.warn('[store] 主题偏好读取失败', e);
    }
  }

  /** 返回取消订阅函数 */
  subscribe(fn: StoreListener): () => void {
    this.listeners.push(fn);
    const self = this;
    let active = true;
    return function unsubscribe() {
      if (!active) return;
      active = false;
      const idx = self.listeners.indexOf(fn);
      if (idx >= 0) self.listeners.splice(idx, 1);
    };
  }
}

export const store = new MiniStore();
