import { useRef, useEffect } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { closeBrackets } from '@codemirror/autocomplete';
import styles from './CodeEditor.module.css';

const baseTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--bg-input)',
    fontSize: '0.82rem',
  },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    padding: '10px 0',
    minHeight: '200px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-primary)',
    borderRight: '1px solid var(--border)',
    color: 'var(--text-hint)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--text-secondary)',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: 'var(--indigo)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(99, 102, 241, 0.2) !important',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
});

export function CodeEditor({ value, onChange, minHeight = '200px' }) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Track whether the last change was internal (from editor) to avoid loops
  const internalUpdate = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const heightTheme = EditorView.theme({
      '.cm-content': { minHeight },
      '.cm-scroller': { minHeight },
    });

    const state = EditorState.create({
      doc: value || '',
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        bracketMatching(),
        closeBrackets(),
        javascript(),
        oneDark,
        baseTheme,
        heightTheme,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([indentWithTab, ...defaultKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            internalUpdate.current = true;
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes (e.g. template selection)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (internalUpdate.current) {
      internalUpdate.current = false;
      return;
    }
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value || '' },
      });
    }
  }, [value]);

  return <div ref={containerRef} className={styles.wrapper} />;
}
