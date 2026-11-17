// 一笔一笔 StepDraw - 小程序平台适配层
// 预留接口，待小程序版开发时实现

import type { Drawing } from '../../types';

/**
 * 存储管理 - 小程序版使用 wx.setStorage / wx.getStorage
 */
export const storage = {
  getFavorites(): Promise<string[]> {
    return new Promise((resolve) => {
      // TODO: 小程序实现
      // wx.getStorage({ key: 'stepdraw_favorites', success: res => resolve(res.data || []) })
      resolve([]);
    });
  },

  setFavorites(_ids: string[]): Promise<void> {
    return new Promise((resolve) => {
      // TODO: 小程序实现
      // wx.setStorage({ key: 'stepdraw_favorites', data: ids, success: () => resolve() })
      resolve();
    });
  },

  isFavorite(id: string): Promise<boolean> {
    return this.getFavorites().then(favorites => favorites.includes(id));
  },

  toggleFavorite(id: string): Promise<boolean> {
    return this.getFavorites().then(favorites => {
      const index = favorites.indexOf(id);
      if (index > -1) {
        favorites.splice(index, 1);
        this.setFavorites(favorites);
        return false;
      } else {
        favorites.push(id);
        this.setFavorites(favorites);
        return true;
      }
    });
  },

  getSettings(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      // TODO: 小程序实现
      resolve({});
    });
  },

  setSettings(_settings: Record<string, unknown>): Promise<void> {
    return new Promise((resolve) => {
      // TODO: 小程序实现
      resolve();
    });
  }
};

/**
 * 分享功能 - 小程序版使用 wx.shareAppMessage
 */
export const share = {
  shareDrawing(_drawing: Drawing): Promise<boolean> {
    return new Promise((resolve) => {
      // TODO: 小程序实现
      // 需要在 Page 的 onShareAppMessage 中处理
      resolve(false);
    });
  }
};

/**
 * 图片导出
 */
export const exportImage = {
  canvasToImage(_canvasId: string): Promise<string> {
    return new Promise((resolve) => {
      // TODO: 小程序实现
      // wx.canvasToTempFilePath({ canvasId, success: res => resolve(res.tempFilePath) })
      resolve('');
    });
  },

  downloadDrawing(_drawing: Drawing, _canvas: HTMLCanvasElement): Promise<void> {
    return this.canvasToImage('canvas').then((_tempFilePath) => {
      // TODO: 小程序实现
      // wx.saveImageToPhotosAlbum({ filePath: tempFilePath })
    });
  }
};

/**
 * 导航
 */
export const navigation = {
  navigateTo(_url: string): Promise<void> {
    return new Promise((resolve) => {
      // TODO: 小程序实现
      // wx.navigateTo({ url })
      resolve();
    });
  },

  redirectTo(_url: string): Promise<void> {
    return new Promise((resolve) => {
      // TODO: 小程序实现
      // wx.redirectTo({ url })
      resolve();
    });
  },

  switchTab(_url: string): Promise<void> {
    return new Promise((resolve) => {
      // TODO: 小程序实现
      // wx.switchTab({ url })
      resolve();
    });
  }
};
