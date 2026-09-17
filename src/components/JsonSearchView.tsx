import { json } from '@codemirror/lang-json';
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  openSearchPanel,
  replaceAll as replaceAllMatches,
  replaceNext,
  search,
  setSearchQuery
} from '@codemirror/search';
import { Prec } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, TextInput } from './ui';

/**
 * A pretty-printed JSON viewer with an in-buffer find/replace bar. Edits here
 * are local to the CodeMirror instance only — nothing is written back to the
 * collection, so it is safe to use for read-only result and document views.
 */
export function JsonSearchView({ value, minHeight = '200px' }: { value: string; minHeight?: string }) {
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [matches, setMatches] = useState({ current: 0, total: 0 });

  const dark = (document.documentElement.dataset.theme ?? 'dark') === 'dark';

  const buildQuery = useCallback(
    () => new SearchQuery({ search: findText, caseSensitive: matchCase, literal: true, replace: replaceText }),
    [findText, matchCase, replaceText]
  );

  const refreshMatches = useCallback((view: EditorView, query: SearchQuery) => {
    if (!query.search) {
      setMatches({ current: 0, total: 0 });
      return;
    }
    const cursor = query.getCursor(view.state);
    const sel = view.state.selection.main;
    let total = 0;
    let current = 0;
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      total += 1;
      if (next.value.from === sel.from && next.value.to === sel.to) current = total;
    }
    setMatches({ current, total });
  }, []);

  const dispatchQuery = useCallback(() => {
    const view = editorRef.current?.view;
    if (!view) return null;
    const query = buildQuery();
    view.dispatch({ effects: setSearchQuery.of(query) });
    return { view, query };
  }, [buildQuery]);

  // CodeMirror only decorates matches while its own search panel is open (its
  // "is a search active" flag), so we open it to get highlighting and hide it
  // with CSS in favour of this component's own bar, then steal focus back.
  useEffect(() => {
    const view = editorRef.current?.view;
    if (!view) return;
    if (open) {
      openSearchPanel(view);
      const frame = requestAnimationFrame(() => findInputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    closeSearchPanel(view);
  }, [open]);

  // Keeps every match highlighted as the search text or case toggle changes,
  // without moving the selection — only Enter/next/previous does that.
  useEffect(() => {
    const view = editorRef.current?.view;
    if (!view) return;
    const query = new SearchQuery({ search: findText, caseSensitive: matchCase, literal: true });
    view.dispatch({ effects: setSearchQuery.of(query) });
    refreshMatches(view, query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findText, matchCase]);

  const runFind = useCallback(
    (direction: 'next' | 'previous') => {
      if (!findText) return;
      const dispatched = dispatchQuery();
      if (!dispatched) return;
      (direction === 'next' ? findNext : findPrevious)(dispatched.view);
      refreshMatches(dispatched.view, dispatched.query);
    },
    [dispatchQuery, findText, refreshMatches]
  );

  const runReplace = useCallback(
    (all: boolean) => {
      if (!findText) return;
      const dispatched = dispatchQuery();
      if (!dispatched) return;
      (all ? replaceAllMatches : replaceNext)(dispatched.view);
      refreshMatches(dispatched.view, buildQuery());
    },
    [buildQuery, dispatchQuery, findText, refreshMatches]
  );

  const extensions = useMemo(
    () => [
      json(),
      search(),
      EditorView.lineWrapping,
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-f',
            run: () => {
              setOpen(true);
              return true;
            }
          }
        ])
      )
    ],
    []
  );

  const onFindKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runFind(event.shiftKey ? 'previous' : 'next');
    }
    if (event.key === 'Escape') setOpen(false);
  };

  return (
    <div className="json-search">
      <div className="find-bar-row">
        {open ? (
          <div className="find-bar">
            <input
              className="input"
              ref={findInputRef}
              autoFocus
              placeholder="Find"
              value={findText}
              onChange={(event) => setFindText(event.target.value)}
              onKeyDown={onFindKeyDown}
            />
            <span className="find-count">{findText ? `${matches.current}/${matches.total}` : ''}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => runFind('previous')}
              disabled={!findText}
              title="Previous match (Shift+Enter)"
            >
              ↑
            </Button>
            <Button size="sm" variant="ghost" onClick={() => runFind('next')} disabled={!findText} title="Next match (Enter)">
              ↓
            </Button>
            <button
              type="button"
              className={`btn btn-sm find-case ${matchCase ? 'is-active' : ''}`}
              onClick={() => setMatchCase((value) => !value)}
              title="Match case"
            >
              Aa
            </button>
            <TextInput
              placeholder="Replace"
              value={replaceText}
              onChange={(event) => setReplaceText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') runReplace(false);
              }}
            />
            <Button size="sm" onClick={() => runReplace(false)} disabled={!findText}>
              Replace
            </Button>
            <Button size="sm" onClick={() => runReplace(true)} disabled={!findText}>
              Replace all
            </Button>
            <button className="icon-button" onClick={() => setOpen(false)} aria-label="Close find bar">
              ×
            </button>
          </div>
        ) : (
          <button type="button" className="find-trigger" onClick={() => setOpen(true)} title="Find (⌘F)">
            🔍 Find
          </button>
        )}
      </div>
      <CodeMirror
        ref={editorRef}
        value={value}
        theme={dark ? oneDark : 'light'}
        extensions={extensions}
        minHeight={minHeight}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: false,
          autocompletion: false,
          bracketMatching: true,
          closeBrackets: false
        }}
      />
    </div>
  );
}
