/** The user's own box sizes, kept in this browser (localStorage). */

export interface SavedBox {
  id: string;
  name: string;
  box: [number, number, number]; // inside L, W, H in mm
}

const KEY = 'foam-slicer-boxes';

export function loadBoxes(): SavedBox[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as SavedBox[]) : [];
    return Array.isArray(list)
      ? list.filter(
          (b) => b && typeof b.name === 'string' && Array.isArray(b.box) && b.box.length === 3,
        )
      : [];
  } catch {
    return [];
  }
}

function store(list: SavedBox[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function saveBox(name: string, box: [number, number, number]): SavedBox {
  const list = loadBoxes();
  const existing = list.find((b) => b.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.box = box;
    store(list);
    return existing;
  }
  const b: SavedBox = { id: Math.random().toString(36).slice(2, 10), name, box };
  list.push(b);
  store(list);
  return b;
}

export function deleteBox(id: string): void {
  store(loadBoxes().filter((b) => b.id !== id));
}
