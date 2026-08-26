interface TitlebarDragRegionProps {
  height?: 32 | 44;
}

export default function TitlebarDragRegion({ height = 44 }: TitlebarDragRegionProps) {
  // Callers provide a positioned parent so the strip cannot escape its titlebar surface.
  return (
    <div
      data-tauri-drag-region
      className={`absolute top-0 left-0 right-0 ${height === 32 ? "h-8" : "h-11"}`}
    />
  );
}
