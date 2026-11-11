/** Réduit une photo côté client (≤ 2000 px, JPEG) avant l'envoi : plus rapide sur réseau cellulaire et convertit le HEIC. */
export async function prepareImage(file: File): Promise<Blob> {
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const max = 2000;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && file.type === 'image/jpeg' && file.size < 3_000_000) {
      URL.revokeObjectURL(url);
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    return blob || file;
  } catch {
    return file;
  }
}

export async function imageForm(file: File): Promise<FormData> {
  const blob = await prepareImage(file);
  const fd = new FormData();
  fd.append('file', blob, blob === file ? file.name : 'image.jpg');
  return fd;
}
