// Lazy HTMLImageElement loader keyed by URL. Multiple components that need the
// same spritesheet share one in-flight Promise + one decoded image. The render
// loop polls `getSprite(url)` each frame; until decoded it returns null and
// the renderer skips that pet.

const cache = new Map<string, HTMLImageElement>();
const inflight = new Map<string, Promise<HTMLImageElement>>();

export function loadSprite(url: string): Promise<HTMLImageElement> {
  const existing = inflight.get(url);
  if (existing) return existing;
  if (cache.has(url)) return Promise.resolve(cache.get(url)!);
  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      cache.set(url, img);
      inflight.delete(url);
      resolve(img);
    };
    img.onerror = (e) => {
      inflight.delete(url);
      reject(e);
    };
    img.src = url;
  });
  inflight.set(url, p);
  return p;
}

export function getSprite(url: string): HTMLImageElement | null {
  return cache.get(url) ?? null;
}
