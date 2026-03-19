# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e4]: "[plugin:vite:import-analysis] Failed to resolve import \"@codemirror/state\" from \"src/components/shared/CodeEditor.jsx\". Does the file exist?"
  - generic [ref=e5]: /app/src/components/shared/CodeEditor.jsx:2:28
  - generic [ref=e6]: "17 | var _s = $RefreshSig$(); 18 | import { useRef, useEffect } from \"react\"; 19 | import { EditorState } from \"@codemirror/state\"; | ^ 20 | import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from \"@codemirror/view\"; 21 | import { javascript } from \"@codemirror/lang-javascript\";"
  - generic [ref=e7]: at TransformPluginContext._formatLog (file:///app/node_modules/vite/dist/node/chunks/config.js:28999:43) at TransformPluginContext.error (file:///app/node_modules/vite/dist/node/chunks/config.js:28996:14) at normalizeUrl (file:///app/node_modules/vite/dist/node/chunks/config.js:27119:18) at process.processTicksAndRejections (node:internal/process/task_queues:103:5) at async file:///app/node_modules/vite/dist/node/chunks/config.js:27177:32 at async Promise.all (index 4) at async TransformPluginContext.transform (file:///app/node_modules/vite/dist/node/chunks/config.js:27145:4) at async EnvironmentPluginContainer.transform (file:///app/node_modules/vite/dist/node/chunks/config.js:28797:14) at async loadAndTransform (file:///app/node_modules/vite/dist/node/chunks/config.js:22670:26) at async viteTransformMiddleware (file:///app/node_modules/vite/dist/node/chunks/config.js:24542:20)
  - generic [ref=e8]:
    - text: Click outside, press Esc key, or fix the code to dismiss.
    - text: You can also disable this overlay by setting
    - code [ref=e9]: server.hmr.overlay
    - text: to
    - code [ref=e10]: "false"
    - text: in
    - code [ref=e11]: vite.config.js
    - text: .
```