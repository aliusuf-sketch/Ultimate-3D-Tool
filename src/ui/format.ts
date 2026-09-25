export const mm = (n: number, digits = 1): string => {
  const f = 10 ** digits;
  return String(Math.round(n * f) / f);
};

export function download(data: BlobPart, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function debounce<A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number,
): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
