/**
 * 最小化微信 API 类型声明。
 *
 * 为什么不用 miniprogram-api-typings：避免引入外部依赖（离线环境装不上）。
 * 若后续 npm 可用，删掉本文件并安装官方 typings 即可，代码无需改动。
 */

declare const wx: any;
declare const console: any;
declare function App(options: any): void;
declare function Page(options: any): void;
declare function Component(options: any): void;
declare function Behavior(options: any): any;
declare function getApp(): any;
declare function getCurrentPages(): any[];
declare function setTimeout(handler: () => void, timeout?: number): number;
declare function clearTimeout(id: number): void;
declare function setInterval(handler: () => void, timeout?: number): number;
declare function clearInterval(id: number): void;
