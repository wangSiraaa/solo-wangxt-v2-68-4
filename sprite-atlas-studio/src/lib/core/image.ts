import type { Pixels, TrimRect } from "./types";

/** 浏览器端图像工具：全部在本地完成，图片不离开浏览器 */

export function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片解码失败"));
    };
    img.src = url;
  });
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 上下文");
  return ctx;
}

/** 把图片绘制到画布并读取像素 */
export function imageToPixels(img: CanvasImageSource, w: number, h: number): Pixels {
  const canvas = makeCanvas(w, h);
  const ctx = ctx2d(canvas);
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: data.data, width: data.width, height: data.height };
}

/** 从源图裁出一块区域，返回新画布 */
export function cropToCanvas(
  img: CanvasImageSource,
  srcW: number,
  srcH: number,
  rect: TrimRect
): HTMLCanvasElement {
  const canvas = makeCanvas(rect.w, rect.h);
  const ctx = ctx2d(canvas);
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  void srcW;
  void srcH;
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("导出 PNG 失败"))), "image/png");
  });
}

export function canvasToDataURL(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png");
}

export async function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error("读取文件失败"));
    r.readAsDataURL(blob);
  });
}

export function dataURLToBlob(dataURL: string): Blob {
  const [head, body] = dataURL.split(",");
  if (!head || !body) throw new Error("非法的 dataURL");
  const mime = /data:(.*?)(;|$)/.exec(head)?.[1] ?? "image/png";
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

let seq = 0;
export function uid(): string {
  return `f${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
