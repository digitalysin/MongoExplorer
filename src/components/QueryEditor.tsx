import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import CodeMirror from '@uiw/react-codemirror';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { useMemo } from 'react';

export function QueryEditor({
  value,
  onChange,
  onRun,
  height,
  dark
}: {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  height: number;
  dark: boolean;
}) {
  // Cmd/Ctrl+Enter runs the query; Prec.highest keeps it ahead of the default
  // newline binding.
  const extensions = useMemo(
    () => [
      javascript(),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              onRun();
              return true;
            }
          }
        ])
      )
    ],
    [onRun]
  );

  return (
    <div className="editor-pane" style={{ height }}>
      <CodeMirror
        value={value}
        height={`${height}px`}
        theme={dark ? oneDark : 'light'}
        extensions={extensions}
        onChange={onChange}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: true,
          autocompletion: true,
          bracketMatching: true,
          closeBrackets: true
        }}
      />
    </div>
  );
}
