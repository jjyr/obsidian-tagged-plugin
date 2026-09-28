export const ASSET_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'svg',
  'bmp',
  'avif',
  'heic',
  'tif',
  'tiff',
]);

export function validateAssetsFolder(value: string): string | undefined {
  const parts = value.trim().split('/');
  if (
    parts.some((part) => !part || part === '.' || part === '..' || part !== part.trim()) ||
    /[\\:*?"<>|]/.test(value) ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    return 'Enter a vault-relative folder such as Assets or Resources/Images, not the root or an absolute path.';
}
