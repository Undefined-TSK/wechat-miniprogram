/** 通用格式化工具 */

export function formatMs(ms: number): string {
  if (!ms || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m + ':' + (s < 10 ? '0' + s : String(s));
}

export function formatPercent(rate: number): string {
  return Math.round(rate * 100) + '%';
}

export function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

export function formatDurationCn(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return totalSec + ' 秒';
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? m + ' 分' : m + ' 分 ' + s + ' 秒';
}

export const STAR_TEXT = ['未通过', '一星', '二星', '三星'];
