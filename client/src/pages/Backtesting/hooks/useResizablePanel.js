import { useCallback, useRef, useState } from 'react';

export default function useResizablePanel(initialHeight = 240, min = 150, max = 500) {
  const [height, setHeight] = useState(initialHeight);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const onPointerDown = useCallback(
    (e) => {
      e.preventDefault();
      dragging.current = true;
      startY.current = e.clientY;
      startH.current = height;
      e.target.setPointerCapture(e.pointerId);
    },
    [height],
  );

  const onPointerMove = useCallback(
    (e) => {
      if (!dragging.current) return;
      const delta = startY.current - e.clientY;
      setHeight(Math.min(max, Math.max(min, startH.current + delta)));
    },
    [min, max],
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const handleProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    style: { touchAction: 'none' },
  };

  return { height, handleProps };
}
