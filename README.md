# U·B·SYSTEM

Modular urban block generation system on MapLibre GL JS.

## Architecture

Zero-build, pure ES Modules. No bundler, no TypeScript — just open `index.html`.

```
ub-system/
├── index.html              ← entry point
├── app.js                  ← bootstrap
├── core/
│   ├── EventBus.js         ← pub/sub
│   ├── Config.js           ← constants
│   └── commands/           ← undo/redo
├── map/
│   └── MapManager.js       ← MapLibre 3D map
├── data/
│   └── FeatureStore.js     ← GeoJSON feature CRUD
├── draw/
│   ├── DrawManager.js      ← tool coordinator
│   ├── tools/              ← Select, Polygon, Line
│   └── layers/             ← Features, Preview
├── ui/
│   ├── Toolbar.js          ← left sidebar
│   ├── StatusBar.js        ← bottom bar
│   └── FeaturePanel.js     ← right panel
├── modules/                ← future: urban block, sections, heights...
└── styles/
    └── main.css
```

## Usage

```bash
# Local development — any static server
npx serve .
# or
python -m http.server 8000
```

Open `http://localhost:8000` (or `:3000` for serve).

## Controls

| Key | Action |
|-----|--------|
| V | Select tool |
| P | Polygon tool |
| L | Line tool |
| Escape | Cancel / back to Select |
| Backspace | Remove last point (while drawing) |
| Delete | Remove selected feature |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |

## Module System

Each module in `modules/` exports:

```js
export default {
  id: 'my-module',
  init(ctx) { /* ctx.map, ctx.eventBus, ctx.featureStore */ },
  destroy() { /* cleanup */ }
};
```

## License

Private — The Invaders R&D
