// 一笔一笔 StepDraw - Web 平台适配层
// 为后续小程序版预留接口，统一平台差异

import type { Drawing } from '../../types';

/**
 * 存储管理 - Web 版使用 localStorage
 */
export const storage = {
  getFavorites(): string[] {
    try {
      const data = localStorage.getItem('stepdraw_favorites');
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  setFavorites(ids: string[]): void {
    try {
      localStorage.setItem('stepdraw_favorites', JSON.stringify(ids));
    } catch {
      console.error('Failed to save favorites');
    }
  },

  isFavorite(id: string): boolean {
    return this.getFavorites().includes(id);
  },

  toggleFavorite(id: string): boolean {
    const favorites = this.getFavorites();
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
  },

  getSettings(): Record<string, unknown> {
    try {
      const data = localStorage.getItem('stepdraw_settings');
      return data ? JSON.parse(data) : {};
    } catch {
      return {};
    }
  },

  setSettings(settings: Record<string, unknown>): void {
    try {
      localStorage.setItem('stepdraw_settings', JSON.stringify(settings));
    } catch {
      console.error('Failed to save settings');
    }
  }
};

/**
 * 分享功能 - Web 版使用 Web Share API
 */
export const share = {
  async shareDrawing(drawing: Drawing): Promise<boolean> {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `一笔一笔 - ${drawing.name}`,
          text: `来看看这个 ${drawing.name} 的画法！`,
          url: window.location.href
        });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  },

  copyLink(drawing: Drawing): boolean {
    const url = `${window.location.origin}?drawing=${drawing.id}`;
    navigator.clipboard?.writeText(url).then(() => {
      return true;
    }).catch(() => {
      return false;
    });
    return false;
  }
};

/**
 * 图片导出
 */
export const exportImage = {
  canvasToImage(canvas: HTMLCanvasElement): string {
    return canvas.toDataURL('image/png');
  },

  downloadDrawing(drawing: Drawing, canvas: HTMLCanvasElement): void {
    const link = document.createElement('a');
    link.download = `${drawing.name}.png`;
    link.href = this.canvasToImage(canvas);
    link.click();
  }
};
