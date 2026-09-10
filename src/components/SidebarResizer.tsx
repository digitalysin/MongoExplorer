import { useEffect } from 'react';

const STORAGE_KEY = 'mongo-explorer:sidebar-width';
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 190;

/** Leaves room for the query editor no matter how wide the window is. */
const clamp = (width: number): number =>
  Math.min(Math.max(width, MIN_WIDTH), Math.max(MIN_WIDTH, window.innerWidth * 0.6));

const apply = (width: number): void =>
  document.documentElement.style.setProperty('--sidebar-width', `${Math.round(width)}px`);

const currentWidth = (): number =>
  document.querySelector('.sidebar')?.getBoundingClientRect().width ?? DEFAULT_WIDTH;

export function SidebarResizer() {
  useEffect(() => {
    const saved = Number(window.localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(saved) && saved > 0) apply(clamp(saved));

    // A window narrow enough to make the saved width absurd should not lose the main pane.
    const onResize = () => apply(clamp(currentWidth()));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = currentWidth();
    document.body.classList.add('is-resizing');

    const onMove = (move: PointerEvent) => apply(clamp(startWidth + move.clientX - startX));
    const onUp = () => {
      document.body.classList.remove('is-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.localStorage.setItem(STORAGE_KEY, String(Math.round(currentWidth())));
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const reset = () => {
    apply(DEFAULT_WIDTH);
    window.localStorage.removeItem(STORAGE_KEY);
  };

  return (
    <div
      className="sidebar-resizer"
      onPointerDown={startDrag}
      onDoubleClick={reset}
      title="Drag to resize · double-click to reset"
      role="separator"
      aria-orientation="vertical"
    />
  );
}
